import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createDemoServer } from '../server.mjs';

const OPERATOR = 'effects-test-operator-fixture';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = (roomEpoch, action, fields = {}) => ({ type: 'command', commandId: randomUUID(), roomEpoch, action, ...fields });

async function fixture(t, options = {}) {
  const clients = [];
  let app = createDemoServer({ leaseMs: 60000, observerToken: OPERATOR, ...options });
  let address = await app.listen(0);
  t.after(async () => { for (const client of clients) client.ws.terminate(); await app.close(); });
  async function api(path, body, token, method = 'POST') {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  async function connect(token, roomId, observer = false) {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}${observer ? '/observer/ws' : '/ws'}`);
    const messages = [], pending = new Set();
    ws.on('error', () => {});
    ws.on('message', bytes => {
      const value = JSON.parse(bytes); messages.push(value);
      for (const waiter of [...pending]) if (waiter.predicate(value)) {
        pending.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(value);
      }
    });
    const wait = predicate => {
      const found = messages.find(predicate); if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => { pending.delete(waiter); reject(new Error('Effects WebSocket response timed out')); }, 3000) };
        pending.add(waiter);
      });
    };
    const client = { ws, messages, wait, async send(body) {
      const result = wait(value => value.type === 'result' && value.commandId === body.commandId);
      ws.send(JSON.stringify(body)); return result;
    } };
    clients.push(client);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: observer ? 'observer.auth' : 'auth', token, roomId }));
    client.auth = await wait(value => value.type === (observer ? 'observer.auth.ok' : 'auth.ok'));
    return client;
  }
  const host = (await api('/api/session', { role: 'CAR_HOST', nickname: '4D host' })).body;
  const phone = (await api('/api/session', { role: 'PHONE', nickname: '4D passenger' })).body;
  const room = (await api('/api/rooms', {}, host.token)).body;
  const joined = (await api('/api/join', { joinCode: room.joinCode, seat: 'FRONT_PASSENGER' }, phone.token)).body;
  assert.equal((await api(`/api/rooms/${room.roomId}/approve`, { memberId: joined.memberId }, host.token)).status, 200);
  let car = await connect(host.token, room.roomId);
  let passenger = await connect(phone.token, room.roomId);
  let reportSeq = 0;
  const snapshot = async () => (await api(`/api/rooms/${room.roomId}`, undefined, host.token, 'GET')).body.room;
  const effectPath = `/api/rooms/${room.roomId}/effects`;
  const effects = async token => api(effectPath, undefined, token ?? host.token, 'GET');
  const post = async (suffix, body = {}, token = host.token) => {
    const input = { commandId: randomUUID(), ...body };
    if ((suffix === 'session' && input.enabled === true && (!Object.hasOwn(input, 'vehicleConnectionId') || !Object.hasOwn(input, 'expectedControlVersion')))
        || (['scene', 'cue'].includes(suffix) && !Object.hasOwn(input, 'effectSessionId'))) {
      const current = (await effects()).body.effects;
      if (suffix === 'session') {
        if (!Object.hasOwn(input, 'vehicleConnectionId')) input.vehicleConnectionId = car.auth.vehicleConnectionId;
        if (!Object.hasOwn(input, 'expectedControlVersion')) input.expectedControlVersion = current.controlVersion;
      } else if (!Object.hasOwn(input, 'effectSessionId')) input.effectSessionId = current.effectSessionId ?? randomUUID();
    }
    return api(effectPath + '/' + suffix, input, token);
  };
  async function report(gear = 'P', ux = 'ALLOWED', foreground = true) {
    return car.send({ type: 'vehicle.report', commandId: randomUUID(), reportSeq: ++reportSeq, gear, ux, foreground,
      seats: [{ seat: 'FRONT_PASSENGER', occupancy: 'UNKNOWN' }], source: 'SIMULATED_API_CLIENTS' });
  }
  async function start() { await report(); const current = await snapshot(); assert.equal((await car.send(command(current.roomEpoch, 'round.start'))).ok, true); }
  const enable = (fields = {}) => post('session', { enabled: true, locallyEnabled: true, channels: ['AIRFLOW', 'AMBIENT', 'AUDIO'], maxIntensity01: 0.6, ...fields });
  await start();
  return { host, phone, room, api, snapshot, effects, post, enable, report, start, connect,
    get passenger() { return passenger; },
    get car() { return car; },
    async replaceCar() { car = await connect(host.token, room.roomId); reportSeq = 0; return car; },
    async restart() {
      for (const client of clients) client.ws.terminate(); await app.close();
      app = createDemoServer({ leaseMs: 60000, observerToken: OPERATOR, ...options }); address = await app.listen(0);
      passenger = await connect(phone.token, room.roomId);
      return app;
    },
  };
}

test('4D routes require the host opt-in and emit capped wind intents only to the current vehicle', async t => {
  const f = await fixture(t);
  assert.equal((await f.api(`/api/rooms/${f.room.roomId}/effects`, undefined, undefined, 'GET')).status, 401);
  const stranger = (await f.api('/api/session', { role: 'CAR_HOST', nickname: 'Other host' })).body;
  assert.equal((await f.post('session', { enabled: true, locallyEnabled: true, channels: ['AIRFLOW'], maxIntensity01: 0.5 }, stranger.token)).status, 403);
  assert.equal((await f.post('scene', { sceneId: 'escape-01', virtualSpeedMps: 15 })).status, 409);
  const localOptOut = await f.enable({ locallyEnabled: false });
  assert.equal(localOptOut.status, 409); assert.equal(localOptOut.body.error.code, 'EFFECT_LOCAL_OPT_IN_REQUIRED');
  assert.equal((await f.post('session', { enabled: true, locallyEnabled: true, channels: ['AIRFLOW'], maxIntensity01: 0.5 }, f.phone.token)).status, 403);
  assert.equal((await f.post('session', { enabled: true, locallyEnabled: true, channels: ['AIRFLOW'], maxIntensity01: 0.5 }, OPERATOR)).status, 401);
  assert.equal((await f.enable({ channels: ['ARBITRARY_SDK_SETTER'] })).status, 400);
  const enabled = await f.enable({ maxIntensity01: 0.4 }); assert.equal(enabled.status, 200);
  const scene = { commandId: randomUUID(), sceneId: 'escape-01', virtualSpeedMps: 30 };
  const sent = await f.post('scene', scene); assert.equal(sent.status, 200);
  const intent = await f.car.wait(value => value.type === 'vehicle.effect.intent' && value.cue === 'DRIVE_WIND');
  assert.equal(intent.channel, 'AIRFLOW'); assert.equal(intent.roomId, f.room.roomId);
  assert.equal(intent.sceneId, 'escape-01'); assert.equal(intent.intensity01, 0.4);
  assert.ok(intent.effectSessionId); assert.ok(intent.effectId); assert.ok(intent.effectSeq > 0);
  assert.ok(intent.expiresAt > intent.issuedAt); assert.ok(intent.expiresAt - intent.issuedAt <= 5000);
  assert.equal(f.passenger.messages.some(value => value.type.startsWith('vehicle.effect.')), false);
  const count = f.car.messages.filter(value => value.type === 'vehicle.effect.intent').length;
  assert.equal((await f.post('scene', scene)).status, 200);
  await pause(20);
  assert.equal(f.car.messages.filter(value => value.type === 'vehicle.effect.intent').length, count, 'HTTP retry must not repeat a physical cue');
  assert.equal((await f.post('scene', { ...scene, virtualSpeedMps: 12 })).status, 409);
  assert.equal((await f.post('scene', { sceneId: 'escape-01', virtualSpeedMps: -1 })).status, 400);
  assert.equal((await f.post('cue', { sceneId: 'escape-01', cue: 'DANGER', intensity01: 0.6, durationMs: 1000 })).status, 200);
  await f.car.wait(value => value.type === 'vehicle.effect.intent' && value.cue === 'DANGER');
  assert.equal((await f.effects(f.phone.token)).status, 200);
});

test('4D applied-status claims require a correlated current-vehicle report rather than a phone or stale session', async t => {
  const f = await fixture(t);
  assert.equal((await f.enable()).status, 200);
  await f.post('scene', { sceneId: 'escape-02', virtualSpeedMps: 15 });
  const intent = await f.car.wait(value => value.type === 'vehicle.effect.intent');
  assert.equal((await f.effects()).body.effects.lastReport, null, 'issuing an intent is not proof that hardware changed');
  const receipt = status => ({ type: 'vehicle.effect.report', commandId: randomUUID(), effectSessionId: intent.effectSessionId,
    effectId: intent.effectId, effectSeq: intent.effectSeq, status });
  const phoneClaim = await f.passenger.send({ ...receipt('APPLIED_CONFIRMED'), observedValue: 5 });
  assert.equal(phoneClaim.ok, false); assert.equal(phoneClaim.error.code, 'ROLE_FORBIDDEN');
  assert.equal((await f.car.send({ ...receipt('RECEIVED'), effectSessionId: randomUUID() })).ok, false);
  assert.equal((await f.car.send({ ...receipt('RECEIVED'), effectSeq: intent.effectSeq + 1 })).ok, false);
  assert.equal((await f.car.send(receipt('RECEIVED'))).ok, true);
  assert.equal((await f.car.send({ ...receipt('APPLIED_CONFIRMED'), observedValue: 5 })).ok, true);
  const applied = (await f.effects()).body.effects;
  assert.equal(applied.lastReport.status, 'APPLIED_CONFIRMED'); assert.equal(applied.lastReport.observedValue, 5);
  assert.equal((await f.car.send(receipt('DISPATCHED'))).ok, false, 'an applied-status report must not regress to merely dispatched');
  const viewer = await f.connect(OPERATOR, f.room.roomId, true);
  await viewer.wait(value => value.type === 'observer.snapshot');
  assert.equal(viewer.messages.some(value => value.type === 'vehicle.effect.intent'), false);
  await f.post('stop');
  await f.car.wait(value => value.type === 'vehicle.effect.stop');
  const stoppedClaim = await f.car.send({ ...receipt('APPLIED_CONFIRMED'), observedValue: 5 });
  assert.equal(stoppedClaim.ok, false, 'stopped effects cannot be revived by a valid late applied report');
  assert.equal(stoppedClaim.error.code, 'EFFECT_SESSION_REQUIRED');
});

test('D, hidden app, and replacement vehicle stop 4D and require fresh local opt-in instead of replay', async t => {
  const f = await fixture(t);
  await f.enable(); await f.post('scene', { sceneId: 'escape-03', virtualSpeedMps: 20 });
  const first = await f.car.wait(value => value.type === 'vehicle.effect.intent');
  await f.report('D', 'RESTRICTED');
  await f.car.wait(value => value.type === 'vehicle.effect.stop');
  assert.equal((await f.snapshot()).state, 'PAUSED');
  await f.start();
  assert.equal((await f.post('scene', { sceneId: 'escape-03', virtualSpeedMps: 20 })).status, 409);
  await f.enable();
  await f.post('scene', { sceneId: 'escape-04', virtualSpeedMps: 20 });
  const next = await f.car.wait(value => value.type === 'vehicle.effect.intent' && value.effectSessionId !== first.effectSessionId);
  assert.notEqual(next.effectSessionId, first.effectSessionId);
  await f.report('P', 'ALLOWED', false);
  assert.equal((await f.snapshot()).state, 'PAUSED');
  await f.start(); await f.enable(); await f.post('scene', { sceneId: 'escape-05', virtualSpeedMps: 20 });
  const oldCar = f.car;
  const replacement = await f.replaceCar();
  await pause(20);
  assert.notEqual(oldCar, replacement);
  assert.equal(replacement.messages.some(value => value.type === 'vehicle.effect.intent'), false);
  await f.start();
  assert.equal((await f.post('scene', { sceneId: 'escape-05', virtualSpeedMps: 20 })).status, 409);
});

test('4D state and physical cue receipts are not restored from durable game storage', async t => {
  let saved;
  const stateStore = { load() { return saved ? structuredClone(saved) : null; }, save(state) { saved = structuredClone(state); }, close() {} };
  const f = await fixture(t, { stateStore });
  const sessionCommand = { commandId: randomUUID(), enabled: true, locallyEnabled: true, channels: ['AIRFLOW'], maxIntensity01: 0.6 };
  await f.post('session', sessionCommand);
  const sceneCommand = { commandId: randomUUID(), sceneId: 'escape-06', virtualSpeedMps: 15 };
  await f.post('scene', sceneCommand);
  const intent = await f.car.wait(value => value.type === 'vehicle.effect.intent');
  assert.equal(JSON.stringify(saved).includes(intent.effectId), false, 'do not persist physical cues in game checkpoints');
  await f.restart();
  const restored = await f.snapshot(); assert.equal(restored.state, 'PAUSED');
  const replacement = await f.replaceCar(); await f.start();
  assert.equal(replacement.messages.some(value => value.type === 'vehicle.effect.intent'), false);
  assert.equal((await f.post('scene', sceneCommand)).status, 409);
  assert.equal((await f.effects()).status, 200);
});

test('a failed durable commit cannot emit a 4D intent or publish an uncommitted effect snapshot', async t => {
  let saved, failSave = false;
  const stateStore = { load() { return saved ? structuredClone(saved) : null; }, save(state) { if (failSave) throw new Error('injected disk failure'); saved = structuredClone(state); }, close() {} };
  const f = await fixture(t, { stateStore });
  await f.enable();
  const effectSessionId = (await f.effects()).body.effects.effectSessionId;
  const before = f.car.messages.filter(value => value.type === 'vehicle.effect.intent').length;
  failSave = true;
  const rejected = await f.post('scene', { effectSessionId, sceneId: 'uncommitted-scene', virtualSpeedMps: 30 });
  assert.equal(rejected.status, 503); assert.equal(rejected.body.error.code, 'STORAGE_UNAVAILABLE');
  await pause(25);
  assert.equal(f.car.messages.filter(value => value.type === 'vehicle.effect.intent').length, before);
  assert.equal((await f.effects()).status, 503);
  assert.equal((await f.api('/healthz', undefined, undefined, 'GET')).status, 503);
});

test('missing fresh vehicle reports cancel 4D instead of leaving effects enabled indefinitely', async t => {
  const f = await fixture(t, { leaseMs: 600 });
  assert.equal((await f.enable()).status, 200);
  assert.equal((await f.post('scene', { sceneId: 'lease-scene', virtualSpeedMps: 15 })).status, 200);
  await f.car.wait(value => value.type === 'vehicle.effect.intent');
  await f.car.wait(value => value.type === 'vehicle.effect.stop');
  const room = await f.snapshot(); assert.equal(room.state, 'PAUSED'); assert.match(room.pauseReason, /LEASE_EXPIRED/);
  await f.start();
  assert.equal((await f.post('scene', { sceneId: 'lease-scene', virtualSpeedMps: 15 })).status, 409);
});

test('expired 4D cues stop and cannot receive late confirmations or replay on an HTTP retry', async t => {
  let effectTime = 2000000000000;
  const f = await fixture(t, { effectsClock: () => effectTime });
  await f.enable();
  await f.post('scene', { sceneId: 'expiry-scene', virtualSpeedMps: 15 });
  const cueRequest = { commandId: randomUUID(), sceneId: 'expiry-scene', cue: 'DANGER', intensity01: 0.5, durationMs: 100 };
  assert.equal((await f.post('cue', cueRequest)).status, 200);
  const cue = await f.car.wait(value => value.type === 'vehicle.effect.intent' && value.cue === 'DANGER');
  const count = f.car.messages.filter(value => value.type === 'vehicle.effect.intent').length;
  effectTime += 5001;
  const expired = (await f.effects()).body.effects;
  assert.equal(expired.active.length, 0);
  assert.equal(expired.enabled, true, 'cue expiry leaves only the local opt-in, not a running physical effect');
  await f.car.wait(value => value.type === 'vehicle.effect.stop' && value.reason === 'EXPIRED');
  const late = await f.car.send({ type: 'vehicle.effect.report', commandId: randomUUID(), effectSessionId: cue.effectSessionId,
    effectId: cue.effectId, effectSeq: cue.effectSeq, status: 'APPLIED_CONFIRMED', observedValue: 1 });
  assert.equal(late.ok, false); assert.equal(late.error.code, 'EFFECT_EXPIRED');
  assert.equal((await f.post('cue', cueRequest)).status, 200);
  await pause(20);
  assert.equal(f.car.messages.filter(value => value.type === 'vehicle.effect.intent').length, count, 'a late retry must not replay an expired cue');
});

test('a vehicle user override removes the wind channel until a new explicit effect session', async t => {
  const f = await fixture(t);
  await f.enable(); await f.post('scene', { sceneId: 'manual-override', virtualSpeedMps: 15 });
  const wind = await f.car.wait(value => value.type === 'vehicle.effect.intent' && value.channel === 'AIRFLOW');
  const override = await f.car.send({ type: 'vehicle.effect.report', commandId: randomUUID(), effectSessionId: wind.effectSessionId,
    effectId: wind.effectId, effectSeq: wind.effectSeq, status: 'USER_OVERRIDDEN', observedValue: 2 });
  assert.equal(override.ok, true);
  await f.car.wait(value => value.type === 'vehicle.effect.stop' && value.reason === 'USER_OVERRIDDEN');
  const current = (await f.effects()).body.effects;
  assert.equal(current.channels.includes('AIRFLOW'), false);
  const count = f.car.messages.filter(value => value.type === 'vehicle.effect.intent' && value.channel === 'AIRFLOW').length;
  assert.equal((await f.post('scene', { sceneId: 'manual-override', virtualSpeedMps: 25 })).status, 200);
  await pause(20);
  assert.equal(f.car.messages.filter(value => value.type === 'vehicle.effect.intent' && value.channel === 'AIRFLOW').length, count);
  await f.enable({ channels: ['AIRFLOW'] });
  await f.post('scene', { sceneId: 'manual-override', virtualSpeedMps: 25 });
  const fresh = await f.car.wait(value => value.type === 'vehicle.effect.intent' && value.effectSessionId !== wind.effectSessionId);
  assert.equal(fresh.channel, 'AIRFLOW');
});

test('previously unseen delayed enable, scene and cue requests cannot activate a newer control session', async t => {
  const f = await fixture(t);
  const initial = (await f.effects()).body.effects;
  const delayedEnable = { commandId: randomUUID(), enabled: true, locallyEnabled: true,
    vehicleConnectionId: f.car.auth.vehicleConnectionId, expectedControlVersion: initial.controlVersion,
    channels: ['AIRFLOW', 'AMBIENT', 'AUDIO'], maxIntensity01: 0.5 };
  await f.post('stop');
  const afterOffStop = (await f.effects()).body.effects;
  assert.ok(afterOffStop.controlVersion > initial.controlVersion, 'even stop while off revokes in-flight activation attempts');
  const rejectedEnable = await f.post('session', delayedEnable);
  assert.equal(rejectedEnable.status, 409); assert.equal(rejectedEnable.body.error.code, 'EFFECT_CONTROL_STALE');
  assert.equal((await f.effects()).body.effects.enabled, false);
  await f.enable();
  const original = (await f.effects()).body.effects;
  const heldScene = { commandId: randomUUID(), effectSessionId: original.effectSessionId, sceneId: 'late-scene', virtualSpeedMps: 30 };
  const heldCue = { commandId: randomUUID(), effectSessionId: original.effectSessionId, sceneId: 'late-scene', cue: 'DANGER', intensity01: 0.5, durationMs: 1000 };
  await f.post('stop'); await f.enable();
  const current = (await f.effects()).body.effects;
  assert.notEqual(current.effectSessionId, original.effectSessionId);
  const before = f.car.messages.filter(value => value.type === 'vehicle.effect.intent').length;
  for (const [route, request] of [['scene', heldScene], ['cue', heldCue]]) {
    const rejected = await f.post(route, request);
    assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'EFFECT_SESSION_STALE');
  }
  assert.equal((await f.effects()).body.effects.sceneId, null);
  await pause(20);
  assert.equal(f.car.messages.filter(value => value.type === 'vehicle.effect.intent').length, before);
});
