import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createWorldService } from './world.mjs';

export const SECTORS = Object.freeze(Object.assign(Object.create(null), {
  FRONT_PASSENGER: [-45, 90], REAR_LEFT: [-180, -45], REAR_RIGHT: [45, 180],
}));
const passengerSeat = value => typeof value === 'string' && Object.hasOwn(SECTORS, value);
const SEATS = ['DRIVER', ...Object.keys(SECTORS)];
const OCCUPANCY = ['OCCUPIED', 'EMPTY', 'UNKNOWN'];
const UX = ['ALLOWED', 'RESTRICTED', 'UNKNOWN'];
const GEARS = ['P', 'R', 'N', 'D', 'UNKNOWN'];
const BODY_LIMIT = 16 * 1024;
const token = () => randomBytes(24).toString('base64url');
const newZombies = () => [
  { id: 'zombie_left', angleDeg: -100, hp: 5, maxHp: 5 },
  { id: 'zombie_front', angleDeg: 60, hp: 5, maxHp: 5 },
  { id: 'zombie_rear', angleDeg: 140, hp: 5, maxHp: 5 },
];
const PICKUPS = Object.freeze([
  { pickupId: 'DEMO_PICKUP_A', title: '테스트 보급 상자 A', resource: 'supplies', amount: 1 },
  { pickupId: 'DEMO_PICKUP_B', title: '테스트 보급 상자 B', resource: 'supplies', amount: 1 },
  { pickupId: 'DEMO_PICKUP_C', title: '테스트 보급 상자 C', resource: 'supplies', amount: 1 },
]);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const angularDistance = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const asText = (value, max = 128) => typeof value === 'string' && value.length > 0 && value.length <= max;

