import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const SECTORS = Object.freeze({ FRONT_PASSENGER: [-45, 90], REAR_LEFT: [-180, -45], REAR_RIGHT: [45, 180] });
const FILES = new Map([
  ['/observer', ['index.html', 'text/html; charset=utf-8']],
  ['/observer/', ['index.html', 'text/html; charset=utf-8']],
  ['/observer/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/observer/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const codeError = (code, message) => Object.assign(new Error(message), { code });
const text = (value, maximum = 128) => typeof value === 'string' ? value.slice(0, maximum) : '';
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

/** Deliberate allow-list: never pass a raw player/host snapshot to observers. */
export function observerSnapshot(room, gateResult, now = Date.now()) {
  const vehicle = room.vehicle ?? {};
  const evidence = seat => {
    if (room.emptyLocks?.has(seat)) return 'EMPTY';
    const value = vehicle.seats?.find(item => item.seat === seat)?.occupancy;
    return value === 'OCCUPIED' ? 'SENSOR' : value === 'EMPTY' ? 'EMPTY' : 'MANUAL_UNKNOWN';
  };
  const stats = room.stats ?? {};
  const shot = stats.lastShot;
  return {
    protocol: 'zride-observer-v1', viewMode: 'SERVER_STATE_NOT_SCREEN_CAPTURE',
    roomId: room.roomId, roomEpoch: finite(room.roomEpoch), stateVersion: finite(room.stateVersion),
    state: text(room.state, 32), pauseReason: room.pauseReason == null ? null : text(room.pauseReason, 256),
    vehicle: {
      ux: text(vehicle.ux, 32), gear: text(vehicle.gear, 16), foreground: vehicle.foreground === true,
      source: text(vehicle.source, 64), reportAgeMs: vehicle.receivedAt ? Math.max(0, now - vehicle.receivedAt) : null,
      playAllowed: gateResult?.allowed === true, gateReasons: (gateResult?.reasons ?? ['UNKNOWN_GATE']).map(value => text(value, 64)),
      charge: { state: text(vehicle.charge?.state, 32), portConnection: text(vehicle.charge?.portConnection, 32) },
    },
    members: [...room.members.values()].map(member => ({
      memberId: member.memberId, nickname: text(member.nickname, 24), role: text(member.role, 32), seat: text(member.seat, 32),
      approved: member.approved === true, connected: member.socket?.readyState === WebSocket.OPEN,
      seatEvidence: evidence(member.seat), sector: SECTORS[member.seat] ? [...SECTORS[member.seat]] : null,
    })),
    stats: {
      shots: finite(stats.shots), rejectedShots: finite(stats.rejectedShots), hits: finite(stats.hits), kills: finite(stats.kills),
      supportActive: finite(stats.supportUntil) > now, supportUntil: finite(stats.supportUntil), supportDamage: finite(stats.supportDamage, 1),
      supportCount: finite(stats.supportCount), waveCleared: stats.waveCleared === true,
      lastShot: shot ? {
        memberId: text(shot.memberId), angleDeg: finite(shot.angleDeg), accepted: shot.accepted === true, hit: shot.hit === true,
        targetId: shot.targetId == null ? null : text(shot.targetId), damage: finite(shot.damage), time: finite(shot.time),
      } : null,
    },
    zombies: (room.zombies ?? []).map(item => ({ id: text(item.id), angleDeg: finite(item.angleDeg), hp: finite(item.hp), maxHp: finite(item.maxHp) })),
    inventory: { supplies: finite(room.collection?.inventory?.supplies) },
    serverTime: now,
  };
}

/** Separate read-only channel. A viewer never occupies/replaces a game socket. */
export function createObserverService({ getSession, getRoom, getRooms = () => [], getGate, operatorToken = '', clock = Date.now, heartbeatMs = 15000, authTimeoutMs = 5000, maxObservers = 20, allowedOrigins = [] }) {
  const viewers = new Map();
  const connections = new Set();
  const assets = new Map([...FILES].map(([path, [file, type]]) => [path, { bytes: readFileSync(new URL('./observer/' + file, import.meta.url)), type }]));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const operatorDigest = operatorToken ? createHash('sha256').update(operatorToken).digest() : null;
  const isOperator = credential => operatorDigest && typeof credential === 'string' && credential.length <= 1024 && timingSafeEqual(operatorDigest, createHash('sha256').update(credential).digest());
  function send(ws, value) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 128 * 1024) { ws.close(1013, 'Observer is too slow'); return; }
    ws.send(JSON.stringify(value));
  }
  function hostContext(credential, roomId) {
    if (isOperator(credential)) {
      const room = typeof roomId === 'string' ? getRoom(roomId) : null;
      if (!room) throw codeError('ROOM_NOT_FOUND', 'Room not found');
      return { room, authorization: 'OPERATOR', expiresAt: clock() + 3600000 };
    }
    const session = typeof credential === 'string' ? getSession(credential) : null;
    if (!session || session.expiresAt <= clock()) throw codeError('AUTH_EXPIRED', 'Valid host session required');
    const room = typeof roomId === 'string' ? getRoom(roomId) : null;
    if (!room) throw codeError('ROOM_NOT_FOUND', 'Room not found');
    const member = room.members.get(session.sessionId);
    if (session.role !== 'CAR_HOST' || !member?.approved || member.role !== 'CAR_HOST') throw codeError('ROLE_FORBIDDEN', 'Only this room host can observe');
    return { room, authorization: 'ROOM_HOST', expiresAt: session.expiresAt };
  }
  const sendRoom = (ws, room) => send(ws, { type: 'observer.snapshot', room: observerSnapshot(room, getGate(room), clock()) });
  wss.on('connection', ws => {
    connections.add(ws); ws.observerAlive = true;
    const deadline = setTimeout(() => ws.close(4401, 'Authenticate observer first'), authTimeoutMs);
    deadline.unref();
    ws.on('error', () => {});
    ws.on('pong', () => { ws.observerAlive = true; });
    ws.on('message', bytes => {
      try {
        let message;
        try { message = JSON.parse(bytes.toString('utf8')); } catch { throw codeError('INVALID_JSON', 'JSON object required'); }
        if (!message || Array.isArray(message) || typeof message !== 'object') throw codeError('INVALID_MESSAGE', 'JSON object required');
        const viewer = viewers.get(ws);
        if (viewer) {
          hostContext(viewer.credential, viewer.roomId);
          throw codeError('READ_ONLY', 'Observers cannot send game commands');
        }
        if (message.type !== 'observer.auth') throw codeError('AUTH_REQUIRED', 'First message must be observer.auth');
        const { room, authorization, expiresAt } = hostContext(message.token, message.roomId);
        clearTimeout(deadline);
        viewers.set(ws, { credential: message.token, roomId: room.roomId, expiresAt });
        send(ws, { type: 'observer.auth.ok', protocol: 'zride-observer-v1', roomId: room.roomId, readOnly: true, authorization, expiresAt, viewMode: 'SERVER_STATE_NOT_SCREEN_CAPTURE' });
        sendRoom(ws, room);
      } catch (error) {
        send(ws, { type: 'observer.error', error: { code: error.code ?? 'INTERNAL_ERROR', message: error.code ? error.message : 'Observer unavailable' } });
        ws.close(error.code === 'READ_ONLY' || error.code === 'ROLE_FORBIDDEN' ? 4403 : 4401, 'Observer access denied');
      }
    });
    ws.on('close', () => { clearTimeout(deadline); viewers.delete(ws); connections.delete(ws); });
  });
  const timer = setInterval(() => {
    for (const ws of connections) {
      const viewer = viewers.get(ws);
      if (viewer) {
        if (viewer.expiresAt <= clock()) { ws.close(4401, 'Observer authorization expired'); continue; }
        try { hostContext(viewer.credential, viewer.roomId); } catch { ws.close(4401, 'Observer authorization expired'); continue; }
      }
      if (!ws.observerAlive) { ws.terminate(); continue; }
      ws.observerAlive = false; ws.ping();
      if (viewer) send(ws, { type: 'observer.heartbeat', serverTime: clock() });
    }
  }, heartbeatMs);
  timer.unref();
  function acceptsOrigin(origin, req) {
    if (!origin) return true; // Non-browser clients still need the host token.
    if (allowedOrigins.includes(origin)) return true;
    try { const parsed = new URL(origin); return ['http:', 'https:'].includes(parsed.protocol) && parsed.host === req.headers.host; }
    catch { return false; }
  }
  return {
    handleHttp(req, res, path) {
      if (path === '/api/observer/rooms') {
        const bearer = req.headers.authorization;
        const write = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); return true; };
        if (req.method !== 'GET') return write(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET' } });
        if (!operatorDigest) return write(403, { error: { code: 'OPERATOR_ACCESS_DISABLED', message: 'Operator observer access is not configured' } });
        if (!bearer?.startsWith('Bearer ')) return write(401, { error: { code: 'AUTH_REQUIRED', message: 'Operator Bearer token required' } });
        if (!isOperator(bearer.slice(7))) return write(403, { error: { code: 'ROLE_FORBIDDEN', message: 'Read-only operator credential required' } });
        return write(200, {
          protocol: 'zride-observer-v1', readOnly: true, serverTime: clock(),
          rooms: [...getRooms()].map(room => ({ roomId: room.roomId, state: text(room.state, 32), roomEpoch: finite(room.roomEpoch), stateVersion: finite(room.stateVersion),
            memberCount: room.members.size, connectedCount: [...room.members.values()].filter(member => member.socket?.readyState === WebSocket.OPEN).length,
            supplies: finite(room.collection?.inventory?.supplies), playAllowed: getGate(room)?.allowed === true,
          })),
        });
      }
      if (path !== '/observer' && !path.startsWith('/observer/')) return false;
      const file = assets.get(path);
      if (!file || !['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(file ? 405 : 404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end('Not available'); return true;
      }
      // Some browsers do not include WS schemes in CSP 'self'. Restrict the
      // explicit ws/wss additions to this request's validated host and port.
      let socketSources = '';
      const hostHeader = req.headers.host ?? '';
      if (/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::\d{1,5})?$/.test(hostHeader)) {
        try { const host = new URL('http://' + hostHeader).host; socketSources = ' ws://' + host + ' wss://' + host; } catch {}
      }
      res.writeHead(200, {
        'content-type': file.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'" + socketSources + "; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      });
      res.end(req.method === 'HEAD' ? undefined : file.bytes); return true;
    },
    handleUpgrade(req, socket, head) {
      if (new URL(req.url, 'http://localhost').pathname !== '/observer/ws') return false;
      if (!acceptsOrigin(req.headers.origin, req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return true; }
      if (connections.size >= maxObservers) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return true; }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); return true;
    },
    broadcast(room) {
      for (const [ws, viewer] of viewers) {
        if (viewer.roomId !== room.roomId) continue;
        try { if (viewer.expiresAt <= clock()) throw codeError('AUTH_EXPIRED', 'Observer expired'); hostContext(viewer.credential, viewer.roomId); sendRoom(ws, room); }
        catch { ws.close(4401, 'Observer authorization expired'); }
      }
    },
    async close() {
      clearInterval(timer);
      for (const ws of connections) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
    },
  };
}
