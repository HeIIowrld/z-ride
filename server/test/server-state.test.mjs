import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createDemoServer } from '../server.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(15); }
  throw new Error('Timeout: ' + message);
}
async function fixture(t, options = {}) {
  const clients = [];
  const agent = new http.Agent({ keepAlive: true });
  let app = createDemoServer({ leaseMs: 60000, ...options });
  let address = await app.listen(0);
  t.after(async () => { agent.destroy(); for (const client of clients) client.ws.terminate(); await app.close(); });
  async function api(path, body, token, method = 'POST') {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = http.request(`http://127.0.0.1:${address.port}${path}`, {
        method, agent, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}),
          ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }) },
      }, response => {
        let output = ''; response.setEncoding('utf8'); response.on('data', chunk => { output += chunk; });
        response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(output) }); } catch (error) { reject(error); } });
      });
      request.on('error', error => reject(new Error(`${method} ${path} failed`, { cause: error })));
      request.setTimeout(5000, () => request.destroy(new Error('HTTP test request timed out')));
      request.end(payload);
    });
  }
  async function connect(token, roomId) {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`), messages = [];
    const client = { ws, messages, room: null }; clients.push(client);
    ws.on('error', () => {});
    ws.on('message', data => { const value = JSON.parse(data); messages.push(value); if (value.type === 'snapshot') client.room = value.room; });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'auth', token, roomId }));
    client.auth = await until(() => messages.find(value => value.type === 'auth.ok'), 'auth');
    await until(() => client.room, 'snapshot');
    client.send = async body => {
      const message = { commandId: randomUUID(), ...body };
      ws.send(JSON.stringify(message));
      return until(() => messages.find(value => value.type === 'result' && value.commandId === message.commandId), 'command');
    };
    return client;
  }
  const host = (await api('/api/session', { role: 'CAR_HOST', nickname: 'State host' })).body;
  const created = (await api('/api/rooms', {}, host.token)).body;
  let car = await connect(host.token, created.roomId), reportSeq = 0;
  const phones = [];
  for (const [index, seat] of ['REAR_LEFT', 'REAR_RIGHT'].entries()) {
    const phone = (await api('/api/session', { role: 'PHONE', nickname: 'State phone ' + index })).body;
    const invite = index ? (await api('/api/rooms', {}, host.token)).body : created;
    const joined = (await api('/api/join', { joinCode: invite.joinCode, seat }, phone.token)).body;
    assert.equal((await api(`/api/rooms/${created.roomId}/approve`, { memberId: joined.memberId, allowManualUnknown: true }, host.token)).status, 200);
    phones.push({ ...phone, memberId: joined.memberId, seat, client: await connect(phone.token, created.roomId) });
  }
  const base = `/api/rooms/${created.roomId}`;
  const state = async (token = host.token) => (await api(base + '/state', undefined, token, 'GET')).body.room;
  const game = async (operation, fields = {}, token = host.token) => {
    const current = await state(token);
    return api(base + '/game/' + operation, { commandId: randomUUID(), roomEpoch: current.roomEpoch,
      ...(operation !== 'input' ? { expectedGameRevision: current.game.revision } : {}), ...fields }, token);
  };
  async function report(gear = 'P', ux = 'ALLOWED', foreground = true) {
    const result = await car.send({ type: 'vehicle.report', reportSeq: ++reportSeq, ux, gear, foreground,
      seats: phones.map(phone => ({ seat: phone.seat, occupancy: 'OCCUPIED' })), source: 'SIMULATED_API_CLIENTS' });
    assert.equal(result.ok, true, result.error?.code);
  }
  async function start() {
    await report(); const current = await state();
    const result = await car.send({ type: 'command', roomEpoch: current.roomEpoch, action: 'round.start' });
    assert.equal(result.ok, true, result.error?.code);
    await until(async () => (await state()).game.driverSessionId, 'current driver authority');
  }
  return { host, phones, created, base, api, connect, state, game, report, start,
    get car() { return car; },
    async replaceCar() { car = await connect(host.token, created.roomId); reportSeq = 0; return car; },
    async restart() {
      for (const client of clients) client.ws.terminate(); await app.close();
      app = createDemoServer({ leaseMs: 60000, ...options }); address = await app.listen(0);
    },
  };
}

test('scenario catalog and composite state enforce membership while hiding driver authority and pending crew', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/scenarios', undefined, undefined, 'GET')).status, 401);
  const catalog = await f.api('/api/scenarios', undefined, f.phones[0].token, 'GET');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.scenarios.map(item => item.scenarioId), ['generic-coop-v1', 'heist-demo-v1']);
  const outsider = (await f.api('/api/session', { role: 'PHONE', nickname: 'Pending state phone' })).body;
  assert.equal((await f.api(f.base + '/state', undefined, outsider.token, 'GET')).status, 403);
  const invite = (await f.api('/api/rooms', {}, f.host.token)).body;
  const joined = (await f.api('/api/join', { joinCode: invite.joinCode, seat: 'FRONT_PASSENGER' }, outsider.token)).body;
  assert.equal((await f.api(f.base + '/state', undefined, outsider.token, 'GET')).status, 403);
  const pending = (await f.api(f.base, undefined, outsider.token, 'GET')).body.room;
  assert.equal(pending.game, undefined); assert.equal(pending.cabin, undefined);
  await f.start();
  const host = await f.state(), phone = await f.state(f.phones[0].token);
  assert.ok(host.game.driverSessionId); assert.equal(phone.game.driverSessionId, null);
  assert.equal(phone.members.some(member => member.memberId === joined.memberId), false);
  assert.equal(phone.cabin.derived.crew.some(member => member.memberId === joined.memberId), false);
  assert.equal(host.game.scenarioId, 'generic-coop-v1');
  assert.equal(host.cabin.hardwareAttested, false);
});

test('heist objectives and distinct phone contributions advance only through server-owned conditions', async t => {
  const f = await fixture(t);
  assert.equal((await f.game('configure', { scenarioId: 'heist-demo-v1' }, f.phones[0].token)).status, 403);
  const configured = await f.game('configure', { scenarioId: 'heist-demo-v1' });
  assert.equal(configured.status, 200); assert.equal(configured.body.room.game.stageId, 'PREPARE');
  await f.start();
  assert.equal((await f.game('configure', { scenarioId: 'generic-coop-v1' })).status, 409);
  assert.equal((await f.game('advance')).status, 409);
  for (const phone of f.phones) {
    const current = await f.state(phone.token);
    const collected = await phone.client.send({ type: 'command', roomEpoch: current.roomEpoch,
      action: 'mobile.collect', pickupId: 'DEMO_PICKUP_A', passengerConfirmed: true });
    assert.equal(collected.ok, true);
  }
  const advance = await f.game('advance');
  assert.equal(advance.status, 200); assert.equal(advance.body.room.game.stageId, 'INFILTRATE');
  const first = await f.game('interact', { objectiveId: 'TERMINALS', action: 'INTERACT' }, f.phones[0].token);
  assert.equal(first.status, 200); assert.equal(first.body.room.game.objectives[0].progress, 1);
  assert.equal((await f.game('interact', { objectiveId: 'TERMINALS', action: 'INTERACT' }, f.phones[0].token)).status, 409);
  assert.equal((await f.game('advance')).status, 409);
  const second = await f.game('interact', { objectiveId: 'TERMINALS', action: 'INTERACT' }, f.phones[1].token);
  assert.equal(second.status, 200); assert.equal(second.body.room.game.objectives[0].complete, true);
  const defend = await f.game('advance');
  assert.equal(defend.status, 200); assert.equal(defend.body.room.game.stageId, 'DEFEND');
  assert.equal(defend.body.room.stats.waveCleared, false);
  assert.equal((await f.game('advance')).status, 409, 'clients cannot skip the server combat objective');
  for (const [phone, angles] of [[f.phones[0], [-100]], [f.phones[1], [60, 140]]]) {
    for (const angleDeg of angles) for (let count = 0; count < 5; count++) {
      const current = await f.state(phone.token);
      const result = await phone.client.send({ type: 'command', roomEpoch: current.roomEpoch, action: 'fire', angleDeg });
      assert.equal(result.ok, true, result.error?.code); await delay(130);
    }
  }
  const afterDefense = await f.state();
  assert.equal(afterDefense.stats.waveCleared, true);
  assert.equal(afterDefense.state, 'PLAYING', 'heist defense does not prematurely end the room');
  const extract = await f.game('advance');
  assert.equal(extract.status, 200); assert.equal(extract.body.room.game.stageId, 'EXTRACT');
  assert.equal(extract.body.room.game.drivable, true);
  assert.equal((await f.game('advance')).status, 409, 'client cannot claim extraction distance');
});

test('heist start requires connected non-empty seats that cover every remaining defense target', async t => {
  const f = await fixture(t);
  assert.equal((await f.game('configure', { scenarioId: 'heist-demo-v1' })).status, 200);
  await f.report();
  async function assign(phone, seat) {
    assert.equal((await f.api(f.base + '/approve', { memberId: phone.memberId, seat, allowManualUnknown: true }, f.host.token)).status, 200);
  }
  async function expectMissingCrew() {
    const current = await f.state();
    const result = await f.car.send({ type: 'command', roomEpoch: current.roomEpoch, action: 'round.start' });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'HEIST_CREW_REQUIRED');
    assert.equal((await f.state()).state, 'READY');
  }
  await assign(f.phones[0], 'FRONT_PASSENGER');
  await expectMissingCrew(); // FRONT + REAR_RIGHT cannot cover -100 degrees.
  await assign(f.phones[0], 'REAR_LEFT');
  await assign(f.phones[1], 'FRONT_PASSENGER');
  await expectMissingCrew(); // REAR_LEFT + FRONT cannot cover 140 degrees.
  await assign(f.phones[1], 'REAR_RIGHT');
  f.phones[1].client.ws.close();
  await until(async () => !(await f.state()).members.find(member => member.memberId === f.phones[1].memberId).connected, 'rear-right phone disconnected');
  await expectMissingCrew();
  f.phones[1].client = await f.connect(f.phones[1].token, f.created.roomId);
  assert.equal((await f.car.send({ type: 'vehicle.report', ux: 'ALLOWED', gear: 'P', foreground: true,
    seats: [{ seat: 'REAR_LEFT', occupancy: 'OCCUPIED' }, { seat: 'REAR_RIGHT', occupancy: 'EMPTY' }], source: 'SIMULATED' })).ok, true);
  await expectMissingCrew();
  await f.start();
  assert.equal((await f.state()).state, 'PLAYING', 'both approved rear phones can start when present and connected');
});

test('driver inputs are session ordered, server simulated and cleared by pause and restart', async t => {
  let saved, clock = 1000000;
  const store = { load: () => saved ? structuredClone(saved) : null, save: value => { saved = structuredClone(value); }, close() {} };
  const f = await fixture(t, { gameClock: () => clock, stateStore: store });
  await f.start(); const current = await f.state();
  const input = { driverSessionId: current.game.driverSessionId, inputSeq: 1, throttle: 1, brake: 0 };
  assert.equal((await f.game('input', input, f.phones[0].token)).status, 403);
  assert.equal((await f.game('input', input)).status, 200);
  assert.equal((await f.game('input', input)).status, 409);
  clock += 250;
  await until(async () => (await f.state()).game.distanceM > 0, 'server tick moved virtual vehicle');
  const moving = await f.state();
  assert.ok(moving.game.virtualSpeedMps > 0); assert.ok(moving.game.virtualSpeedMps <= 30);
  const drivenDistance = moving.game.distanceM, oldSession = moving.game.driverSessionId;
  const pause = await f.car.send({ type: 'command', commandId: randomUUID(), roomEpoch: moving.roomEpoch, action: 'round.pause' });
  assert.equal(pause.ok, true); assert.equal((await f.state()).game.virtualSpeedMps, 0);
  await f.start(); const resumed = await f.state();
  assert.notEqual(resumed.game.driverSessionId, oldSession);
  assert.equal((await f.game('input', { ...input, inputSeq: 2 })).status, 409);
  await f.restart(); clock += 500000;
  const restored = await f.state();
  assert.equal(restored.state, 'PAUSED'); assert.equal(restored.game.virtualSpeedMps, 0);
  assert.equal(restored.game.driverSessionId, null); assert.equal(restored.game.driverControl.inputFresh, false);
  assert.equal(restored.game.distanceM, drivenDistance, 'restart never credits offline virtual distance');
  assert.equal(JSON.stringify(saved).includes(oldSession), false, 'driver authority is not serialized anywhere');
});

test('cabin reports preserve false versus UNKNOWN and stale cached samples do not grant current protection', async t => {
  let clock = 2000000;
  const f = await fixture(t, { cabinClock: () => clock });
  await f.start();
  const sample = { type: 'vehicle.cabin.report', vehicleConnectionId: f.car.auth.vehicleConnectionId, reportSeq: 1,
    hvac: { sampleSeq: 1, availability: 'AVAILABLE', source: 'SIMULATED', measuredAgeMs: 0,
      areaId: '[ROW_1_LEFT, ROW_1_RIGHT]', power: true, fanSpeed: 4, fanMin: 0, fanMax: 8 },
    seatBelts: [{ seat: 'REAR_LEFT', sampleSeq: 1, availability: 'AVAILABLE', source: 'SIMULATED', measuredAgeMs: 0, buckled: true },
      { seat: 'REAR_RIGHT', sampleSeq: 1, availability: 'AVAILABLE', source: 'SIMULATED', measuredAgeMs: 0, buckled: false }] };
  const forged = await f.phones[0].client.send(sample);
  assert.equal(forged.ok, false); assert.equal(forged.error.code, 'ROLE_FORBIDDEN');
  assert.equal((await f.car.send(sample)).ok, true);
  const fresh = await f.state();
  assert.equal(fresh.cabin.hvac.quality, 'FRESH'); assert.equal(fresh.cabin.derived.fanInput01, .5);
  assert.equal(fresh.cabin.derived.crew.find(member => member.memberId === f.phones[0].memberId).beltProtection, true);
  assert.equal(fresh.cabin.seatBelts.find(item => item.seat === 'REAR_RIGHT').buckled, false);
  assert.equal(fresh.cabin.seatBelts.find(item => item.seat === 'DRIVER').buckled, null);
  clock += 6001;
  await until(async () => (await f.state()).cabin.hvac.quality === 'STALE', 'cabin observation expired');
  assert.equal((await f.car.send({ ...sample, reportSeq: 2 })).ok, true, 'same semantic sample may be cached');
  const cached = await f.state();
  assert.equal(cached.cabin.hvac.quality, 'STALE'); assert.equal(cached.cabin.derived.fanInput01, 0);
  assert.equal(cached.cabin.derived.crew.find(member => member.memberId === f.phones[0].memberId).beltProtection, false);
  const conflict = await f.car.send({ ...sample, reportSeq: 3, hvac: { ...sample.hvac, fanSpeed: 5 } });
  assert.equal(conflict.ok, false); assert.equal(conflict.error.code, 'CABIN_SAMPLE_CONFLICT');
  await f.replaceCar(); await f.report();
  const replaced = await f.state();
  assert.equal(replaced.cabin.hvac.quality, 'UNKNOWN'); assert.equal(replaced.cabin.derived.purificationInputEligible, false);
});

test('logical mission contributions and receipts survive restart without reviving cabin or driver authority', async t => {
  let saved;
  const store = { load: () => saved ? structuredClone(saved) : null, save: value => { saved = structuredClone(value); }, close() {} };
  const f = await fixture(t, { stateStore: store });
  assert.equal((await f.game('configure', { scenarioId: 'heist-demo-v1' })).status, 200);
  await f.start();
  assert.equal((await f.car.send({ type: 'vehicle.cabin.report', vehicleConnectionId: f.car.auth.vehicleConnectionId, reportSeq: 1,
    energy: { sampleSeq: 1, availability: 'AVAILABLE', source: 'SIMULATED', measuredAgeMs: 0, socPercent: 67 } })).ok, true);
  for (const phone of f.phones) {
    const current = await f.state(phone.token);
    assert.equal((await phone.client.send({ type: 'command', roomEpoch: current.roomEpoch, action: 'mobile.collect',
      pickupId: 'DEMO_PICKUP_A', passengerConfirmed: true })).ok, true);
  }
  assert.equal((await f.game('advance')).body.room.game.stageId, 'INFILTRATE');
  const current = await f.state(f.phones[0].token);
  const body = { commandId: randomUUID(), roomEpoch: current.roomEpoch, expectedGameRevision: current.game.revision,
    objectiveId: 'TERMINALS', action: 'INTERACT' };
  const accepted = await f.api(f.base + '/game/interact', body, f.phones[0].token);
  assert.equal(accepted.status, 200); assert.equal(accepted.body.room.game.objectives[0].progress, 1);
  const missionRunId = accepted.body.room.game.missionRunId;
  assert.equal(accepted.body.data.driverSessionId, undefined, 'logical receipts never contain driver authority');
  await f.restart();
  const restored = await f.state();
  assert.equal(restored.state, 'PAUSED'); assert.equal(restored.game.missionRunId, missionRunId);
  assert.equal(restored.game.stageId, 'INFILTRATE'); assert.equal(restored.game.objectives[0].progress, 1);
  assert.equal(restored.game.driverSessionId, null); assert.equal(restored.cabin.energy.quality, 'UNKNOWN');
  const replay = await f.api(f.base + '/game/interact', body, f.phones[0].token);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.data, accepted.body.data);
  assert.equal(replay.body.room.game.objectives[0].progress, 1, 'replay acknowledges one contribution without granting a second');
});

test('a failed game-state commit publishes no successful stage transition and restores the last logical checkpoint', async t => {
  let saved, fail = false;
  const store = { load: () => saved ? structuredClone(saved) : null,
    save: value => { if (fail) throw new Error('Injected state save failure'); saved = structuredClone(value); }, close() {} };
  const f = await fixture(t, { stateStore: store });
  assert.equal((await f.game('configure', { scenarioId: 'heist-demo-v1' })).status, 200);
  await f.start();
  for (const phone of f.phones) {
    const current = await f.state(phone.token);
    assert.equal((await phone.client.send({ type: 'command', roomEpoch: current.roomEpoch, action: 'mobile.collect',
      pickupId: 'DEMO_PICKUP_A', passengerConfirmed: true })).ok, true);
  }
  const current = await f.state();
  assert.equal(current.game.objectives[0].complete, true);
  const body = { commandId: randomUUID(), roomEpoch: current.roomEpoch, expectedGameRevision: current.game.revision };
  const before = f.car.messages.length;
  fail = true;
  const rejected = await f.api(f.base + '/game/advance', body, f.host.token);
  assert.equal(rejected.status, 503); assert.equal(rejected.body.error.code, 'STORAGE_UNAVAILABLE');
  assert.equal(f.car.messages.slice(before).some(message => message.type === 'snapshot' && message.room.game.stageId === 'INFILTRATE'), false);
  assert.equal((await f.api(f.base + '/state', undefined, f.host.token, 'GET')).status, 503);
  fail = false; await f.restart();
  const restored = await f.state();
  assert.equal(restored.game.stageId, 'PREPARE'); assert.equal(restored.game.objectives[0].complete, true);
  assert.equal(restored.collection.inventory.supplies, 2);
});

test('room creation consumes optional bounded JSON before closing the HTTP connection', async t => {
  const app = createDemoServer(); const address = await app.listen(0);
  t.after(() => app.close());
  function raw(path, payload, token, chunked = false) {
    return new Promise((resolve, reject) => {
      const request = http.request(`http://127.0.0.1:${address.port}${path}`, {
        method: 'POST', agent: false, headers: { connection: 'close', 'content-type': 'application/json',
          ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': Buffer.byteLength(payload) }),
          ...(token ? { authorization: 'Bearer ' + token } : {}) },
      }, response => { let output = ''; response.setEncoding('utf8'); response.on('data', chunk => { output += chunk; });
        response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(output) }); } catch (error) { reject(error); } }); });
      request.on('error', error => reject(new Error(`POST ${path} (${Buffer.byteLength(payload)} body bytes) failed`, { cause: error })));
      request.end(payload);
    });
  }
  const host = await raw('/api/session', JSON.stringify({ role: 'CAR_HOST', nickname: 'Close transport host' }));
  assert.equal(host.status, 201);
  const first = await raw('/api/rooms', '{}', host.body.token); assert.equal(first.status, 201);
  const empty = await raw('/api/rooms', '', host.body.token); assert.equal(empty.status, 200);
  assert.equal(empty.body.roomId, first.body.roomId);
  const invalid = await raw('/api/rooms', '{', host.body.token);
  assert.equal(invalid.status, 400); assert.equal(invalid.body.error.code, 'INVALID_JSON');
  assert.equal((await raw('/api/rooms', '[]', host.body.token)).status, 400);
  const oversized = await raw('/api/rooms', JSON.stringify({ ignored: 'a'.repeat(17000) }), host.body.token);
  assert.equal(oversized.status, 413); assert.equal(oversized.body.error.code, 'PAYLOAD_TOO_LARGE');
  const oversizedChunked = await raw('/api/rooms', JSON.stringify({ ignored: 'b'.repeat(17000) }), host.body.token, true);
  assert.equal(oversizedChunked.status, 413); assert.equal(oversizedChunked.body.error.code, 'PAYLOAD_TOO_LARGE');
});
