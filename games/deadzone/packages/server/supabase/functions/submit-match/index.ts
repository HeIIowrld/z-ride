// OVERRUN — submit-match
//
// The authoritative game server POSTs finished match results here. Players
// never write their own results: `game.matches` and `game.match_players` have
// no INSERT policy and no write grant for `authenticated`, so the only path in
// is this function running with the service role, behind a shared secret.
//
// Deployed with verify_jwt = false on purpose: the caller is a trusted game
// server holding MATCH_SECRET, not a logged-in browser session.
//
//   POST /functions/v1/submit-match
//   { "secret": "...", "match": { ... }, "players": [ { ... } ] }
//   -> 200 { ok: true, matchId, xp: { "<profileId>": 417 } }
//
// Required env: MATCH_SECRET  (supabase secrets set MATCH_SECRET=...)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ---------------------------------------------------------------- XP rules
const XP_PER_KILL = 12;
const XP_PER_MATCH = 45;
const XP_PER_WIN = 320;
const XP_PER_WAVE = 60;

const MODES = ["coop", "tdm", "squad"] as const;
const MAX_PLAYERS = 64;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/**
 * PostgREST rejects any request against a schema that is not in the project's
 * "Exposed schemas" list (Settings -> API). Surface that as a distinct,
 * actionable status instead of a generic 500 — it is a one-click dashboard fix.
 */
function schemaNotExposed(): Response {
  console.error(
    'submit-match: the "game" schema is not exposed to the API. ' +
      'Add it in Dashboard -> Settings -> API -> Exposed schemas.',
  );
  return json(503, { ok: false, error: "game_schema_not_exposed" });
}

/** Thrown for anything the caller can fix; always surfaces as a 4xx. */
class BadRequest extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Constant-time string comparison. Both sides are hashed first so the compare
 * loop always runs over 32 equal-length bytes — this leaks neither the length
 * nor the position of the first differing character.
 */
async function secretsMatch(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

// ------------------------------------------------------------- validation
function asInt(value: unknown, field: string, min = 0, max = 100_000_000): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new BadRequest(`${field} must be an integer`);
  }
  if (value < min || value > max) {
    throw new BadRequest(`${field} must be between ${min} and ${max}`);
  }
  return value;
}

function asOptionalInt(value: unknown, field: string, min: number, max: number): number | null {
  if (value === undefined || value === null) return null;
  return asInt(value, field, min, max);
}

function asString(value: unknown, field: string, maxLen: number): string {
  if (typeof value !== "string") throw new BadRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new BadRequest(`${field} must not be empty`);
  if (trimmed.length > maxLen) throw new BadRequest(`${field} must be <= ${maxLen} characters`);
  return trimmed;
}

function asOptionalString(value: unknown, field: string, maxLen: number): string | null {
  if (value === undefined || value === null) return null;
  return asString(value, field, maxLen);
}

function asOptionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new BadRequest(`${field} must be a uuid`);
  }
  return value.toLowerCase();
}

function asOptionalTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new BadRequest(`${field} must be an ISO-8601 timestamp`);
  }
  return new Date(value).toISOString();
}

interface ParsedPlayer {
  profile_id: string | null;
  display_name: string;
  is_bot: boolean;
  team: number;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  damage_dealt: number;
  accuracy: number | null;
}

function parsePlayer(raw: unknown, i: number): ParsedPlayer {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BadRequest(`players[${i}] must be an object`);
  }
  const p = raw as Record<string, unknown>;
  const isBot = p.is_bot === true;
  const profileId = asOptionalUuid(p.profile_id, `players[${i}].profile_id`);

  if (isBot && profileId) {
    throw new BadRequest(`players[${i}] cannot be a bot and have a profile_id`);
  }

  let accuracy: number | null = null;
  if (p.accuracy !== undefined && p.accuracy !== null) {
    if (typeof p.accuracy !== "number" || !Number.isFinite(p.accuracy)) {
      throw new BadRequest(`players[${i}].accuracy must be a number`);
    }
    if (p.accuracy < 0 || p.accuracy > 1) {
      throw new BadRequest(`players[${i}].accuracy must be between 0 and 1`);
    }
    accuracy = p.accuracy;
  }

  return {
    profile_id: profileId,
    display_name: asString(p.display_name, `players[${i}].display_name`, 64),
    is_bot: isBot,
    team: asInt(p.team, `players[${i}].team`, -1, 64),
    kills: asInt(p.kills, `players[${i}].kills`, 0, 100_000),
    deaths: asInt(p.deaths, `players[${i}].deaths`, 0, 100_000),
    assists: asInt(p.assists, `players[${i}].assists`, 0, 100_000),
    score: asInt(p.score, `players[${i}].score`, -1_000_000, 10_000_000),
    damage_dealt: asInt(p.damage_dealt, `players[${i}].damage_dealt`, 0, 100_000_000),
    accuracy,
  };
}

