// 충전 게임 4종(Power Castle, Volt Rush, Power Tug, 충전 릴레이)을 PLY 서버 안에서 직접 띄운다.
// 주소는 /charge/<게임>/ (차 화면), /charge/<게임>/p (폰), WebSocket은 /charge/<게임>/ws?room=CODE.
// 방 로직은 games/cloudflare/worker.mjs의 Room과 같고, 규칙은 각 게임의 game.mjs를 그대로 쓴다.
// 게임 파일은 배포 묶음(./charge-assets/)이 있으면 그걸, 없으면 저장소의 ../games/를 읽는다.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { WebSocketServer } from 'ws';

export const CHARGE_GAME_IDS = ['power-castle', 'volt-rush', 'power-tug', 'charge-relay'];
const bundled = new URL('./charge-assets/', import.meta.url);
const repo = new URL('../games/', import.meta.url);
const hasAdapters = root => existsSync(new URL('cloudflare/adapters.mjs', root));
export const CHARGE_ROOT = hasAdapters(bundled) ? bundled : hasAdapters(repo) ? repo : null;
const { ADAPTERS } = CHARGE_ROOT ? await import(new URL('cloudflare/adapters.mjs', CHARGE_ROOT).href) : { ADAPTERS: {} };
/** 이 서버가 직접 띄울 수 있는 충전 게임인가(게임 파일이 있는가) */
export const localChargeGame = id => Boolean(ADAPTERS[id]) && existsSync(new URL(id + '/public/host.html', CHARGE_ROOT));

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const NAME_MAX = 10, MAX_BODY = 2048, FRAME_MS = 60, ROOM_TTL_MS = 6 * 3600_000, MAX_ROOMS = 200, MAX_SOCKETS = 200;
const HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'self'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
};
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };
const PAGES = { '': 'host.html', p: 'phone.html' };

const token = () => randomBytes(24).toString('base64url');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const known = error => (/^[A-Z_]+$/.test(error?.message ?? '') ? error.message : null);

function loadFiles(id) {
  const dir = new URL(id + '/public/', CHARGE_ROOT), files = new Map();
  for (const name of readdirSync(dir)) {
    const type = TYPES[name.split('.').pop()];
    if (type && /^[a-z0-9-]+\.[a-z]+$/.test(name)) files.set(name, { body: readFileSync(new URL(name, dir)), type });
  }
  files.set('zride-car.js', { body: readFileSync(new URL('sdk/zride-car.js', CHARGE_ROOT)), type: TYPES.js });
  return files;
}

/**
 * @param games 이 서버에서 띄울 게임 id 목록
 * @param crewItems Volt Rush 크루 가방 연동: (crewKey, game, code, action, details) => 결과. 실패는 Error(코드)로 던진다.
 * @param acceptedOrigin 브라우저 WebSocket의 Origin 확인
 */