export function createDemoServer(options = {}) {
  const leaseMs = options.leaseMs ?? 6000;
  const pairingTtlMs = options.pairingTtlMs ?? 120000;
  const maxReceipts = options.maxReceiptsPerMember ?? 10000;
  const world = createWorldService({ clock: options.worldClock ?? Date.now, maxReceipts });
  const sessions = new Map();
  const rooms = new Map();
  const joinCodes = new Map();
  const sockets = new Set();
  const requestBuckets = new Map();
  let listening = false;

  function authenticate(req) {
    const value = req.headers.authorization;
    if (!value?.startsWith('Bearer ')) throw fail('AUTH_REQUIRED', 'Bearer token required', 401);
    const session = sessions.get(value.slice(7));
    if (!session || session.expiresAt <= Date.now()) throw fail('AUTH_EXPIRED', 'Session missing or expired', 401);
    return session;
  }
  function memberFor(room, session, approved = true) {
    const member = room.members.get(session.sessionId);
    if (!member) throw fail('NOT_MEMBER', 'Not a member of this room', 403);
    if (approved && !member.approved) throw fail('MEMBER_PENDING', 'Waiting for vehicle approval', 403);
    return member;
  }
  function roomFor(id) {
    const room = rooms.get(id);
    if (!room) throw fail('ROOM_NOT_FOUND', 'Room not found', 404);
    return room;
  }
  function requireHost(room, session) {
    const member = memberFor(room, session);
    if (member.role !== 'CAR_HOST') throw fail('ROLE_FORBIDDEN', 'Vehicle host only', 403);
    return member;
  }
  function seatEvidence(room, seat) {
    if (room.emptyLocks.has(seat)) return 'EMPTY';
    const occupancy = room.vehicle.seats.find(s => s.seat === seat)?.occupancy ?? 'UNKNOWN';
    return occupancy === 'OCCUPIED' ? 'SENSOR' : occupancy === 'EMPTY' ? 'EMPTY' : 'MANUAL_UNKNOWN';
  }
  function gate(room) {
    const v = room.vehicle;
    const reasons = [];
    if (!v.hostConnected) reasons.push('CAR_DISCONNECTED');
    if (!v.foreground) reasons.push('APP_INACTIVE');
    if (Date.now() - v.receivedAt > leaseMs) reasons.push('LEASE_EXPIRED');
    if (v.ux !== 'ALLOWED') reasons.push(v.ux === 'RESTRICTED' ? 'UX_RESTRICTED' : 'UX_UNKNOWN');
    if (v.gear !== 'P') reasons.push(v.gear === 'UNKNOWN' ? 'GEAR_UNKNOWN' : 'GEAR_NOT_P');
    return { allowed: reasons.length === 0, reasons };
  }
  function snapshot(room, viewer) {
    if (!viewer.approved) {
      return {
        roomId: room.roomId, roomEpoch: room.roomEpoch, stateVersion: room.stateVersion, state: 'PENDING', pauseReason: 'MEMBER_PENDING', joinCode: null, joinExpiresAt: 0,
        members: [{ memberId: viewer.memberId, sessionId: viewer.sessionId, nickname: viewer.nickname, role: viewer.role, seat: viewer.seat, approved: false, connected: !!viewer.socket, seatEvidence: 'MANUAL_UNKNOWN', sector: SECTORS[viewer.seat] }],
        vehicle: { ux: 'UNKNOWN', gear: 'UNKNOWN', foreground: false, seats: [], charge: { state: 'UNKNOWN', portConnection: 'UNKNOWN', source: 'NONE' }, source: 'PENDING_REDACTED', reportAgeMs: null, playAllowed: false, gateReasons: ['MEMBER_PENDING'] },
        stats: { shots: 0, rejectedShots: 0, hits: 0, zombieHp: 0, zombieAngleDeg: 0, supportUntil: 0, supportCount: 0, supportDamage: 2, supportSupplyUsed: false, kills: 0, waveCleared: false, lastShot: null, supportActive: false },
        collection: { mode: 'DEMO_PICKUP', gpsVerified: false, label: '테스트 수집 지점 · GPS 미검증', fixtures: [], inventory: { supplies: 0 }, collectedPickupIds: [], lastCollect: null },
        zombies: [], sectors: SECTORS, trust: 'WAITING_FOR_VEHICLE_APPROVAL', serverTime: Date.now(),
      };
    }
    const host = viewer.role === 'CAR_HOST';
    const g = gate(room);
    return {
      roomId: room.roomId, roomEpoch: room.roomEpoch, stateVersion: room.stateVersion,
      state: room.state, pauseReason: room.pauseReason,
      joinCode: host && room.joinExpiresAt > Date.now() && !room.joinUsed ? room.joinCode : null,
      joinExpiresAt: room.joinExpiresAt,
      members: [...room.members.values()].filter(m => !viewer.approved ? m.sessionId === viewer.sessionId : host || m.approved).map(m => ({
        memberId: m.memberId, sessionId: m.sessionId, nickname: m.nickname, role: m.role,
        seat: m.seat, approved: m.approved, connected: !!m.socket,
        seatEvidence: seatEvidence(room, m.seat), sector: SECTORS[m.seat] ?? null,
      })),
      vehicle: {
        ux: room.vehicle.ux, gear: room.vehicle.gear, foreground: room.vehicle.foreground, seats: room.vehicle.seats,
        charge: room.vehicle.charge, source: room.vehicle.source,
        reportAgeMs: room.vehicle.receivedAt ? Date.now() - room.vehicle.receivedAt : null,
        playAllowed: g.allowed, gateReasons: g.reasons,
      },
      stats: { ...room.stats, supportActive: room.stats.supportUntil > Date.now() },
      collection: {
        mode: 'DEMO_PICKUP', gpsVerified: false, label: '테스트 수집 지점 · GPS 미검증',
        fixtures: PICKUPS, inventory: { ...room.collection.inventory },
        collectedPickupIds: [...(viewer.collectedPickups ?? [])], lastCollect: room.collection.lastCollect,
        eligibility: viewer.role === 'CAR_HOST' ? 'DRIVER_CANNOT_COLLECT' : 'APPROVED_ROLE_AND_PASSENGER_SELF_DECLARATION_ONLY',
      },
      zombies: room.zombies.map(z => ({ ...z })),
      sectors: SECTORS,
      trust: 'LOCAL_DEMO_CLIENT_REPORT_NOT_VEHICLE_ATTESTATION',
      serverTime: Date.now(),
    };
  }
  function send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 128 * 1024) ws.send(JSON.stringify(payload));
  }
  function broadcast(room) {
    for (const member of room.members.values()) {
      if (member.socket) send(member.socket, { type: 'snapshot', room: snapshot(room, member) });
    }
  }
  function change(room) { room.stateVersion++; broadcast(room); }
  function pause(room, reason) {
    if (room.state === 'PLAYING') {
      room.state = 'PAUSED'; room.roomEpoch++; room.pauseReason = reason;
      change(room);
    }
  }
  async function readJson(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_LIMIT) throw fail('PAYLOAD_TOO_LARGE', 'Maximum 16 KiB', 413);
      chunks.push(chunk);
    }
    try {
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error();
      return result;
    } catch { throw fail('INVALID_JSON', 'JSON object required'); }
  }
  function result(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(value));
  }
  function rateLimit(key, limit = 120) {
    const now = Date.now(); const item = requestBuckets.get(key);
    if (!item || item.until < now) { requestBuckets.set(key, { count: 1, until: now + 10000 }); return; }
    if (++item.count > limit) throw fail('RATE_LIMITED', 'Try again later', 429);
  }
  const server = http.createServer(async (req, res) => {
    try {
      rateLimit('http:' + req.socket.remoteAddress);
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/healthz') return result(res, 200, { ok: true, protocol: 'zride-demo-v1', contractRevision: 3, rooms: rooms.size });
      if (req.method === 'POST' && path === '/api/session') {
        if (sessions.size >= 500) throw fail('SESSION_LIMIT', 'Demo session limit', 503);
        const body = await readJson(req);
        if (!['CAR_HOST', 'PHONE'].includes(body.role)) throw fail('INVALID_ROLE', 'CAR_HOST or PHONE required');
        if (!asText(body.nickname, 24)) throw fail('INVALID_NICKNAME', 'Nickname 1..24 characters');
        const credential = token();
        const session = { sessionId: randomUUID(), token: credential, role: body.role, nickname: body.nickname, expiresAt: Date.now() + 8 * 3600000, roomId: null };
        sessions.set(credential, session);
        return result(res, 201, { sessionId: session.sessionId, token: credential, expiresAt: session.expiresAt, role: session.role });
      }
      const session = authenticate(req);
      if (path.startsWith('/api/world/')) {
        if (session.role !== 'PHONE') throw fail('ROLE_FORBIDDEN', 'World collection APIs are passenger-phone only', 403);
        const room = roomFor(session.roomId); const member = memberFor(room, session);
        if (!passengerSeat(member.seat) || member.role === 'CAR_HOST') throw fail('ROLE_FORBIDDEN', 'Approved passenger role required', 403);
        if (req.method !== 'POST') throw fail('METHOD_NOT_ALLOWED', 'Use authenticated POST JSON; coordinates do not belong in URL queries', 405);
        rateLimit('world:' + session.sessionId, 30);
        const body = await readJson(req);
        if (path === '/api/world/nearby') return result(res, 200, world.nearby(member, body));
        if (path === '/api/world/location') return result(res, 200, world.observe(member, body));
        if (path === '/api/world/claim') {
          const claimed = world.claim(room, member, body);
          if (!claimed.replayed) change(room);
          return result(res, 200, claimed);
        }
        throw fail('NOT_FOUND', 'World route not found', 404);
      }
      if (req.method === 'POST' && path === '/api/rooms') {
        if (session.role !== 'CAR_HOST') throw fail('ROLE_FORBIDDEN', 'Vehicle session required', 403);
        if (session.roomId && rooms.has(session.roomId)) {
          const room = roomFor(session.roomId);
          joinCodes.delete(room.joinCode);
          room.joinCode = token().slice(0, 10).toUpperCase(); room.joinExpiresAt = Date.now() + pairingTtlMs; room.joinUsed = false;
          joinCodes.set(room.joinCode, room.roomId); change(room);
          return result(res, 200, { roomId: room.roomId, joinCode: room.joinCode, room: snapshot(room, memberFor(room, session)) });
        }
        const roomId = randomUUID(); const joinCode = token().slice(0, 10).toUpperCase();
        const member = { memberId: randomUUID(), sessionId: session.sessionId, nickname: session.nickname, role: 'CAR_HOST', seat: 'DRIVER', approved: true, socket: null, receipts: new Map() };
        const room = { roomId, roomEpoch: 0, stateVersion: 1, state: 'LOBBY', pauseReason: null, joinCode,
          joinExpiresAt: Date.now() + pairingTtlMs, joinUsed: false, members: new Map([[session.sessionId, member]]),
          vehicle: { ux: 'UNKNOWN', gear: 'UNKNOWN', foreground: false, seats: [], charge: { state: 'UNKNOWN', portConnection: 'UNKNOWN', source: 'NONE' }, source: 'UNKNOWN', receivedAt: 0, hostConnected: false },
          emptyLocks: new Set(),
          stats: { shots: 0, rejectedShots: 0, hits: 0, zombieHp: 5, zombieAngleDeg: 60, supportUntil: 0, supportCount: 0, supportDamage: 2, supportSupplyUsed: false, kills: 0, waveCleared: false, lastShot: null },
          zombies: newZombies(),
          collection: { inventory: { supplies: 0 }, lastCollect: null },
        };
        session.roomId = roomId; rooms.set(roomId, room); joinCodes.set(joinCode, roomId);
        return result(res, 201, { roomId, joinCode, room: snapshot(room, member) });
      }
      if (req.method === 'POST' && path === '/api/join') {
        if (session.role !== 'PHONE') throw fail('ROLE_FORBIDDEN', 'Phone session required', 403);
        const body = await readJson(req);
        if (!asText(body.joinCode, 64) || !passengerSeat(body.seat)) throw fail('INVALID_JOIN', 'joinCode and valid seat required');
        const room = roomFor(joinCodes.get(body.joinCode.toUpperCase()));
        if (room.joinExpiresAt <= Date.now()) throw fail('PAIRING_EXPIRED', 'Ask host for a new code', 409);
        if (room.joinUsed) throw fail('PAIRING_USED', 'Ask host for a new code', 409);
        if (session.roomId && session.roomId !== room.roomId) throw fail('ALREADY_JOINED', 'Session already has a room', 409);
        if (room.members.size >= 4) throw fail('ROOM_FULL', 'Maximum host plus 3 phones', 409);
        if (room.members.has(session.sessionId)) throw fail('ALREADY_JOINED', 'Already joined', 409);
        const member = { memberId: randomUUID(), sessionId: session.sessionId, nickname: session.nickname, role: body.seat, seat: body.seat, approved: false, socket: null, receipts: new Map(), collectedPickups: new Set() };
        room.members.set(session.sessionId, member); session.roomId = room.roomId; room.joinUsed = true;
        change(room);
        return result(res, 201, { roomId: room.roomId, memberId: member.memberId, pending: true, room: snapshot(room, member) });
      }
      const match = path.match(/^\/api\/rooms\/([^/]+)(?:\/(approve))?$/);
      if (match) {
        const room = roomFor(match[1]);
        if (req.method === 'GET' && !match[2]) return result(res, 200, { room: snapshot(room, memberFor(room, session, false)) });
        if (req.method === 'POST' && match[2] === 'approve') {
          requireHost(room, session); const body = await readJson(req);
          const member = [...room.members.values()].find(m => m.memberId === body.memberId);
          if (!member || member.role === 'CAR_HOST') throw fail('MEMBER_NOT_FOUND', 'Pending member not found', 404);
          const seat = body.seat ?? member.seat;
          if (!passengerSeat(seat)) throw fail('INVALID_SEAT', 'Passenger seat required');
          if (member.approved && member.seat !== seat && room.state === 'PLAYING') throw fail('REASSIGN_REQUIRES_PAUSE', 'Pause before changing a seat', 409);
          if ([...room.members.values()].some(m => m !== member && m.approved && m.seat === seat)) throw fail('SEAT_TAKEN', 'Seat already assigned', 409);
          member.seat = seat; member.role = seat; member.approved = true; change(room);
          const observed = room.vehicle.seats.find(s => s.seat === seat)?.occupancy ?? 'UNKNOWN';
          if (body.allowManualUnknown === true && observed === 'UNKNOWN') { room.emptyLocks.delete(seat); change(room); }
          return result(res, 200, { room: snapshot(room, memberFor(room, session)) });
        }
      }
      throw fail('NOT_FOUND', 'Route not found', 404);
    } catch (error) { result(res, error.status ?? 500, { error: { code: error.code ?? 'INTERNAL_ERROR', message: error.code ? error.message : 'Internal error' } }); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: BODY_LIMIT, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/ws') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    const origin = req.headers.origin;
    if (origin && !['http://127.0.0.1:8000', 'http://localhost:8000'].includes(origin)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    if (sockets.size >= 100) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  function perform(room, member, message) {
    if (message.type === 'vehicle.report') {
      if (member.role !== 'CAR_HOST') throw fail('ROLE_FORBIDDEN', 'Only vehicle can report state', 403);
      if (!UX.includes(message.ux) || !GEARS.includes(message.gear)) throw fail('INVALID_REPORT', 'Explicit UX and gear required');
      if (message.foreground != null && typeof message.foreground !== 'boolean') throw fail('INVALID_REPORT', 'foreground must be boolean');
      if (message.reportSeq != null && (!Number.isSafeInteger(message.reportSeq) || message.reportSeq <= (member.lastReportSeq ?? 0))) throw fail('STALE_REPORT', 'reportSeq must increase on this connection', 409);
      if (message.seats != null && (!Array.isArray(message.seats) || message.seats.length > 4)) throw fail('INVALID_REPORT', 'At most four seat reports');
      const seats = (message.seats ?? []).map(s => {
        if (!SEATS.includes(s.seat) || !OCCUPANCY.includes(s.occupancy)) throw fail('INVALID_REPORT', 'Invalid seat observation');
        return { seat: s.seat, occupancy: s.occupancy };
      });
      if (new Set(seats.map(s => s.seat)).size !== seats.length) throw fail('INVALID_REPORT', 'Duplicate seat observations');
      for (const s of seats) {
        if (s.occupancy === 'EMPTY') room.emptyLocks.add(s.seat);
        if (s.occupancy === 'OCCUPIED') room.emptyLocks.delete(s.seat);
      }
      if (message.reportSeq != null) member.lastReportSeq = message.reportSeq;
      room.vehicle = { ux: message.ux, gear: message.gear, foreground: message.foreground ?? true, seats,
        charge: { state: String(message.charge?.state ?? 'UNKNOWN').slice(0, 32), portConnection: String(message.charge?.portConnection ?? 'UNKNOWN').slice(0, 32), source: String(message.charge?.source ?? 'NONE').slice(0, 32) },
        source: String(message.source ?? 'CLIENT_REPORT').slice(0, 64), receivedAt: Date.now(), hostConnected: true };
      const g = gate(room);
      if (!g.allowed) pause(room, g.reasons.join(','));
      else if (room.state === 'LOBBY') room.state = 'READY';
      change(room); return { reported: true, gateAllowed: g.allowed };
    }
    if (message.type !== 'command') throw fail('INVALID_MESSAGE', 'command or vehicle.report required');
    if (!member.approved) throw fail('MEMBER_PENDING', 'Vehicle approval required', 403);
    if (message.action === 'mobile.collect') {
      if (member.role === 'CAR_HOST' || !passengerSeat(member.seat)) throw fail('ROLE_FORBIDDEN', 'Only an approved passenger can collect', 403);
      if (message.passengerConfirmed !== true) throw fail('PASSENGER_CONFIRMATION_REQUIRED', 'Confirm that you are a passenger, not the driver', 403);
      const pickup = PICKUPS.find(p => p.pickupId === message.pickupId);
      if (!pickup) throw fail('PICKUP_NOT_FOUND', 'Known DEMO_PICKUP fixture required', 404);
      if (member.collectedPickups.has(pickup.pickupId)) throw fail('ALREADY_COLLECTED', 'This passenger already collected this demo pickup', 409);
      member.collectedPickups.add(pickup.pickupId);
      room.collection.inventory.supplies += pickup.amount;
      room.collection.lastCollect = { memberId: member.memberId, pickupId: pickup.pickupId, amount: pickup.amount, at: Date.now() };
      change(room);
      return { pickupId: pickup.pickupId, amount: pickup.amount, inventory: { ...room.collection.inventory }, mode: 'DEMO_PICKUP', gpsVerified: false };
    }
    if (message.action === 'round.pause') { pause(room, 'USER_PAUSE'); return { paused: true }; }
    if (!Number.isInteger(message.roomEpoch) || message.roomEpoch !== room.roomEpoch) throw fail('STALE_EPOCH', 'Refresh snapshot before sending another action', 409);
    const g = gate(room);
    if (!g.allowed) { pause(room, g.reasons.join(',')); throw fail('GATE_CLOSED', g.reasons.join(','), 409); }
    if (message.action === 'round.start') {
      if (member.role !== 'CAR_HOST') throw fail('ROLE_FORBIDDEN', 'Vehicle starts round', 403);
      if (room.state === 'PLAYING') throw fail('ALREADY_PLAYING', 'Round already playing', 409);
      const activePhone = [...room.members.values()].some(m => m.role !== 'CAR_HOST' && m.approved && m.socket && seatEvidence(room, m.seat) !== 'EMPTY');
      if (!activePhone) throw fail('OPERATOR_REQUIRED', 'At least one approved phone in a non-empty seat required', 409);
      if (room.state === 'CLEARED') { room.zombies = newZombies(); room.stats.waveCleared = false; }
      room.state = 'PLAYING'; room.pauseReason = null; room.roomEpoch++; change(room); return { started: true };
    }
    if (room.state !== 'PLAYING') throw fail('NOT_PLAYING', 'Explicit vehicle start/resume required', 409);
    if (message.action === 'support.pulse') {
      if (member.role !== 'CAR_HOST') throw fail('ROLE_FORBIDDEN', 'Vehicle support only', 403);
      if (room.stats.supportUntil > Date.now()) throw fail('SUPPORT_COOLDOWN', 'Support is already active', 409);
      if (room.collection.inventory.supplies < 1) throw fail('SUPPLY_REQUIRED', 'Collect one demo supply before vehicle support', 409);
      const consumed = 1;
      room.collection.inventory.supplies--;
      room.stats.supportDamage = 3;
      room.stats.supportSupplyUsed = true;
      room.stats.supportUntil = Date.now() + 5000; room.stats.supportCount++; change(room);
      return { supportUntil: room.stats.supportUntil, supportDamage: room.stats.supportDamage, suppliesConsumed: consumed, inventory: { ...room.collection.inventory } };
    }
    if (message.action === 'fire') {
      const sector = SECTORS[member.seat];
      if (!sector) throw fail('ROLE_FORBIDDEN', 'Driver is commander, not shooter', 403);
      if (seatEvidence(room, member.seat) === 'EMPTY') throw fail('SEAT_EMPTY', 'Assigned seat is reported empty', 409);
      if (typeof message.angleDeg !== 'number' || !Number.isFinite(message.angleDeg) || message.angleDeg < -180 || message.angleDeg > 180) throw fail('INVALID_ANGLE', 'Finite angle -180..180 required');
      const rearBoundary = Math.abs(message.angleDeg) === 180 && ['REAR_LEFT', 'REAR_RIGHT'].includes(member.seat);
      if (!rearBoundary && (message.angleDeg < sector[0] || message.angleDeg > sector[1])) {
        room.stats.rejectedShots++;
        room.stats.lastShot = { memberId: member.memberId, angleDeg: message.angleDeg, accepted: false, hit: false, targetId: null, damage: 0, time: Date.now() };
        change(room); throw fail('ANGLE_OUTSIDE_SECTOR', `Allowed ${sector[0]}..${sector[1]} degrees`, 409);
      }
      room.stats.shots++;
      const target = room.zombies.filter(z => z.hp > 0).sort((a,b) => angularDistance(a.angleDeg, message.angleDeg) - angularDistance(b.angleDeg, message.angleDeg))[0];
      const hit = !!target && angularDistance(message.angleDeg, target.angleDeg) <= 15;
      const damage = hit ? (room.stats.supportUntil > Date.now() ? room.stats.supportDamage : 1) : 0;
      if (hit) room.stats.hits++;
      if (hit) {
        target.hp = Math.max(0, target.hp - damage);
        room.stats.zombieHp = target.hp; room.stats.zombieAngleDeg = target.angleDeg;
        if (target.hp === 0) room.stats.kills++;
      }
      room.stats.lastShot = { memberId: member.memberId, angleDeg: message.angleDeg, accepted: true, hit, targetId: hit ? target.id : null, damage, time: Date.now() };
      room.stats.waveCleared = room.zombies.every(z => z.hp === 0);
      if (room.stats.waveCleared) { room.state = 'CLEARED'; room.roomEpoch++; }
      change(room); return { hit, damage, targetId: hit ? target.id : null, targetHp: hit ? target.hp : null, angleDeg: message.angleDeg };
    }
    throw fail('UNKNOWN_ACTION', 'Unknown game action');
  }
  wss.on('connection', ws => {
    sockets.add(ws); let current = null;
    const authTimer = setTimeout(() => ws.close(4401, 'Authenticate first'), 5000);
    ws.on('error', () => {});
    ws.on('message', data => {
      try {
        let message;
        try { message = JSON.parse(data.toString('utf8')); } catch { throw fail('INVALID_JSON', 'JSON required'); }
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw fail('INVALID_MESSAGE', 'JSON object required');
        if (!current) {
          if (message.type !== 'auth') throw fail('AUTH_REQUIRED', 'First message must be auth', 401);
          const session = sessions.get(message.token);
          if (!session || session.expiresAt <= Date.now()) throw fail('AUTH_EXPIRED', 'Invalid session', 401);
          const room = roomFor(message.roomId); const member = memberFor(room, session, false);
          if (member.socket && member.socket !== ws) member.socket.close(4409, 'Connection replaced');
          member.socket = ws; current = { session, room, member }; clearTimeout(authTimer);
          if (member.role === 'CAR_HOST') {
            member.lastReportSeq = 0;
            pause(room, 'VEHICLE_RECONNECTED'); room.vehicle.receivedAt = 0; room.vehicle.hostConnected = true;
            room.vehicle.ux = 'UNKNOWN'; room.vehicle.gear = 'UNKNOWN';
            room.vehicle.foreground = false;
          }
          send(ws, { type: 'auth.ok', sessionId: session.sessionId, memberId: member.memberId });
          change(room); return;
        }
        const { session, room, member } = current;
        if (member.socket !== ws) throw fail('CONNECTION_REPLACED', 'Old connection cannot send commands', 403);
        if (session.expiresAt <= Date.now()) { ws.close(4401, 'Session expired'); return; }
        rateLimit('ws:' + session.sessionId, 120);
        if (!asText(message.commandId, 128)) throw fail('COMMAND_ID_REQUIRED', 'Unique commandId required');
        const fingerprint = hash(message);
        const receipt = member.receipts.get(message.commandId);
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', 'Same commandId with a different message', 409);
          send(ws, receipt.response); return;
        }
        if (member.receipts.size >= maxReceipts) {
          send(ws, { type: 'result', commandId: message.commandId, ok: false, error: { code: 'COMMAND_LIMIT', message: 'Demo command capacity reached; no action applied' }, roomEpoch: room.roomEpoch });
          ws.close(4429, 'Demo command limit reached'); return;
        }
        let response;
        try { response = { type: 'result', commandId: message.commandId, ok: true, data: perform(room, member, message), roomEpoch: room.roomEpoch }; }
        catch (error) { response = { type: 'result', commandId: message.commandId, ok: false, error: { code: error.code ?? 'INTERNAL_ERROR', message: error.code ? error.message : 'Internal error' }, roomEpoch: room.roomEpoch }; }
        member.receipts.set(message.commandId, { fingerprint, response }); send(ws, response);
      } catch (error) {
        send(ws, { type: 'result', commandId: null, ok: false, error: { code: error.code ?? 'INTERNAL_ERROR', message: error.code ? error.message : 'Internal error' } });
        if (!current) ws.close(4401, 'Authentication failed');
      }
    });
    ws.on('close', () => {
      clearTimeout(authTimer); sockets.delete(ws);
      if (!current || current.member.socket !== ws) return;
      const { room, member } = current; member.socket = null;
      if (member.role === 'CAR_HOST') { room.vehicle.hostConnected = false; room.vehicle.receivedAt = 0; pause(room, 'CAR_DISCONNECTED'); }
      change(room);
    });
  });
  const gateTimer = setInterval(() => {
    for (const room of rooms.values()) if (room.state === 'PLAYING' && !gate(room).allowed) pause(room, gate(room).reasons.join(','));
    for (const room of rooms.values()) for (const member of room.members.values()) world.pruneQuality(member);
    for (const [key, value] of requestBuckets) if (value.until < Date.now()) requestBuckets.delete(key);
  }, 250);
  gateTimer.unref();
  return {
    server,
    async listen(port = options.port ?? 8000, host = options.host ?? '127.0.0.1') {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
      listening = true; return server.address();
    },
    async close() {
      clearInterval(gateTimer);
      for (const ws of sockets) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      if (listening) await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createDemoServer();
  const address = await app.listen(Number(process.env.PORT ?? 8000), process.env.HOST ?? '127.0.0.1');
  console.log(JSON.stringify({ event: 'server.ready', address, protocol: 'zride-demo-v1', contractRevision: 3, persistence: 'memory-only', exposure: 'local-debug' }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
