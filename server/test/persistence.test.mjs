import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { WebSocket } from 'ws';
import { createDemoServer } from '../server.mjs';
import { createStateStore } from '../state-store.mjs';

async function temporaryDatabase(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zride-persistence-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('zride-persistence-'));
    await rm(directory, { recursive: true, force: true });
  });
  return join(directory, 'state.sqlite');
}
function apiFor(port) {
  return async (path, body, token, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}
async function setup(request) {
  const host = (await request('/api/session', { role: 'CAR_HOST', nickname: 'Persistent host' })).body;
  const phone = (await request('/api/session', { role: 'PHONE', nickname: 'Persistent phone' })).body;
  const room = (await request('/api/rooms', {}, host.token)).body;
  const member = (await request('/api/join', { joinCode: room.joinCode, seat: 'FRONT_PASSENGER' }, phone.token)).body;
  assert.equal((await request(`/api/rooms/${room.roomId}/approve`, { memberId: member.memberId }, host.token)).status, 200);
  const nearby = (await request('/api/world/nearby', { latitude: 37.5665, longitude: 126.978, radiusM: 500 }, phone.token)).body;
  const spawn = nearby.spawns[0];
  const claim = { commandId: randomUUID(), spawnId: spawn.spawnId, scheduleId: nearby.scheduleId, version: spawn.version, spawnCycleId: spawn.spawnCycleId,
    passengerConfirmed: true, location: { latitude: spawn.latitude, longitude: spawn.longitude, accuracyM: 5,
      measuredAgeMs: 0, source: 'EMULATOR_GPS', isMock: false } };
  return { host, phone, room, member, claim };
}
async function connect(port, credential, roomId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = [];
  const waiters = new Set();
  ws.on('error', () => {});
  ws.on('message', bytes => {
    const value = JSON.parse(bytes); messages.push(value);
    for (const waiter of waiters) if (waiter.check(value)) { waiters.delete(waiter); clearTimeout(waiter.timeout); waiter.resolve(value); }
  });
  const wait = check => {
    const old = messages.find(check);
    if (old) return Promise.resolve(old);
    return new Promise((resolve, reject) => {
      const waiter = { check, resolve, timeout: setTimeout(() => { waiters.delete(waiter); reject(new Error('WS response timed out')); }, 3000) };
      waiters.add(waiter);
    });
  };
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'auth', token: credential, roomId }));
  await wait(value => value.type === 'auth.ok');
  return { ws, messages, async send(message) {
    const result = wait(value => value.type === 'result' && value.commandId === message.commandId);
    ws.send(JSON.stringify(message)); return result;
  } };
}
const command = (action, roomEpoch, fields = {}) => ({ type: 'command', commandId: randomUUID(), action, roomEpoch, ...fields });
const report = () => ({ type: 'vehicle.report', commandId: randomUUID(), reportSeq: 1, ux: 'ALLOWED', gear: 'P', foreground: true, seats: [] });

test('SQLite restores room, inventory, approvals and idempotency without restoring a vehicle lease', async t => {
  const dbPath = await temporaryDatabase(t);
  let app = createDemoServer({ dbPath, leaseMs: 60000 });
  let address = await app.listen(0); let request = apiFor(address.port);
  const state = await setup(request);
  let car; let phone;
  try {
    car = await connect(address.port, state.host.token, state.room.roomId);
    phone = await connect(address.port, state.phone.token, state.room.roomId);
    await car.send(report());
    let snapshot = (await request(`/api/rooms/${state.room.roomId}`, undefined, state.host.token, 'GET')).body.room;
    await car.send(command('round.start', snapshot.roomEpoch));
    const fixture = command('mobile.collect', 0, { pickupId: 'DEMO_PICKUP_A', passengerConfirmed: true });
    assert.equal((await phone.send(fixture)).ok, true);
    const fixtureB = command('mobile.collect', 0, { pickupId: 'DEMO_PICKUP_B', passengerConfirmed: true });
    await phone.send(fixtureB);
    snapshot = (await request(`/api/rooms/${state.room.roomId}`, undefined, state.host.token, 'GET')).body.room;
    const support = command('support.pulse', snapshot.roomEpoch);
    const supported = await car.send(support);
    assert.equal(supported.data.inventory.supplies, 1);
    await phone.send(command('fire', snapshot.roomEpoch, { angleDeg: 60 }));
    assert.equal((await request('/api/world/claim', state.claim, state.phone.token)).body.inventory.supplies, 2);
    car.ws.terminate(); phone.ws.terminate(); await app.close();

    app = createDemoServer({ dbPath, leaseMs: 60000 });
    address = await app.listen(0); request = apiFor(address.port);
    snapshot = (await request(`/api/rooms/${state.room.roomId}`, undefined, state.host.token, 'GET')).body.room;
    assert.equal(snapshot.roomId, state.room.roomId);
    assert.equal(snapshot.collection.inventory.supplies, 2);
    assert.equal(snapshot.members.find(m => m.memberId === state.member.memberId).approved, true);
    assert.equal(snapshot.members.every(m => !m.connected), true);
    assert.equal(snapshot.state, 'PAUSED'); assert.equal(snapshot.pauseReason, 'SERVER_RESTART');
    assert.equal(snapshot.vehicle.gear, 'UNKNOWN'); assert.equal(snapshot.vehicle.ux, 'UNKNOWN');
    assert.equal(snapshot.vehicle.foreground, false); assert.equal(snapshot.vehicle.playAllowed, false);
    assert.equal(snapshot.stats.supportUntil, 0); assert.equal(snapshot.stats.shots, 1);
    assert.equal(snapshot.zombies.find(z => z.id === 'zombie_front').hp, 2);
    assert.equal((await request('/api/world/claim', state.claim, state.phone.token)).body.replayed, true);
    assert.equal((await request('/api/world/claim', { ...state.claim, commandId: randomUUID() }, state.phone.token)).body.error.code, 'ALREADY_CLAIMED');
    phone = await connect(address.port, state.phone.token, state.room.roomId);
    car = await connect(address.port, state.host.token, state.room.roomId);
    // Old success receipts are returned without replaying inventory effects.
    assert.equal((await phone.send(fixture)).ok, true);
    assert.equal((await car.send(support)).ok, true);
    assert.equal((await phone.send({ ...fixture, commandId: randomUUID() })).error.code, 'ALREADY_COLLECTED');
    snapshot = (await request(`/api/rooms/${state.room.roomId}`, undefined, state.host.token, 'GET')).body.room;
    assert.equal(snapshot.collection.inventory.supplies, 2);
    assert.equal(snapshot.vehicle.playAllowed, false);
    assert.equal((await car.send(command('round.start', snapshot.roomEpoch))).error.code, 'GATE_CLOSED');
    await car.send(report());
    snapshot = (await request(`/api/rooms/${state.room.roomId}`, undefined, state.host.token, 'GET')).body.room;
    assert.equal(snapshot.state, 'PAUSED');
    assert.equal((await car.send(command('round.start', snapshot.roomEpoch))).ok, true);
    const dbFiles = [await readFile(dbPath), await readFile(dbPath + '-wal').catch(() => Buffer.alloc(0))];
    for (const bytes of dbFiles) {
      assert.equal(bytes.includes(Buffer.from(state.host.token)), false);
      assert.equal(bytes.includes(Buffer.from(state.phone.token)), false);
      assert.equal(bytes.includes(Buffer.from('37.5665')), false);
      assert.equal(bytes.includes(Buffer.from('126.978')), false);
    }
  } finally { car?.ws.terminate(); phone?.ws.terminate(); await app.close(); }
});