// ------------------------------------------------------------------ handler
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }

  const expectedSecret = Deno.env.get("MATCH_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!expectedSecret || !supabaseUrl || !serviceKey) {
    // Deployment problem, not a caller problem. Still no stack trace.
    console.error("submit-match: missing MATCH_SECRET or Supabase env vars");
    return json(503, { ok: false, error: "server_not_configured" });
  }

  try {
    // ---- body ------------------------------------------------------------
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new BadRequest("invalid_json");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new BadRequest("body must be a JSON object");
    }
    const { secret, match, players } = body as Record<string, unknown>;

    // ---- auth ------------------------------------------------------------
    if (typeof secret !== "string" || secret.length === 0) {
      return json(401, { ok: false, error: "unauthorized" });
    }
    if (!(await secretsMatch(secret, expectedSecret))) {
      return json(401, { ok: false, error: "unauthorized" });
    }

    // ---- match -----------------------------------------------------------
    if (typeof match !== "object" || match === null || Array.isArray(match)) {
      throw new BadRequest("match is required");
    }
    const m = match as Record<string, unknown>;

    const mode = asString(m.mode, "match.mode", 16);
    if (!(MODES as readonly string[]).includes(mode)) {
      throw new BadRequest(`match.mode must be one of ${MODES.join(", ")}`);
    }

    let seed: number | null = null;
    if (m.seed !== undefined && m.seed !== null) {
      if (typeof m.seed !== "number" || !Number.isFinite(m.seed) || !Number.isInteger(m.seed)) {
        throw new BadRequest("match.seed must be an integer");
      }
      seed = m.seed;
    }

    const roomCode = asOptionalString(m.room_code, "match.room_code", 6);
    const waveReached = asOptionalInt(m.wave_reached, "match.wave_reached", 0, 100_000);
    const winningTeam = asOptionalInt(m.winning_team, "match.winning_team", -1, 64);

    const matchRow = {
      id: asOptionalUuid(m.id, "match.id") ?? crypto.randomUUID(),
      room_code: roomCode ? roomCode.toUpperCase() : null,
      mode,
      seed,
      started_at: asOptionalTimestamp(m.started_at, "match.started_at") ?? new Date().toISOString(),
      ended_at: asOptionalTimestamp(m.ended_at, "match.ended_at") ?? new Date().toISOString(),
      duration_seconds: asOptionalInt(m.duration_seconds, "match.duration_seconds", 0, 86_400),
      winning_team: winningTeam,
      wave_reached: waveReached,
      server_secret_verified: true,
    };

    // ---- players ---------------------------------------------------------
    if (!Array.isArray(players) || players.length === 0) {
      throw new BadRequest("players must be a non-empty array");
    }
    if (players.length > MAX_PLAYERS) {
      throw new BadRequest(`players must contain at most ${MAX_PLAYERS} entries`);
    }
    const parsed = players.map(parsePlayer);

    const profileIds = [...new Set(parsed.map((p) => p.profile_id).filter((v): v is string => !!v))];
    if (profileIds.length !== parsed.filter((p) => p.profile_id).length) {
      throw new BadRequest("players contains duplicate profile_id values");
    }

    const db = createClient(supabaseUrl, serviceKey, {
      db: { schema: "game" },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Unknown profile ids are a caller error (4xx), not a foreign-key 500.
    if (profileIds.length > 0) {
      const { data: known, error: lookupError } = await db
        .from("profiles")
        .select("id")
        .in("id", profileIds);
      if (lookupError) {
        if (lookupError.code === "PGRST106") return schemaNotExposed();
        console.error("submit-match: profile lookup failed", lookupError.message);
        return json(500, { ok: false, error: "profile_lookup_failed" });
      }
      const knownIds = new Set((known ?? []).map((r: { id: string }) => r.id));
      const missing = profileIds.filter((id) => !knownIds.has(id));
      if (missing.length > 0) {
        throw new BadRequest(`unknown profile_id: ${missing.join(", ")}`, 422);
      }
    }

    // ---- XP --------------------------------------------------------------
    const xp: Record<string, number> = {};
    const rows = parsed.map((p) => {
      let awarded = 0;
      if (p.profile_id && !p.is_bot) {
        awarded = XP_PER_MATCH + XP_PER_KILL * p.kills;
        if (matchRow.winning_team !== null && p.team === matchRow.winning_team) {
          awarded += XP_PER_WIN;
        }
        if (matchRow.wave_reached !== null) {
          awarded += XP_PER_WAVE * matchRow.wave_reached;
        }
        xp[p.profile_id] = awarded;
      }
      return { ...p, match_id: matchRow.id, xp_awarded: awarded };
    });

    // ---- write -----------------------------------------------------------
    const { error: matchError } = await db.from("matches").insert(matchRow);
    if (matchError) {
      if (matchError.code === "PGRST106") return schemaNotExposed();
      if (matchError.code === "23505") {
        return json(409, { ok: false, error: "match_already_submitted" });
      }
      console.error("submit-match: match insert failed", matchError.message);
      return json(500, { ok: false, error: "match_insert_failed" });
    }

    const { error: playersError } = await db.from("match_players").insert(rows);
    if (playersError) {
      // Roll back the orphaned match so a retry can succeed cleanly.
      await db.from("matches").delete().eq("id", matchRow.id);
      if (playersError.code === "23505") {
        return json(409, { ok: false, error: "duplicate_player_in_match" });
      }
      console.error("submit-match: player insert failed", playersError.message);
      return json(400, { ok: false, error: "match_players_rejected" });
    }

    if (Object.keys(xp).length > 0) {
      const awards = Object.entries(xp).map(([profile_id, amount]) => ({ profile_id, xp: amount }));
      const { error: xpError } = await db.rpc("award_xp", { p_awards: awards });
      if (xpError) {
        // Results are already durable; XP can be reconciled. Do not 500.
        console.error("submit-match: award_xp failed", xpError.message);
        return json(200, {
          ok: true,
          matchId: matchRow.id,
          xp,
          warning: "xp_award_deferred",
        });
      }
    }

    return json(200, { ok: true, matchId: matchRow.id, xp });
  } catch (err) {
    if (err instanceof BadRequest) {
      return json(err.status, { ok: false, error: err.message });
    }
    console.error("submit-match: unhandled", err instanceof Error ? err.message : String(err));
    return json(500, { ok: false, error: "internal_error" });
  }
});
