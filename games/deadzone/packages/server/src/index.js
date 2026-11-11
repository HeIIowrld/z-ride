// Modified for Z-RIDE room creation and dashboard adapter.
/*
 * Copyright 2026 Mohammad Mahdi Mortazavi
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* =============================== ROUTER =================================

   The Worker is deliberately thin. It owns nothing: every piece of mutable
   state lives in a Durable Object, so two requests that land in Frankfurt and
   Singapore still agree about who is in room 7KQ2MX.

   Responsibilities, in full:
     • room codes and the small JSON API around them
     • proxying the leaderboard so the anon key never ships to a phone
     • gatekeeping /api/match-result, which is the only write path into
       Supabase and therefore the only thing worth forging
     • upgrading /ws and handing the socket to the right MatchRoom            */

import { partySize } from '../../shared/src/zride.js';
import { renderLanding } from '../../landing/src/worker.js';
import { MatchRoom } from './MatchRoom.js';
import { Matchmaker } from './Matchmaker.js';
import { MODES } from '../../shared/src/modes.js';
import { MODE_IDS } from '../../shared/src/constants.js';

export { MatchRoom, Matchmaker };

/* Crockford-ish: no O, no 0, no I, no 1. A code gets read aloud over a voice
   call more often than it gets copy-pasted, and "was that an I or a 1" is the
   single most common way a private room fails to fill. Exactly 32 symbols, so
   one random byte masked to 5 bits picks one with no modulo bias. */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LEN = 6;

export function makeCode(len = CODE_LEN) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

/** Codes arrive from humans, so accept lowercase and stray whitespace. */
function normaliseCode(raw) {
  if (!raw) return null;
  const c = String(raw).trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (c.length !== CODE_LEN) return null;
  for (const ch of c) if (ALPHABET.indexOf(ch) < 0) return null;
  return c;
}

/* The Matchmaker retries against its own table if a candidate is taken, so
   handing it a short list makes room creation a single round trip instead of
   a retry loop across the network. */
function codeCandidates(n = 8) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(makeCode());
  return out;
}

/* ------------------------------------------------------------------ CORS */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,x-overrun-secret',
  'access-control-max-age': '86400'
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra }
  });
}

/* -------------------------------------------------------------- DOWNLOAD */

/* Where /download points.

   `releases/latest/download/<name>` would be simpler, but it is wrong twice
   over here: it ignores pre-releases, and it needs the asset file name to be
   fixed forever, whereas CI stamps the version and the signing mode into it
   (overrun-1.0.1-testkey.apk). So the newest release that actually carries an
   APK is resolved from the API instead.

   What is cached is the API RESPONSE, not the URL derived from it. Caching the
   derived URL is the tempting version and it is wrong: assets can be replaced
   or a release re-cut, and a cached URL then points at something that has
   stopped existing until the entry expires. Caching the response means a stale
   read is at worst a few minutes out of date and self-heals; it also keeps the
   unauthenticated GitHub rate limit — which is per IP, and a Worker has very
   few of those — comfortably out of reach. Any failure falls back to the
   tagless path. */

const GH_RELEASES = 'https://api.github.com/repos/Mahdi-mortazavi/overrun/releases?per_page=15';
const APK_FALLBACK = 'https://github.com/Mahdi-mortazavi/overrun/releases/latest/download/overrun.apk';

async function latestApkUrl() {
  try {
    const res = await fetch(GH_RELEASES, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'overrun-worker' },
      cf: { cacheTtl: 600, cacheEverything: true }
    });
    if (!res.ok) return APK_FALLBACK;
    const releases = await res.json();
    for (const rel of releases) {
      if (rel.draft) continue;
      const apk = (rel.assets || []).find(a => a.name.endsWith('.apk'));
      if (apk) return apk.browser_download_url;
    }
  } catch (e) {
    console.warn('[download] could not resolve the latest APK', e);
  }
  return APK_FALLBACK;
}

