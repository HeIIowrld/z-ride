import { createServer as createHttp } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game } from './game.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };
const FILES = { '/': 'host.html', '/p': 'phone.html', '/host.js': 'host.js', '/phone.js': 'phone.js', '/shared.js': 'shared.js', '/qr.js': 'qr.js', '/style.css': 'style.css', '/zride-car.js': '../../sdk/zride-car.js' };
const STATIC = Object.fromEntries(Object.entries(FILES).map(([path, file]) => [path, { body: readFileSync(join(root, file)), type: TYPES[file.split('.').pop()] }]));
const HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'self'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
};
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_ROOMS = 200, ROOM_TTL_MS = 3 * 3600_000, MAX_BODY = 2048;
const FRAME_MS = 60; // 이동이 몰릴 때 화면 갱신 간격
const NAME_MAX = 10;

const token = () => randomBytes(24).toString('base64url');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

function lanOrigin(port) {
  for (const list of Object.values(networkInterfaces()))
    for (const net of list ?? []) if (net.family === 'IPv4' && !net.internal) return `http://${net.address}:${port}`;
  return `http://localhost:${port}`;
}

export function createVoltServer({ publicOrigin = '', now = Date.now } = {}) {
  const rooms = new Map();

  function newCode() {
    for (;;) {
      const code = Array.from(randomBytes(5), b => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
      if (!rooms.has(code)) return code;
    }
  }
  function sweep() {
    for (const [code, room] of rooms) if (now() - room.touched > ROOM_TTL_MS) { closeRoom(room); rooms.delete(code); }
  }
  function closeRoom(room) {
    clearTimeout(room.timer); clearTimeout(room.frame);
    for (const ws of room.sockets) ws.close(4404, 'Room closed');
  }

  let closed = false; // 서버를 닫은 뒤 늦게 오는 연결 끊김이 타이머를 다시 걸지 않게
  function publish(room) {
    if (closed) return;
    room.touched = now();
    clearTimeout(room.timer); clearTimeout(room.frame); room.frame = null;
    const { game } = room;
    // 이벤트(무료 이동·정전)가 끝나는 순간에도 한 번 다시 알린다
    const eventEnd = game.event && game.event.until > now() ? game.event.until : Infinity;
    if (game.deadline && game.deadline <= eventEnd) room.timer = setTimeout(() => { game.expire(); publish(room); }, Math.max(0, game.deadline - now()) + 20);
    else if (eventEnd !== Infinity) room.timer = setTimeout(() => publish(room), eventEnd - now() + 20);
    for (const ws of room.sockets) send(ws, { type: 'state', state: ws.role === 'HOST' ? game.publicView() : game.playerView(ws.playerId) });
  }
  // 연타는 자주 오니 모아서 내보낸다. 판이 끝나는 연타는 바로 내보낸다
  function publishSoon(room) { if (!room.frame) room.frame = setTimeout(() => publish(room), FRAME_MS); }
  const send = (ws, message) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); };

  async function readJson(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new Error('TOO_LARGE'); chunks.push(chunk); }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  }
  function reply(res, status, body) {
    res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  const http = createHttp(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && STATIC[pathname]) {
        res.writeHead(200, { ...HEADERS, 'content-type': STATIC[pathname].type });
        return res.end(STATIC[pathname].body);
      }
      if (req.method === 'GET' && pathname === '/healthz') return reply(res, 200, { ok: true, rooms: rooms.size });
      if (req.method === 'POST' && pathname === '/api/rooms') {
        sweep();
        if (rooms.size >= MAX_ROOMS) return reply(res, 503, { error: 'SERVER_FULL' });
        const code = newCode(), hostToken = token();
        rooms.set(code, { code, hostToken, game: new Game({ now }), tokens: new Map(), sockets: new Set(), timer: null, frame: null, touched: now() });
        const origin = publicOrigin || lanOrigin(http.address().port);
        return reply(res, 200, { code, hostToken, joinUrl: `${origin}/p#${code}` });
      }
      const join = pathname.match(/^\/api\/rooms\/([A-Z0-9]{5})\/join$/);
      if (req.method === 'POST' && join) {
        const room = rooms.get(join[1]);
        if (!room) return reply(res, 404, { error: 'NO_ROOM' });
        const { name } = await readJson(req);
        const clean = String(name ?? '').trim().slice(0, NAME_MAX);
        if (!clean) return reply(res, 400, { error: 'NAME_REQUIRED' });
        const playerId = randomUUID(), playerToken = token();
        room.game.addPlayer(playerId, clean);
        room.tokens.set(playerToken, playerId);
        publish(room);
        return reply(res, 200, { code: room.code, playerId, token: playerToken });
      }
      reply(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      const known = /^[A-Z_]+$/.test(error.message);
      reply(res, known ? 409 : 400, { error: known ? error.message : 'BAD_REQUEST' });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  http.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://x');
    const origin = req.headers.origin;
    if (pathname !== '/ws' || (origin && new URL(origin).host !== req.headers.host)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });

  function authenticate(ws, message) {
    const room = rooms.get(message.code);
    if (!room) return ws.close(4404, 'No room');
    if (same(message.token, room.hostToken)) ws.role = 'HOST';
    else if (room.tokens.has(message.token)) { ws.role = 'PLAYER'; ws.playerId = room.tokens.get(message.token); }
    else return ws.close(4401, 'Bad token');
    ws.room = room;
    // 같은 사람의 옛 연결은 정리한다(아이폰이 새 탭으로 다시 붙는 경우)
    for (const old of room.sockets) if (old.role === ws.role && old.playerId === ws.playerId) { room.sockets.delete(old); old.close(4409, 'Replaced'); }
    room.sockets.add(ws);
    if (ws.playerId) room.game.setConnected(ws.playerId, true);
    send(ws, { type: 'auth.ok', role: ws.role });
    publish(room);
  }

  function handle(ws, message) {
    const { room } = ws, { game } = room;
    if (ws.role === 'HOST') {
      if (message.type === 'start') game.start();
      else if (message.type === 'next') game.next();
      else if (message.type === 'lobby') game.backToLobby();
      else if (message.type === 'kick') game.removePlayer(message.playerId);
      else if (message.type === 'soc') game.setSoc(message.soc, message.target);
      else throw new Error('BAD_MESSAGE');
    } else if (message.type === 'move') {
      const phase = game.phase;
      game.move(ws.playerId, message.dir);
      if (game.phase === phase) return publishSoon(room);
    } else if (message.type === 'item') game.useItem(ws.playerId, String(message.id ?? ''));
    else throw new Error('BAD_MESSAGE');
    publish(room);
  }

  wss.on('connection', ws => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    const authTimer = setTimeout(() => { if (!ws.room) ws.close(4401, 'Authenticate first'); }, 5000);
    ws.on('message', data => {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (!ws.room) { if (message.type === 'auth') authenticate(ws, message); return; }
      try { handle(ws, message); }
      catch (error) { send(ws, { type: 'error', code: /^[A-Z_]+$/.test(error.message) ? error.message : 'ERROR' }); }
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      const { room } = ws;
      if (!room || !room.sockets.delete(ws)) return;
      if (ws.playerId) { room.game.setConnected(ws.playerId, false); publish(room); }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
  }, 15_000);
  heartbeat.unref();
  http.on('close', () => { closed = true; clearInterval(heartbeat); for (const room of rooms.values()) { clearTimeout(room.timer); clearTimeout(room.frame); } });
  return { http, wss, rooms };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8230);
  const { http } = createVoltServer({ publicOrigin: process.env.PUBLIC_ORIGIN ?? '' });
  http.listen(port, process.env.HOST ?? '0.0.0.0', () => console.log(JSON.stringify({ event: 'server.ready', port })));
}
