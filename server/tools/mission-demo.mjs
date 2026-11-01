/**
 * SIMULATED_NO_SDK: run the real server-owned heist scenario with a simulated
 * vehicle and two crew phones. Never calls a vehicle SDK or reports physical
 * effects as applied. No access keys, tokens or pairing codes enter stdout/files.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';

const { values } = parseArgs({ options: { base: { type: 'string', default: 'http://127.0.0.1:8000' }, help: { type: 'boolean', default: false } } });
if (values.help) {
  console.log('node tools/mission-demo.mjs --base http://127.0.0.1:8000');
  console.log('SIMULATED_NO_SDK: PREPARE -> INFILTRATE -> DEFEND -> EXTRACT -> COMPLETE. Maximum 60 seconds.');
  console.log('Set ZRIDE_TEST_ACCESS_KEY privately for a protected server. Only RECEIVED effect reports are sent.');
  process.exit(0);
}
const origin = new URL(values.base);
if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('--base must be a plain HTTP(S) origin');
const base = origin.origin, clients = [], abort = new AbortController(), pendingEffects = new Set();
const log = (event, detail = {}) => console.log(JSON.stringify({ event, source: 'SIMULATED_NO_SDK', simulated: true, ...detail }));
let host, roomId, car, left, right, heartbeat, heartbeatWork, stopping = false, interrupted = false, timedOut = false;
let vehicleSeq = 0, cabinSeq = 0, inputSeq = 0, intents = 0, receipts = 0, obsoleteReports = 0, stops = 0, maxWindIntensity = 0;
const expiry = setTimeout(() => { timedOut = true; abort.abort(); }, 60000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; abort.abort(); });

async function request(path, body, token, method = 'POST') {
  if (path === '/api/session' && process.env.ZRIDE_TEST_ACCESS_KEY) body = { ...body, accessKey: process.env.ZRIDE_TEST_ACCESS_KEY };
  const response = await fetch(base + path, { method,
    signal: stopping ? AbortSignal.timeout(8000) : AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error('HTTP_' + response.status + '_' + (value.error?.code ?? 'UNKNOWN')), { apiCode: value.error?.code });
  return value;
}
async function connect(token, role) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { handshakeTimeout: 8000 });
  const waiting = new Map(); let room;
  const wait = key => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(key); reject(new Error('WS_RESPONSE_TIMEOUT')); }, 5000);
    waiting.set(key, { resolve, reject, timer });
  });
  const settle = (key, value) => {
    const waiter = waiting.get(key); if (!waiter) return;
    waiting.delete(key); clearTimeout(waiter.timer); waiter.resolve(value);
  };
  const client = { ws, get room() { return room; }, async send(message) {
    if (ws.readyState !== WebSocket.OPEN) throw new Error('WS_CLOSED');
    const result = wait(message.commandId); ws.send(JSON.stringify(message));
    const value = await result;
    if (!value.ok) throw Object.assign(new Error('WS_' + (value.error?.code ?? 'UNKNOWN')), { apiCode: value.error?.code });
    return value;
  } };
  clients.push(client);
  ws.on('error', () => {});
  ws.on('close', () => {
    for (const waiter of waiting.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('WS_CLOSED')); }
    waiting.clear();
    if (!stopping) { log('mission-demo.connection-lost', { role }); process.exitCode = 1; abort.abort(); }
  });
  ws.on('message', bytes => {
    let message; try { message = JSON.parse(bytes); } catch { return; }
    if (message.type === 'auth.ok') settle('auth', message);
    else if (message.type === 'snapshot') { room = message.room; settle('snapshot', message); }
    else if (message.type === 'result') settle(message.commandId, message);
    else if (message.type === 'vehicle.effect.stop') { stops++; log('mission-demo.effect-stop', { reason: message.reason, channels: message.channels }); }
    else if (message.type === 'vehicle.effect.intent' && role === 'CAR_HOST' && !stopping) {
      intents++; if (message.channel === 'AIRFLOW') maxWindIntensity = Math.max(maxWindIntensity, message.intensity01);
      const work = client.send({ type: 'vehicle.effect.report', commandId: randomUUID(), effectSessionId: message.effectSessionId,
        effectId: message.effectId, effectSeq: message.effectSeq, status: 'RECEIVED' }).then(() => { receipts++; }).catch(error => {
        // A final completion/expiry may beat this receipt. A real executor must
        // also discard obsolete physical requests rather than retrying them.
        if (['EFFECT_EXPIRED', 'EFFECT_SESSION_STALE', 'EFFECT_SESSION_REQUIRED', 'EFFECT_SUPERSEDED', 'NOT_PLAYING', 'GATE_CLOSED'].includes(error.apiCode)) obsoleteReports++;
        else { log('mission-demo.effect-report-failed', { code: error.message }); process.exitCode = 1; abort.abort(); }
      }).finally(() => pendingEffects.delete(work));
      pendingEffects.add(work);
    }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', () => reject(new Error('WS_CONNECT_FAILED'))); });
  const auth = Promise.all([wait('auth'), wait('snapshot')]); ws.send(JSON.stringify({ type: 'auth', token, roomId }));
  [client.auth] = await auth; return client;
}
const state = async (token = host.token) => (await request('/api/rooms/' + roomId + '/state', undefined, token, 'GET')).room;
async function command(client, action, fields = {}) {
  return client.send({ type: 'command', commandId: randomUUID(), roomEpoch: client.room.roomEpoch, action, ...fields });
}
async function game(operation, fields = {}, token = host.token) {
  const current = await state(token);
  return request('/api/rooms/' + roomId + '/game/' + operation, { commandId: randomUUID(), roomEpoch: current.roomEpoch,
    ...(['configure', 'advance', 'interact'].includes(operation) ? { expectedGameRevision: current.game.revision } : {}), ...fields }, token);
}
async function vehicle() {
  await car.send({ type: 'vehicle.report', commandId: randomUUID(), reportSeq: ++vehicleSeq, gear: 'P', ux: 'ALLOWED', foreground: true,
    seats: ['DRIVER', 'REAR_LEFT', 'REAR_RIGHT'].map(seat => ({ seat, occupancy: 'UNKNOWN' })), source: 'SIMULATED_NO_SDK' });
  const seq = ++cabinSeq, quality = { sampleSeq: seq, availability: 'AVAILABLE', source: 'SIMULATED', measuredAgeMs: 0 };
  await car.send({ type: 'vehicle.cabin.report', commandId: randomUUID(), vehicleConnectionId: car.auth.vehicleConnectionId, reportSeq: seq,
    hvac: { ...quality, areaId: 'SIMULATED_FRONT_ROW', power: true, fanSpeed: 3, fanMin: 0, fanMax: 7 },
    seatBelts: ['DRIVER', 'REAR_LEFT', 'REAR_RIGHT'].map(seat => ({ ...quality, seat, buckled: true })),
    energy: { ...quality, socPercent: 67 } });
}
async function advance(expectedStage) {
  const result = await game('advance'); assert.equal(result.room.game.stageId, expectedStage);
  log('mission-demo.stage', { stageId: expectedStage, objective: result.room.game.objectiveState }); return result.room;
}

try {
  host = await request('/api/session', { role: 'CAR_HOST', nickname: 'TEST MISSION NO SDK HOST' });
  const created = await request('/api/rooms', {}, host.token); roomId = created.roomId;
  car = await connect(host.token, 'CAR_HOST'); await vehicle();
  const phones = [];
  for (const [index, seat] of ['REAR_LEFT', 'REAR_RIGHT'].entries()) {
    const guest = await request('/api/session', { role: 'PHONE', nickname: 'TEST MISSION ' + seat });
    const invite = index === 0 ? created : await request('/api/rooms', {}, host.token);
    const joined = await request('/api/join', { joinCode: invite.joinCode, seat }, guest.token);
    await request('/api/rooms/' + roomId + '/approve', { memberId: joined.memberId, seat, allowManualUnknown: true }, host.token);
    phones.push({ token: guest.token, client: await connect(guest.token, seat) });
  }
  [left, right] = phones;
  await game('configure', { scenarioId: 'heist-demo-v1', roleAssignments: [
    { memberId: car.auth.memberId, missionRole: 'DRIVER' },
    { memberId: left.client.auth.memberId, missionRole: 'TECH' },
    { memberId: right.client.auth.memberId, missionRole: 'COVER' },
  ] });
  heartbeat = setInterval(() => {
    if (stopping || heartbeatWork) return;
    heartbeatWork = vehicle().catch(error => { log('mission-demo.telemetry-failed', { code: error.message }); process.exitCode = 1; abort.abort(); }).finally(() => { heartbeatWork = null; });
  }, 2000);
  await command(left.client, 'mobile.collect', { pickupId: 'DEMO_PICKUP_A', passengerConfirmed: true });
  await command(right.client, 'mobile.collect', { pickupId: 'DEMO_PICKUP_B', passengerConfirmed: true });
  await command(car, 'round.start');
  log('mission-demo.ready', { roomId, scenarioId: 'heist-demo-v1', actualVehicleSdk: false, hardwareApplied: false });
  await advance('INFILTRATE');
  for (const crew of [left, right]) await game('interact', { objectiveId: 'TERMINALS', action: 'INTERACT' }, crew.token);
  await advance('DEFEND');
  for (const [client, angleDeg] of [[left.client, -100], [right.client, 60], [right.client, 140]]) {
    for (let shot = 0; shot < 5; shot++) await command(client, 'fire', { angleDeg });
  }
  const defended = await state(); assert.equal(defended.stats.waveCleared, true); assert.equal(defended.stats.kills, 3);
  await advance('EXTRACT');
  const beforeEffects = await request('/api/rooms/' + roomId + '/effects', undefined, host.token, 'GET');
  await request('/api/rooms/' + roomId + '/effects/session', { commandId: randomUUID(), enabled: true, locallyEnabled: true,
    vehicleConnectionId: car.auth.vehicleConnectionId, expectedControlVersion: beforeEffects.effects.controlVersion,
    channels: ['AIRFLOW', 'AMBIENT', 'AUDIO'], maxIntensity01: .5 }, host.token);
  const extraction = await state(); assert.equal(extraction.cabin.derived.purificationInputReason, 'AIRFLOW_EFFECT_ACTIVE');
  log('mission-demo.extracting', { serverOwnedMotion: true, targetDistanceM: 100, actualVehicleSdk: false });
  let motion;
  for (;;) {
    abort.signal.throwIfAborted(); motion = await state();
    if (motion.game.objectiveState.complete) break;
    assert.equal(motion.game.stageId, 'EXTRACT'); assert.ok(motion.game.driverSessionId);
    try {
      await game('input', { driverSessionId: motion.game.driverSessionId, inputSeq: ++inputSeq, throttle: 1, brake: 0 });
    } catch (error) {
      if (error.apiCode !== 'GAME_SCENE_NOT_DRIVABLE' || !(await state()).game.objectiveState.complete) throw error;
      break;
    }
    await sleep(500, undefined, { signal: abort.signal });
  }
  await Promise.all([...pendingEffects]);
  const completed = await advance('COMPLETE');
  assert.equal(completed.state, 'CLEARED'); assert.equal(completed.game.completed, true); assert.equal(completed.game.distanceM, 100);
  assert.equal(completed.effects.enabled, false); assert.equal(completed.effects.active.length, 0);
  assert.ok(intents > 0); assert.ok(receipts > 0); assert.ok(maxWindIntensity > 0);
  log('mission-demo.verified', { roomId, stageId: completed.game.stageId, completed: true, roomState: completed.state,
    sharedSupplies: completed.collection.inventory.supplies, kills: completed.stats.kills, distanceM: completed.game.distanceM,
    inputCount: inputSeq, effectIntents: intents, receivedReports: receipts, obsoleteReports, effectStops: stops,
    maxWindIntensity, effectsEnabled: false, cabinReports: cabinSeq, actualVehicleSdk: false, hardwareApplied: false });
} catch (error) {
  if (!interrupted || error.name !== 'AbortError') { process.exitCode = 1; log('mission-demo.failed', { code: timedOut ? 'DEMO_TIMEOUT' : error.message }); }
} finally {
  stopping = true; clearTimeout(expiry); clearInterval(heartbeat); await heartbeatWork;
  if (host && roomId) await request('/api/rooms/' + roomId + '/effects/stop', { commandId: randomUUID() }, host.token).catch(() => {});
  if (car?.ws.readyState === WebSocket.OPEN && car.room) await command(car, 'round.pause').catch(() => {});
  await Promise.all([...pendingEffects]);
  for (const client of clients) client.ws.terminate();
  log('mission-demo.finished', { roomId: roomId ?? null, interrupted, actualVehicleSdk: false });
}