/* ------------------------------------------------------------------ MAIN */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/dashboard' || path === '/dashboard/') return env.ASSETS.fetch(new Request(new URL('/dashboard.html', url), request));

    if (path === '/ws') return handleSocket(request, env, url);

    // The marketing page. Served by the same Worker as the game so there is
    // one deploy, one domain and no CORS between them.
    if (path === '/landing' || path === '/about') return renderLanding(request);

    // The APK does not live on this Worker — CI publishes it to GitHub
    // Releases, which already has the bandwidth and the version history. A
    // stable redirect here means the landing page never has to know the tag.
    if (path === '/download/overrun.apk' || path === '/download') {
      return Response.redirect(await latestApkUrl(), 302);
    }

    // Invite links. /j/ABC123 is a deep link into a room; the client reads the
    // code off the path, so all this has to do is serve the game shell.
    if (path.startsWith('/j/')) {
      return env.ASSETS.fetch(new Request(new URL('/', url), request));
    }

    if (path.startsWith('/api/')) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      try {
        return await api(request, env, url, path);
      } catch (err) {
        // An API fault must never take the game client down with it: the
        // client treats any non-2xx as "offline features unavailable".
        return json({ error: 'internal', detail: String((err && err.message) || err) }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};

async function api(request, env, url, path) {
  const mm = matchmaker(env);

  if (path === '/api/health' && request.method === 'GET') {
    return json({ ok: true, service: 'overrun', modes: MODE_IDS, now: Date.now() });
  }

  if (path === '/api/zride/rooms' && request.method === 'POST') {
    const body = await readJson(request);
    let players;
    try { players = partySize(body.players); } catch { return json({error:'invalid_players'},400); }
    const room = await mm.createRoom('coop', false, cleanName(body.hostName), codeCandidates());
    if (!room) return json({error:'no_code'},503);
    const dashboardToken = crypto.randomUUID();
    const stub = env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(room.code));
    const configured = await stub.fetch(new Request('https://internal/internal/zride/configure', {
      method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({code:room.code,players,dashboardToken,sharedVehicle:body.sharedVehicle===true,partySeats:body.partySeats})
    }));
    if (!configured.ok) return json({error:'configuration_failed'},500);
    return json({code:room.code,mode:'coop',players,
      partySeatsRequired: Array.isArray(body.partySeats), joinPath:'/j/'+room.code, dashboardPath:'/dashboard#'+room.code+'.'+dashboardToken,
      dashboardToken},201,{'cache-control':'no-store'});
  }
    const repair = path.match(/^\/api\/zride\/rooms\/([A-Z2-9]{6})\/repair$/);
    if (repair && request.method === 'POST') {
      const stub = env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(repair[1]));
      return stub.fetch(new Request('https://internal/internal/zride/repair', {
        method: 'POST', headers: { 'x-dashboard-token': request.headers.get('x-dashboard-token') || '' },
        body: await request.text()
      }));
    }
  const statusMatch = path.match(/^\/api\/zride\/rooms\/([A-Z2-9]{6})\/status$/);
  if (statusMatch && request.method === 'GET') {
    const stub = env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(statusMatch[1]));
    return stub.fetch(new Request('https://internal/internal/zride/status', {
      headers:{'x-dashboard-token':request.headers.get('x-dashboard-token') || ''}
    }));
  }

  /* ---- create a private room --------------------------------------- */
  if (path === '/api/rooms' && request.method === 'POST') {
    const body = await readJson(request);
    const mode = pickMode(body.mode);
    const hostName = cleanName(body.hostName);
    const room = await mm.createRoom(mode, false, hostName, codeCandidates());
    if (!room) return json({ error: 'no_code' }, 503);
    return json({ code: room.code, mode: room.mode, maxPlayers: room.maxPlayers });
  }

  /* ---- room info ---------------------------------------------------- */
  if (path.startsWith('/api/rooms/') && request.method === 'GET') {
    const code = normaliseCode(path.slice('/api/rooms/'.length));
    if (!code) return json({ error: 'bad_code' }, 400);
    // Answered from the Matchmaker's table rather than by waking the room:
    // a lobby-browser refresh should never cost a MatchRoom instantiation.
    const room = await mm.findRoom(code);
    if (!room) return json({ exists: false, error: 'not_found' }, 404);
    return json({
      exists: true,
      code: room.code,
      mode: room.mode,
      playerCount: room.players,
      maxPlayers: room.maxPlayers,
      state: room.state,
      joinable: room.state === 'lobby' && room.players < room.maxPlayers
    });
  }

  /* ---- quickplay ---------------------------------------------------- */
  if (path === '/api/quickplay' && request.method === 'POST') {
    const body = await readJson(request);
    const mode = pickMode(body.mode);
    const room = await mm.quickplay(mode, codeCandidates(), cleanName(body.name));
    if (!room) return json({ error: 'no_code' }, 503);
    return json({ code: room.code, mode: room.mode, created: !!room.created });
  }

  /* ---- leaderboard (read-only proxy) -------------------------------- */
  if (path === '/api/leaderboard' && request.method === 'GET') {
    // The schema exposes two pre-aggregated views, not a per-mode table, so
    // the only knob here is the time window.
    const window = url.searchParams.get('window') === 'weekly' ? 'weekly' : 'alltime';
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '25', 10) || 25));
    const entries = await leaderboard(env, window, limit);
    // Cached at the edge: the leaderboard is the one thing every player loads
    // on the menu screen, and a minute of staleness is invisible.
    return json({ window, entries }, 200, { 'cache-control': 'public, max-age=60' });
  }

  /* ---- match result (internal only) --------------------------------- */
  if (path === '/api/match-result' && request.method === 'POST') {
    if (!env.INTERNAL_SECRET) return json({ error: 'not_configured' }, 503);
    if (!secretMatches(request.headers.get('x-overrun-secret'), env.INTERNAL_SECRET)) {
      // Deliberately uninformative. A forger learns nothing from a 403.
      return json({ error: 'forbidden' }, 403);
    }
    const body = await readJson(request);
    const ok = await forwardResult(env, body);
    return json({ ok });
  }

  return json({ error: 'not_found' }, 404);
}

