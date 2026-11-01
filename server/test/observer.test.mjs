import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createObserverService, observerSnapshot } from '../observer.mjs';

function roomFixture(roomId = 'room-a', sessionId = 'host-a') {
  return {
    roomId, roomEpoch: 4, stateVersion: 7, state: 'PLAYING', pauseReason: null,
    joinCode: 'SECRET_JOIN_CODE', joinExpiresAt: 9999999999999,
    members: new Map([
      [sessionId, { memberId: 'member-' + sessionId, sessionId, nickname: '<script>host</script>', role: 'CAR_HOST', seat: 'DRIVER', approved: true, socket: { readyState: WebSocket.OPEN }, receipts: new Map([['secret-command', { response: 'private receipt' }]]) }],
      ['phone-a', { memberId: 'member-phone', sessionId: 'phone-a', nickname: '동승자', role: 'FRONT_PASSENGER', seat: 'FRONT_PASSENGER', approved: true, socket: null, collectedPickups: new Set(['PRIVATE_PICKUP']), worldClaims: new Map([['private-visit', { latitude: 37.12345 }]]) }],
    ]),
    vehicle: { ux: 'ALLOWED', gear: 'P', foreground: true, source: 'TEST', receivedAt: Date.now(), charge: { state: 'UNKNOWN', portConnection: 'UNKNOWN' }, seats: [{ seat: 'FRONT_PASSENGER', occupancy: 'UNKNOWN' }] },
    emptyLocks: new Set(), stats: { shots: 2, hits: 1, kills: 0, lastShot: { memberId: 'member-phone', angleDeg: 60, accepted: true, hit: true, targetId: 'z', damage: 1, time: Date.now() } },
    zombies: [{ id: 'z', angleDeg: 60, hp: 4, maxHp: 5 }],
    collection: { inventory: { supplies: 3 }, lastCollect: { latitude: 37.12345, pickupId: 'PRIVATE_PICKUP' } },
  };
}

async function fixture(options = {}) {
  const rooms = new Map([['room-a', roomFixture()], ['room-b', roomFixture('room-b', 'host-b')]]);
  const sessions = new Map([
    ['host-token-a', { sessionId: 'host-a', role: 'CAR_HOST', expiresAt: Date.now() + 3600000 }],
    ['host-token-b', { sessionId: 'host-b', role: 'CAR_HOST', expiresAt: Date.now() + 3600000 }],
    ['phone-token', { sessionId: 'phone-a', role: 'PHONE', expiresAt: Date.now() + 3600000 }],
  ]);
  const observer = createObserverService({ getSession: credential => sessions.get(credential), getRoom: id => rooms.get(id), getRooms: () => rooms.values(), getGate: () => ({ allowed: true, reasons: [] }), heartbeatMs: 50, ...options });
  const server = http.createServer((req, res) => { if (!observer.handleHttp(req, res, new URL(req.url, 'http://localhost').pathname)) { res.writeHead(404); res.end(); } });
  server.on('upgrade', (req, socket, head) => { if (!observer.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const sockets = [];
  async function connect(token, roomId = 'room-a', headers = undefined) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/observer/ws', headers ? { headers } : undefined);
    const queue = [], waiters = [];
    ws.on('message', bytes => { const value = JSON.parse(bytes); queue.push(value); for (const entry of [...waiters]) if (entry.predicate(value)) { clearTimeout(entry.timer); waiters.splice(waiters.indexOf(entry), 1); entry.resolve(value); } });
    const wait = predicate => {
      const found = queue.find(predicate); if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => { const item = { predicate, resolve, timer: setTimeout(() => reject(new Error('Observer wait timed out')), 1500) }; waiters.push(item); });
    };
    sockets.push(ws); await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'observer.auth', token, roomId }));
    return { ws, queue, wait };
  }
  return { rooms, sessions, observer, base, connect, async close() { for (const socket of sockets) socket.terminate(); await observer.close(); await new Promise(resolve => server.close(resolve)); } };
}

test('observer projection explicitly strips credentials, claims, locations and session IDs', () => {
  const value = observerSnapshot(roomFixture(), { allowed: true, reasons: [] });
  const serialized = JSON.stringify(value);
  for (const forbidden of ['SECRET_JOIN_CODE', 'secret-command', 'PRIVATE_PICKUP', '37.12345', 'sessionId', 'worldClaims', 'receipts']) assert.ok(!serialized.includes(forbidden), forbidden);
  assert.equal(value.viewMode, 'SERVER_STATE_NOT_SCREEN_CAPTURE');
  assert.equal(value.inventory.supplies, 3); assert.equal(value.members[1].connected, false);
  assert.deepEqual(value.members[1].sector, [-45, 90]);
});

