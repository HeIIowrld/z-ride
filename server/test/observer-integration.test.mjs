import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createDemoServer } from '../server.mjs';
import { createStateStore } from '../state-store.mjs';

const OPERATOR = 'integration-only-operator-fixture';
async function database(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zride-observer-integration-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('zride-observer-integration-'));
    await rm(directory, { recursive: true, force: true });
  });
  return join(directory, 'state.sqlite');
}
function requests(port) {
  return async (path, body, credential, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(credential ? { authorization: 'Bearer ' + credential } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}
async function seed(request) {
  const host = (await request('/api/session', { role: 'CAR_HOST', nickname: 'Observer host' })).body;
  const phone = (await request('/api/session', { role: 'PHONE', nickname: 'Observer passenger' })).body;
  const room = (await request('/api/rooms', {}, host.token)).body;
  const member = (await request('/api/join', { joinCode: room.joinCode, seat: 'FRONT_PASSENGER' }, phone.token)).body;
  assert.equal((await request(`/api/rooms/${room.roomId}/approve`, { memberId: member.memberId }, host.token)).status, 200);
  const nearby = (await request('/api/world/nearby', { latitude: 37.5665, longitude: 126.978, radiusM: 500 }, phone.token)).body;
  const spawn = nearby.spawns[0];
  return { host, phone, room, claim: { commandId: randomUUID(), spawnId: spawn.spawnId,
    scheduleId: nearby.scheduleId, version: spawn.version, spawnCycleId: spawn.spawnCycleId, passengerConfirmed: true,
    location: { latitude: spawn.latitude, longitude: spawn.longitude, accuracyM: 5, measuredAgeMs: 0, source: 'EMULATOR_GPS', isMock: false } } };
}
async function observer(port, credential, roomId, authenticate = true) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/observer/ws`);
  const queue = [], waiting = new Set();
  ws.on('error', () => {});
  ws.on('message', bytes => {
    const value = JSON.parse(bytes); queue.push(value);
    for (const waiter of waiting) if (waiter.test(value)) { waiting.delete(waiter); clearTimeout(waiter.timeout); waiter.resolve(value); }
  });
  const wait = predicate => {
    const found = queue.find(predicate); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { test: predicate, resolve, timeout: setTimeout(() => { waiting.delete(waiter); reject(new Error('Observer integration response timed out')); }, 2500) };
      waiting.add(waiter);
    });
  };
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const auth = () => ws.send(JSON.stringify({ type: 'observer.auth', token: credential, roomId }));
  if (authenticate) { auth(); await wait(value => value.type === 'observer.auth.ok'); }
  return { ws, queue, wait, auth };
}

test('actual SQLite server publishes committed observer state and restores operator/host observation after restart', async t => {
  const dbPath = await database(t);
  let app = createDemoServer({ dbPath, observerToken: OPERATOR });
  let address = await app.listen(0); let request = requests(address.port);
  const state = await seed(request); const clients = [];
  try {
    const list = await request('/api/observer/rooms', undefined, OPERATOR, 'GET');
    assert.equal(list.status, 200); assert.equal(list.body.rooms[0].roomId, state.room.roomId);
    const viewer = await observer(address.port, OPERATOR, state.room.roomId); clients.push(viewer);
    await viewer.wait(value => value.type === 'observer.snapshot' && value.room.inventory.supplies === 0);
    assert.equal((await request('/api/world/claim', state.claim, state.phone.token)).body.claimed, true);
    const published = await viewer.wait(value => value.type === 'observer.snapshot' && value.room.inventory.supplies === 1);
    assert.equal(published.room.viewMode, 'SERVER_STATE_NOT_SCREEN_CAPTURE');
    const inspection = createStateStore(dbPath);
    try { assert.equal(inspection.load().rooms[0].collection.inventory.supplies, 1); }
    finally { inspection.close(); }
    for (const value of [published, list.body]) {
      const encoded = JSON.stringify(value);
      for (const secret of [state.host.token, state.phone.token, state.room.joinCode, state.phone.sessionId, '37.5665', '126.978']) assert.equal(encoded.includes(secret), false);
    }
    viewer.ws.terminate(); await app.close();
    app = createDemoServer({ dbPath, observerToken: OPERATOR }); address = await app.listen(0); request = requests(address.port);
    const restored = await request('/api/observer/rooms', undefined, OPERATOR, 'GET');
    assert.equal(restored.body.rooms[0].supplies, 1); assert.equal(restored.body.rooms[0].playAllowed, false);
    assert.equal(restored.body.rooms[0].connectedCount, 0);
    const operator = await observer(address.port, OPERATOR, state.room.roomId); clients.push(operator);
    const host = await observer(address.port, state.host.token, state.room.roomId); clients.push(host);
    assert.equal((await host.wait(value => value.type === 'observer.auth.ok')).authorization, 'ROOM_HOST');
    assert.equal((await operator.wait(value => value.type === 'observer.snapshot')).room.inventory.supplies, 1);
    assert.equal((await host.wait(value => value.type === 'observer.snapshot')).room.vehicle.playAllowed, false);
    assert.equal((await request('/api/world/claim', state.claim, state.phone.token)).body.replayed, true);
  } finally { for (const client of clients) client.ws.terminate(); await app.close(); }
});

test('actual DB write failure exposes no uncommitted reward to existing, pre-auth or new observers', async t => {
  const dbPath = await database(t);
  const backing = createStateStore(dbPath); let reject = false;
  const stateStore = { ...backing, save(value) { if (reject) throw new Error('injected storage failure'); backing.save(value); } };
  let app = createDemoServer({ stateStore, observerToken: OPERATOR });
  let address = await app.listen(0); let request = requests(address.port);
  const state = await seed(request); const clients = [];
  try {
    const viewer = await observer(address.port, OPERATOR, state.room.roomId); clients.push(viewer);
    const preauth = await observer(address.port, OPERATOR, state.room.roomId, false); clients.push(preauth);
    await viewer.wait(value => value.type === 'observer.snapshot' && value.room.inventory.supplies === 0);
    reject = true;
    const claim = await request('/api/world/claim', state.claim, state.phone.token);
    assert.equal(claim.status, 503); assert.equal(claim.body.error.code, 'STORAGE_UNAVAILABLE');
    const denied = await request('/api/observer/rooms', undefined, OPERATOR, 'GET');
    assert.equal(denied.status, 503); assert.equal(denied.body.error.code, 'STORAGE_UNAVAILABLE');
    preauth.auth();
    assert.equal((await preauth.wait(value => value.type === 'observer.error')).error.code, 'ROOM_NOT_FOUND');
    assert.equal(preauth.queue.some(value => value.type === 'observer.snapshot'), false);
    assert.equal(viewer.queue.some(value => value.type === 'observer.snapshot' && value.room.inventory.supplies !== 0), false);
    const deniedSocket = new WebSocket(`ws://127.0.0.1:${address.port}/observer/ws`);
    deniedSocket.on('error', () => {});
    const status = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Expected failed upgrade')), 2000);
      deniedSocket.once('unexpected-response', (_, response) => { clearTimeout(timeout); resolve(response.statusCode); });
      deniedSocket.once('open', () => { clearTimeout(timeout); reject(new Error('Upgrade unexpectedly allowed')); });
    });
    deniedSocket.terminate(); assert.equal(status, 503);
    for (const client of clients) client.ws.terminate(); await app.close();
    app = createDemoServer({ dbPath, observerToken: OPERATOR }); address = await app.listen(0); request = requests(address.port);
    const committed = await request('/api/observer/rooms', undefined, OPERATOR, 'GET');
    assert.equal(committed.status, 200); assert.equal(committed.body.rooms[0].supplies, 0);
  } finally { for (const client of clients) client.ws.terminate(); await app.close(); }
});