/* ------------------------------------------------------------- WEBSOCKET */

async function handleSocket(request, env, url) {
  const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
  if (upgrade !== 'websocket') return new Response('expected websocket upgrade', { status: 426 });

  const code = normaliseCode(url.searchParams.get('code'));
  if (!code) return new Response('bad room code', { status: 400 });

  // The mode is resolved here, from the Matchmaker's table, and passed to the
  // room as a header. If the client were allowed to name the mode it could
  // join a co-op lobby as a squad player and desync everyone in it.
  const room = await matchmaker(env).findRoom(code);
  if (!room) return new Response('no such room', { status: 404 });

  const headers = new Headers(request.headers);
  headers.set('x-overrun-code', code);
  headers.set('x-overrun-mode', room.mode);

  const stub = env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(code));
  return stub.fetch(new Request(request.url, { method: request.method, headers }));
}

/* --------------------------------------------------------------- HELPERS */

function matchmaker(env) {
  // One global directory instance. Codes are globally unique or they are not
  // codes, and that uniqueness has to be decided in exactly one place.
  return env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));
}

async function readJson(request) {
  try {
    const v = await request.json();
    return (v && typeof v === 'object') ? v : {};
  } catch { return {}; }
}

function pickMode(raw) {
  const m = String(raw || '').toLowerCase();
  return MODES[m] ? m : 'coop';
}

/** Control characters out, 18 visible characters max. The name ends up in a
 *  kill feed rendered at 14px; anything longer is a griefing tool. */
function cleanName(raw) {
  let out = '';
  for (const ch of String(raw || '')) {
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c !== 0x7f) out += ch;
    if (out.length >= 18) break;
  }
  return out.trim() || 'RUNNER';
}

/** Length-independent compare. Overkill for a header nobody can measure across
 *  the internet, but it costs four lines. */
function secretMatches(given, expected) {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function leaderboard(env, window, limit) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return [];
  // game.leaderboard_alltime / game.leaderboard_weekly: security-invoker views
  // over a SECURITY DEFINER aggregate, so `anon` can read standings without
  // being able to read a single row of profiles or match_players.
  const q = new URL(env.SUPABASE_URL + '/rest/v1/leaderboard_' + window);
  q.searchParams.set('select', 'rank,handle,total_kills,total_score,matches,wins,best_wave,kd');
  q.searchParams.set('order', 'rank.asc');
  q.searchParams.set('limit', String(limit));
  try {
    const res = await fetch(q.toString(), {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        authorization: 'Bearer ' + env.SUPABASE_ANON_KEY,
        // Tables live in the `game` schema, not `public`.
        'accept-profile': env.SUPABASE_SCHEMA || 'game'
      }
    });
    if (!res.ok) return [];
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  } catch {
    // A leaderboard nobody can reach is a cosmetic problem. It must never be
    // the reason a player cannot get into a match.
    return [];
  }
}

/* The `submit-match` Edge Function authenticates on a `secret` field in the
   body, not a header, and it is the only write path into game.matches — the
   tables have no INSERT policy for anyone else. MATCH_SECRET is injected here
   so it lives in exactly one place and never crosses the DO hop. */
async function forwardResult(env, body) {
  if (!env.SUPABASE_URL || !env.MATCH_SECRET) return false;
  const key = env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
  try {
    const res = await fetch(env.SUPABASE_URL + '/functions/v1/submit-match', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { apikey: key, authorization: 'Bearer ' + key } : {})
      },
      body: JSON.stringify({ ...body, secret: env.MATCH_SECRET })
    });
    return res.ok;
  } catch {
    return false;
  }
}
