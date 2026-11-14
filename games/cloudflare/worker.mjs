// 충전 게임 4종을 Cloudflare Workers + Durable Objects로 돌린다.
// 방 하나 = Durable Object 하나(이름은 방 코드). 방 상태·타이머·WebSocket을 그 안에서 들고 있는다.
// 어떤 게임인지는 env.GAME으로 정한다(게임마다 Worker를 따로 배포한다).
import { DurableObject } from 'cloudflare:workers';
import { ADAPTERS } from './adapters.mjs';

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const NAME_MAX = 10, MAX_BODY = 2048, FRAME_MS = 60;
const HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'self'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
};
const PAGES = { '/': '/host.html', '/p': '/phone.html' };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, 'content-type': 'application/json; charset=utf-8' } });
const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), b => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
function same(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('TOO_LARGE');
  return text ? JSON.parse(text) : {};
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const room = code => env.ROOMS.get(env.ROOMS.idFromName(code));

    if (request.method === 'GET' && pathname === '/healthz') return json(200, { ok: true, game: env.GAME });
    if (request.method === 'POST' && pathname === '/api/rooms') {
      // 코드가 겹치면 다시 뽑는다(Durable Object가 이미 쓰인 방이면 409)
      for (let i = 0; i < 5; i++) {
        const code = newCode();
        const res = await room(code).fetch('https://room/init', { method: 'POST', body: JSON.stringify({ code }) });
        if (res.status === 409) continue;
        const { hostToken } = await res.json();
        return json(200, { code, hostToken, joinUrl: `${url.origin}/p#${code}` });
      }
      return json(503, { error: 'SERVER_FULL' });
    }
    const join = pathname.match(/^\/api\/rooms\/([A-Z0-9]{5})\/join$/);
    if (request.method === 'POST' && join) return room(join[1]).fetch('https://room/join', { method: 'POST', body: await request.text() });
    if (pathname === '/ws') {
      const code = url.searchParams.get('room') ?? '';
      if (request.headers.get('upgrade') !== 'websocket' || !/^[A-Z0-9]{5}$/.test(code)) return new Response('Expected websocket', { status: 426 });
      const origin = request.headers.get('origin');
      if (origin && new URL(origin).host !== url.host) return new Response('Bad origin', { status: 403 });
      return room(code).fetch(request);
    }
    if (request.method !== 'GET') return json(404, { error: 'NOT_FOUND' });
    const asset = await env.ASSETS.fetch(new URL(PAGES[pathname] ?? pathname, url.origin));
    if (!asset.ok) return json(404, { error: 'NOT_FOUND' });
    const res = new Response(asset.body, asset);
    for (const [k, v] of Object.entries(HEADERS)) res.headers.set(k, v);
    return res;
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.adapter = ADAPTERS[env.GAME];
    this.game = null; this.code = null; this.hostToken = null;
    this.tokens = new Map(); this.sockets = new Set(); this.who = new Map(); // ws → { role, playerId }
    this.timer = null; this.frame = null;
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/init') {
      if (this.game) return json(409, { error: 'TAKEN' });
      const { code } = await request.json();
      this.code = code; this.hostToken = randomToken();
      this.game = this.adapter.create(Date.now);
      return json(200, { hostToken: this.hostToken });
    }
    if (!this.game) return json(404, { error: 'NO_ROOM' });
    if (pathname === '/join') {
      try {
        const { name } = await readJson(request);
        const clean = String(name ?? '').trim().slice(0, NAME_MAX);
        if (!clean) return json(400, { error: 'NAME_REQUIRED' });
        const playerId = crypto.randomUUID(), token = randomToken();
        this.game.addPlayer(playerId, clean);
        this.tokens.set(token, playerId);
        this.publish();
        return json(200, { code: this.code, playerId, token });
      } catch (error) {
        const known = /^[A-Z_]+$/.test(error.message);
        return json(known ? 409 : 400, { error: known ? error.message : 'BAD_REQUEST' });
      }
    }
    // WebSocket: 첫 메시지로 토큰을 받아 차 화면(HOST)인지 폰(PLAYER)인지 정한다
    const pair = new WebSocketPair();
    const ws = pair[1];
    ws.accept();
    const authTimer = setTimeout(() => { if (!this.who.has(ws)) ws.close(4401, 'Authenticate first'); }, 5000);
    ws.addEventListener('message', event => {
      if (typeof event.data !== 'string' || event.data.length > (this.adapter.maxPayload ?? 4096)) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!this.who.has(ws)) { if (message.type === 'auth') this.authenticate(ws, message); return; }
      try { this.handle(ws, message); }
      catch (error) { this.send(ws, { type: 'error', code: /^[A-Z_]+$/.test(error.message) ? error.message : 'ERROR' }); }
    });
    const gone = () => {
      clearTimeout(authTimer);
      const me = this.who.get(ws); this.who.delete(ws);
      if (!this.sockets.delete(ws)) return;
      if (me?.playerId) { this.game.setConnected(me.playerId, false); this.publish(); }
    };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  authenticate(ws, message) {
    let me;
    if (same(message.token, this.hostToken)) me = { role: 'HOST', playerId: null };
    else if (this.tokens.has(message.token)) me = { role: 'PLAYER', playerId: this.tokens.get(message.token) };
    else return ws.close(4401, 'Bad token');
    // 같은 사람의 옛 연결은 정리한다(폰이 새 탭으로 다시 붙는 경우)
    for (const old of this.sockets) {
      const o = this.who.get(old);
      if (o && o.role === me.role && o.playerId === me.playerId) { this.sockets.delete(old); this.who.delete(old); try { old.close(4409, 'Replaced'); } catch {} }
    }
    this.who.set(ws, me); this.sockets.add(ws);
    if (me.playerId) this.game.setConnected(me.playerId, true);
    this.send(ws, { type: 'auth.ok', role: me.role });
    this.publish();
  }

  handle(ws, message) {
    const me = this.who.get(ws);
    const after = me.role === 'HOST' ? this.adapter.host(this.game, message) : this.adapter.player(this.game, me.playerId, message);
    if (after === 'SOON') return this.publishSoon();
    this.publish();
  }

  send(ws, message) { try { ws.send(JSON.stringify(message)); } catch {} }

  /** 모두에게 현재 상태를 보내고, 다음 마감·이벤트 시각에 다시 깨어나도록 예약한다. */
  publish() {
    clearTimeout(this.timer); clearTimeout(this.frame); this.frame = null;
    const at = this.adapter.wakeAt(this.game);
    if (at != null) this.timer = setTimeout(() => { this.adapter.wake(this.game); this.publish(); }, Math.max(0, at - Date.now()) + 20);
    for (const ws of this.sockets) {
      const me = this.who.get(ws);
      this.send(ws, { type: 'state', state: me.role === 'HOST' ? this.game.publicView() : this.game.playerView(me.playerId) });
    }
  }
  // 연타·이동처럼 자주 오는 메시지는 모아서 내보낸다
  publishSoon() { if (!this.frame) this.frame = setTimeout(() => this.publish(), FRAME_MS); }
}
