// 충전 게임 4종을 Cloudflare Workers + Durable Objects로 돌린다.
// 방 하나 = Durable Object 하나(이름은 방 코드). 방 상태·타이머·WebSocket을 그 안에서 들고 있는다.
// 어떤 게임인지는 env.GAME으로 정한다(게임마다 Worker를 따로 배포한다).
import { DurableObject } from 'cloudflare:workers';
import { ADAPTERS } from './adapters.mjs';
import { crewItems, validCrewKey } from '../deadzone/packages/shared/src/ply-crew.js';

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const NAME_MAX = 10, MAX_BODY = 2048, FRAME_MS = 60, ROOM_TTL_MS = 6 * 3600_000;
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
      let crewKey;
      if (env.GAME === 'volt-rush') {
        try {
          const body = await readJson(request);
          if (validCrewKey(body.crewKey)) crewKey = body.crewKey;
          else if (body.crewKey !== undefined) return json(400, { error: 'BAD_REQUEST' });
        } catch { return json(400, { error: 'BAD_REQUEST' }); }
      }
      // 코드가 겹치면 다시 뽑는다(Durable Object가 이미 쓰인 방이면 409)
      for (let i = 0; i < 5; i++) {
        const code = newCode();
        const res = await room(code).fetch('https://room/init', { method: 'POST', body: JSON.stringify({ code, crewKey }) });
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
    // 아무도 접속하지 않으면 Durable Object가 메모리에서 내려간다. 방 코드·입장권·참가자는 저장소에 남겨 두고
    // 다시 불리면 같은 입장권으로 들어올 수 있게 되살린다(진행 중인 판은 접속이 붙어 있어 내려가지 않는다).
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('room');
      if (!saved) return;
      this.code = saved.code; this.hostToken = saved.hostToken; this.crewKey = saved.crewKey;
      this.game = this.adapter.create(Date.now);
      for (const p of saved.players) {
        try { this.game.addPlayer(p.playerId, p.name); this.tokens.set(p.token, p.playerId); } catch {}
      }
    });
  }

  async alarm() {
    for (const ws of this.sockets) try { ws.close(4404, 'Room closed'); } catch {}
    await this.ctx.storage.deleteAll();
    this.game = null; this.tokens.clear(); this.sockets.clear(); this.who.clear();
  }

  save() {
    const players = [...this.tokens].map(([token, playerId]) => ({ token, playerId, name: this.game.players.find(p => p.id === playerId)?.name }))
      .filter(p => p.name);
    return this.ctx.storage.put('room', { code: this.code, hostToken: this.hostToken, crewKey: this.crewKey, players });
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/init') {
      if (this.game) return json(409, { error: 'TAKEN' });
      const { code, crewKey } = await request.json();
      this.crewKey = crewKey;
      this.code = code; this.hostToken = randomToken();
      this.game = this.adapter.create(Date.now);
      await this.save();
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS); // 오래된 방은 저장소에서 지운다
      return json(200, { hostToken: this.hostToken });
    }
    if (!this.game) {
      if (pathname === '/join') return json(404, { error: 'NO_ROOM' });
      // 없는 방이면 연결을 받은 뒤 4404로 닫는다. 화면이 "방이 닫혔어요"를 띄울 수 있게
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].close(4404, 'No room');
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (pathname === '/join') {
      try {
        const { name } = await readJson(request);
        // 크루 방도 차 화면 QR로 들어올 수 있다(운전자 합류)
        const clean = String(name ?? '').trim().slice(0, NAME_MAX);
        if (!clean) return json(400, { error: 'NAME_REQUIRED' });
        const playerId = crypto.randomUUID(), token = randomToken();
        this.game.addPlayer(playerId, clean);
        this.tokens.set(token, playerId);
        await this.save();
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
    ws.addEventListener('message', async event => {
      if (typeof event.data !== 'string' || event.data.length > (this.adapter.maxPayload ?? 4096)) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!this.who.has(ws)) { if (message.type === 'auth') this.authenticate(ws, message); return; }
      try { await this.handle(ws, message); }
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

  async handle(ws, message) {
    const me = this.who.get(ws);
    if (this.crewKey && me.role === 'HOST' && message.type === 'start' &&
        ['LOBBY', 'END'].includes(this.game.phase)) {
      if (this.loadingCrew) throw new Error('GAME_ITEMS_BUSY');
      this.loadingCrew = true;
      try {
        const stock = await crewItems(this.env, this.crewKey, 'volt-rush', this.code, 'loadout');
        this.game.crewStock = stock.items;
      } finally { this.loadingCrew = false; }
      if (this.who.get(ws) !== me) return;
    }
    if (this.crewKey && me.role === 'PLAYER' && message.type === 'item')
      return this.useCrewItem(me.playerId, String(message.id ?? ''));
    const after = me.role === 'HOST' ? this.adapter.host(this.game, message) : this.adapter.player(this.game, me.playerId, message);
    if (message.type === 'kick') this.save();
    if (after === 'SOON') return this.publishSoon();
    this.publish();
  }

  async useCrewItem(playerId, itemId) {
    const game = this.game;
    if (game.phase !== 'PLAY') throw new Error('NOT_PLAYING');
    const player = game.players.find(candidate => candidate.id === playerId);
    if (!player?.bag.some(card => card.id === itemId)) throw new Error('NO_ITEM');
    if (this.usingCrewItem) throw new Error('GAME_ITEMS_BUSY');
    if (this.pendingCrewUse?.round !== game.round) this.pendingCrewUse = null;
    const round = game.round;
    const request = (action, details) => crewItems(this.env, this.crewKey, 'volt-rush', this.code, action, details);
    const operation = this.usingCrewItem = this.pendingCrewUse ?? { playerId, itemId, round, useId: crypto.randomUUID() };
    if (operation.itemId !== itemId || operation.playerId !== playerId || operation.round !== round) {
      this.usingCrewItem = null;
      throw new Error('GAME_ITEMS_BUSY');
    }
    try {
      let receipt;
      try {
        receipt = await request('use', { itemId, useId: operation.useId });
      } catch (error) {
        this.pendingCrewUse = error.permanent ? null : operation;
        if (error.message === 'GAME_ITEM_EMPTY') {
          game.updateCrewItem(itemId, 0);
          this.publish();
        }
        throw error;
      }
      this.pendingCrewUse = null;
      if (this.game !== game || game.phase !== 'PLAY' || game.round !== round || !game.players.includes(player)) {
        await request('refund', { itemId, useId: operation.useId });
        throw new Error('NOT_PLAYING');
      }
      game.useItem(playerId, itemId);
      game.updateCrewItem(itemId, receipt.remaining);
      this.publish();
    } finally { this.usingCrewItem = null; }
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