test('observer host authentication is room-scoped, does not replace game sockets, and is read-only', async () => {
  const app = await fixture();
  try {
    const original = app.rooms.get('room-a').members.get('host-a').socket;
    const host = await app.connect('host-token-a');
    assert.equal((await host.wait(value => value.type === 'observer.auth.ok')).readOnly, true);
    const snapshot = await host.wait(value => value.type === 'observer.snapshot');
    assert.equal(snapshot.room.inventory.supplies, 3);
    assert.equal(app.rooms.get('room-a').members.get('host-a').socket, original);
    const room = app.rooms.get('room-a'); room.stateVersion++; room.collection.inventory.supplies = 4; app.observer.broadcast(room);
    assert.equal((await host.wait(value => value.type === 'observer.snapshot' && value.room.stateVersion === 8)).room.inventory.supplies, 4);
    host.ws.send(JSON.stringify({ type: 'command', commandId: 'malicious', action: 'support.pulse' }));
    assert.equal((await host.wait(value => value.type === 'observer.error')).error.code, 'READ_ONLY');
    assert.equal(room.collection.inventory.supplies, 4);
    const stranger = await app.connect('host-token-b', 'room-a');
    assert.equal((await stranger.wait(value => value.type === 'observer.error')).error.code, 'ROLE_FORBIDDEN');
    const phone = await app.connect('phone-token');
    assert.equal((await phone.wait(value => value.type === 'observer.error')).error.code, 'ROLE_FORBIDDEN');
    const missing = await app.connect('invalid-token');
    assert.equal((await missing.wait(value => value.type === 'observer.error')).error.code, 'AUTH_EXPIRED');
  } finally { await app.close(); }
});

test('observer operator access is optional, room lists require its separate credential, and game commands remain forbidden', async () => {
  const disabled = await fixture();
  try {
    assert.equal((await fetch(disabled.base + '/api/observer/rooms', { headers: { Authorization: 'Bearer any' } })).status, 403);
  } finally { await disabled.close(); }
  const app = await fixture({ operatorToken: 'operator-test-secret' });
  try {
    const route = app.base + '/api/observer/rooms';
    assert.equal((await fetch(route)).status, 401);
    assert.equal((await fetch(route, { headers: { Authorization: 'Bearer host-token-a' } })).status, 403);
    const response = await fetch(route, { headers: { Authorization: 'Bearer operator-test-secret' } });
    assert.equal(response.status, 200); const data = await response.json();
    assert.equal(data.readOnly, true); assert.equal(data.rooms.length, 2);
    assert.ok(!JSON.stringify(data).includes('host-a')); assert.ok(!JSON.stringify(data).includes('SECRET_JOIN_CODE'));
    const viewer = await app.connect('operator-test-secret', 'room-b');
    assert.equal((await viewer.wait(value => value.type === 'observer.auth.ok')).authorization, 'OPERATOR');
    assert.equal((await viewer.wait(value => value.type === 'observer.snapshot')).room.roomId, 'room-b');
    viewer.ws.send(JSON.stringify({ type: 'vehicle.report', ux: 'ALLOWED', gear: 'P' }));
    assert.equal((await viewer.wait(value => value.type === 'observer.error')).error.code, 'READ_ONLY');
  } finally { await app.close(); }
});

test('observer closes expired authorization and blocks cross-origin browser upgrades', async () => {
  let now = Date.now();
  const app = await fixture({ clock: () => now, operatorToken: 'operator-test-secret' });
  try {
    const viewer = await app.connect('operator-test-secret');
    await viewer.wait(value => value.type === 'observer.auth.ok');
    const closed = once(viewer.ws, 'close'); now += 3600001;
    assert.equal((await closed)[0], 4401);
    const forbidden = new WebSocket(app.base.replace('http:', 'ws:') + '/observer/ws', { origin: 'https://unrelated.invalid' });
    forbidden.on('error', () => {});
    const [, response] = await once(forbidden, 'unexpected-response');
    assert.equal(response.statusCode, 403); forbidden.terminate();
  } finally { await app.close(); }
});

test('observer serves real product assets with restrictive CSP and no embedded operator secret', async () => {
  const app = await fixture({ operatorToken: 'operator-test-secret' });
  try {
    for (const path of ['/observer', '/observer/app.js', '/observer/style.css']) {
      const response = await fetch(app.base + path); assert.equal(response.status, 200);
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      const body = await response.text(); assert.ok(!body.includes('operator-test-secret'));
      if (path.endsWith('app.js')) { assert.ok(!/localStorage|sessionStorage/.test(body)); assert.ok(!/innerHTML/.test(body)); }
    }
    assert.equal((await fetch(app.base + '/observer/missing')).status, 404);
    assert.equal((await fetch(app.base + '/observer', { method: 'POST' })).status, 405);
  } finally { await app.close(); }
});