test('failed SQLite save sends no success or inventory broadcast and restores last committed reward state', async t => {
  const dbPath = await temporaryDatabase(t);
  const backing = createStateStore(dbPath); let rejectSave = false;
  const stateStore = { ...backing, save(state) { if (rejectSave) throw new Error('injected disk failure'); backing.save(state); } };
  let app = createDemoServer({ stateStore }); let address = await app.listen(0); let request = apiFor(address.port);
  const state = await setup(request);
  const car = await connect(address.port, state.host.token, state.room.roomId);
  const phone = await connect(address.port, state.phone.token, state.room.roomId);
  try {
    rejectSave = true;
    const failed = await request('/api/world/claim', state.claim, state.phone.token);
    assert.equal(failed.status, 503); assert.equal(failed.body.error.code, 'STORAGE_UNAVAILABLE');
    assert.equal((await request('/healthz', undefined, undefined, 'GET')).status, 503);
    assert.equal(car.messages.some(m => m.type === 'snapshot' && m.room.collection.inventory.supplies > 0), false);
    await app.close();
    app = createDemoServer({ dbPath }); address = await app.listen(0); request = apiFor(address.port);
    const restored = (await request(`/api/rooms/${state.room.roomId}`, undefined, state.host.token, 'GET')).body.room;
    assert.equal(restored.collection.inventory.supplies, 0);
    assert.equal((await request('/api/world/claim', state.claim, state.phone.token)).body.inventory.supplies, 1);
  } finally { car.ws.terminate(); phone.ws.terminate(); await app.close(); }
});

async function childServer(dbPath) {
  const child = fork(new URL('./fixtures/persistent-server.mjs', import.meta.url), [dbPath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.resume();
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Persistent child start timed out')); }, 7000);
    child.once('message', value => { clearTimeout(timeout); resolve(value); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('Persistent child exited before ready: ' + code)); });
  });
  return { child, port: ready.port, async kill() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  } };
}

test('acknowledged inventory and claim survive abrupt process termination', async t => {
  const dbPath = await temporaryDatabase(t);
  let process = await childServer(dbPath);
  try {
    let request = apiFor(process.port); const state = await setup(request);
    assert.equal((await request('/api/world/claim', state.claim, state.phone.token)).body.claimed, true);
    await process.kill(); // No close(), checkpoint or graceful shutdown handler runs.
    process = await childServer(dbPath); request = apiFor(process.port);
    const restored = (await request(`/api/rooms/${state.room.roomId}`, undefined, state.host.token, 'GET')).body.room;
    assert.equal(restored.collection.inventory.supplies, 1);
    assert.equal(restored.roomId, state.room.roomId); assert.equal(restored.vehicle.playAllowed, false);
    assert.equal((await request('/api/world/claim', state.claim, state.phone.token)).body.replayed, true);
    assert.equal((await request('/api/world/claim', { ...state.claim, commandId: randomUUID() }, state.phone.token)).body.error.code, 'ALREADY_CLAIMED');
  } finally { await process.kill(); }
});