export function createChargeGameHost({ games, crewItems, acceptedOrigin = () => true, now = Date.now }) {
  const files = new Map(games.map(id => [id, loadFiles(id)]));
  const rooms = new Map(); // `${game}:${code}` → room
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  let closed = false;

  const key = (game, code) => game + ':' + code;
  function sweep() {
    for (const [id, room] of rooms) if (now() - room.touched > ROOM_TTL_MS) closeRoom(id, room);
  }
  function closeRoom(id, room) {
    clearTimeout(room.timer); clearTimeout(room.frame);
    for (const ws of room.sockets) try { ws.close(4404, 'Room closed'); } catch {}
    rooms.delete(id);
  }

  /** 방 만들기. Volt Rush 파티 방이면 crewKey로 크루 가방을 쓴다. */
  function createRoom(game, { crewKey } = {}) {
    if (!files.has(game)) throw new Error('UNKNOWN_GAME');
    sweep();
    if (rooms.size >= MAX_ROOMS) throw new Error('SERVER_FULL');
    let code;
    do code = Array.from(randomBytes(5), b => CODE_LETTERS[b % CODE_LETTERS.length]).join(''); while (rooms.has(key(game, code)));
    const room = { game, code, hostToken: token(), crewKey: game === 'volt-rush' ? crewKey ?? null : null,
      adapter: ADAPTERS[game], state: ADAPTERS[game].create(now), tokens: new Map(), sockets: new Set(),
      timer: null, frame: null, touched: now() };
    rooms.set(key(game, code), room);
    return { code, hostToken: room.hostToken };
  }

  function join(game, code, { name } = {}) {
    const room = rooms.get(key(game, code));
    if (!room) throw new Error('NO_ROOM');
    // 크루 방(Volt Rush)도 차 화면 QR로 들어올 수 있다. 운전자가 같은 크루 가방으로 함께한다
    const clean = String(name ?? '').trim().slice(0, NAME_MAX);
    if (!clean) throw new Error('NAME_REQUIRED');
    const playerId = randomUUID(), playerToken = token();
    room.state.addPlayer(playerId, clean);
    room.tokens.set(playerToken, playerId);
    publish(room);
    return { code, playerId, token: playerToken };
  }

  const send = (ws, message) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); };
  /** 모두에게 현재 상태를 보내고, 다음 마감·이벤트 시각에 다시 깨어나도록 예약한다. */
  function publish(room) {
    if (closed) return;
    room.touched = now();
    clearTimeout(room.timer); clearTimeout(room.frame); room.frame = null;
    const at = room.adapter.wakeAt(room.state);
    if (at != null) room.timer = setTimeout(() => { room.adapter.wake(room.state); publish(room); }, Math.max(0, at - now()) + 20);
    for (const ws of room.sockets)
      send(ws, { type: 'state', state: ws.role === 'HOST' ? room.state.publicView() : room.state.playerView(ws.playerId) });
  }
  // 연타·이동처럼 자주 오는 메시지는 모아서 내보낸다
  function publishSoon(room) { if (!room.frame) room.frame = setTimeout(() => publish(room), FRAME_MS); }

  function authenticate(ws, game, message) {
    const room = rooms.get(key(game, String(message.code ?? '')));
    if (!room) return ws.close(4404, 'No room');
    if (same(message.token, room.hostToken)) ws.role = 'HOST';
    else if (room.tokens.has(message.token)) { ws.role = 'PLAYER'; ws.playerId = room.tokens.get(message.token); }
    else return ws.close(4401, 'Bad token');
    ws.room = room;
    // 같은 사람의 옛 연결은 정리한다(폰이 새 탭으로 다시 붙는 경우)
    for (const old of room.sockets) if (old.role === ws.role && old.playerId === ws.playerId) { room.sockets.delete(old); old.close(4409, 'Replaced'); }
    room.sockets.add(ws);
    if (ws.playerId) room.state.setConnected(ws.playerId, true);
    send(ws, { type: 'auth.ok', role: ws.role });
    publish(room);
  }

  async function handle(ws, message) {
    const { room } = ws;
    if (room.crewKey && ws.role === 'HOST' && message.type === 'start' && ['LOBBY', 'END'].includes(room.state.phase)) {
      if (room.loadingCrew) throw new Error('GAME_ITEMS_BUSY');
      room.loadingCrew = true;
      try { room.state.crewStock = (await crewItems(room.crewKey, room.game, room.code, 'loadout')).items; }
      finally { room.loadingCrew = false; }
      if (!room.sockets.has(ws)) return;
    }
    if (room.crewKey && ws.role === 'PLAYER' && message.type === 'item') return useCrewItem(room, ws.playerId, String(message.id ?? ''));
    const after = ws.role === 'HOST' ? room.adapter.host(room.state, message) : room.adapter.player(room.state, ws.playerId, message);
    if (after === 'SOON') return publishSoon(room);
    publish(room);
  }

  // Volt Rush: 폰이 크루 가방 아이템을 쓰면 PLY 재고에서 먼저 빼고(영수증), 판이 바뀌었으면 돌려준다
  async function useCrewItem(room, playerId, itemId) {
    const game = room.state;
    if (game.phase !== 'PLAY') throw new Error('NOT_PLAYING');
    const player = game.players.find(candidate => candidate.id === playerId);
    if (!player?.bag.some(card => card.id === itemId)) throw new Error('NO_ITEM');
    if (room.usingCrewItem) throw new Error('GAME_ITEMS_BUSY');
    if (room.pendingCrewUse?.round !== game.round) room.pendingCrewUse = null;
    const round = game.round;
    const request = (action, details) => crewItems(room.crewKey, room.game, room.code, action, details);
    const operation = room.usingCrewItem = room.pendingCrewUse ?? { playerId, itemId, round, useId: randomUUID() };
    if (operation.itemId !== itemId || operation.playerId !== playerId || operation.round !== round) {
      room.usingCrewItem = null;
      throw new Error('GAME_ITEMS_BUSY');
    }
    try {
      let receipt;
      try {
        receipt = await request('use', { itemId, useId: operation.useId });
      } catch (error) {
        room.pendingCrewUse = error.permanent ? null : operation;
        if (error.message === 'GAME_ITEM_EMPTY') { game.updateCrewItem(itemId, 0); publish(room); }
        throw error;
      }
      room.pendingCrewUse = null;
      if (room.state !== game || game.phase !== 'PLAY' || game.round !== round || !game.players.includes(player)) {
        await request('refund', { itemId, useId: operation.useId });
        throw new Error('NOT_PLAYING');
      }
      game.useItem(playerId, itemId);
      game.updateCrewItem(itemId, receipt.remaining);
      publish(room);
    } finally { room.usingCrewItem = null; }
  }

  wss.on('connection', (ws, game) => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    const authTimer = setTimeout(() => { if (!ws.room) ws.close(4401, 'Authenticate first'); }, 5000);
    ws.on('message', async data => {
      const limit = ADAPTERS[game].maxPayload ?? 4096;
      if (data.length > limit) return;
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (!ws.room) { if (message?.type === 'auth') authenticate(ws, game, message); return; }
      try { await handle(ws, message); }
      catch (error) { send(ws, { type: 'error', code: known(error) ?? 'ERROR' }); }
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      const { room } = ws;
      if (!room || !room.sockets.delete(ws)) return;
      if (ws.playerId) { room.state.setConnected(ws.playerId, false); publish(room); }
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
  }, 15_000);
  heartbeat.unref();

  function reply(res, status, body, headers = {}) {
    res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  }
  async function readJson(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new Error('TOO_LARGE'); chunks.push(chunk); }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  }
  const route = path => /^\/charge\/([a-z-]+)(?:\/(.*))?$/.exec(path);

  /** /charge/ 아래 요청을 처리한다. 처리했으면 true. */
  async function handleHttp(req, res, path) {
    const match = route(path);
    if (!match) return false;
    const [, game, rest] = match;
    const assets = files.get(game);
    if (!assets) { reply(res, 404, { error: 'NOT_FOUND' }); return true; }
    // 상대 경로(./host.js 등)가 맞게 풀리도록 /charge/<게임>은 /charge/<게임>/로 보낸다
    if (rest === undefined) { res.writeHead(308, { ...HEADERS, location: '/charge/' + game + '/' }); res.end(); return true; }
    try {
      if (req.method === 'GET') {
        const file = assets.get(PAGES[rest] ?? rest);
        if (!file) return reply(res, 404, { error: 'NOT_FOUND' }), true;
        res.writeHead(200, { ...HEADERS, 'content-type': file.type });
        res.end(file.body);
        return true;
      }
      if (req.method === 'POST' && rest === 'api/rooms') {
        await readJson(req); // 브라우저가 직접 연 방에는 크루 가방이 없다
        const { code, hostToken } = createRoom(game);
        reply(res, 200, { code, hostToken, joinUrl: '/charge/' + game + '/p#' + code });
        return true;
      }
      const joinRoute = /^api\/rooms\/([A-Z0-9]{5})\/join$/.exec(rest);
      if (req.method === 'POST' && joinRoute) {
        reply(res, 200, join(game, joinRoute[1], await readJson(req)));
        return true;
      }
      reply(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      const code = known(error);
      reply(res, code === 'NO_ROOM' ? 404 : code === 'SERVER_FULL' ? 503 : code ? 409 : 400, { error: code ?? 'BAD_REQUEST' });
    }
    return true;
  }

  /** /charge/<게임>/ws 업그레이드를 처리한다. 처리했으면 true. */
  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    const match = /^\/charge\/([a-z-]+)\/ws$/.exec(url.pathname);
    if (!match) return false;
    const game = match[1];
    if (!files.has(game) || !/^[A-Z0-9]{5}$/.test(url.searchParams.get('room') ?? '')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return true;
    }
    if (!acceptedOrigin(req.headers.origin, req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return true;
    }
    if (wss.clients.size >= MAX_SOCKETS) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return true; }
    // 없는 방이어도 연결을 받은 뒤 4404로 닫는다. 화면이 "방이 닫혔어요"를 띄울 수 있게
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, game));
    return true;
  }

  function close() {
    closed = true;
    clearInterval(heartbeat);
    for (const [id, room] of rooms) closeRoom(id, room);
    for (const ws of wss.clients) ws.terminate();
  }

  return { games: [...files.keys()], createRoom, join, handleHttp, handleUpgrade, close, rooms };
}
