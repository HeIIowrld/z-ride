/**
 * SIMULATED_NO_SDK: exercise the real 4D REST/WS contract with a simulated car.
 * This tool never calls a vehicle SDK or claims that hardware effects applied.
 * Only RECEIVED execution reports are sent. No keys, tokens or pairing codes
 * are printed or written to files. Every run creates a new test room.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';

const { values } = parseArgs({ options: {
  base: { type: 'string', default: 'http://127.0.0.1:8000' },
  durationsec: { type: 'string', default: '30' },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('node tools/effects-demo.mjs --base http://127.0.0.1:8000 [--durationsec 30]');
  console.log('SIMULATED_NO_SDK: new host + phone, virtual speed 6→18→30 m/s, DANGER/HIT/ESCAPE, then D stop.');
  console.log('Duration is 10..600 seconds. Set protected-server ZRIDE_TEST_ACCESS_KEY privately in the environment.');
  console.log('Execution status is RECEIVED only; actual vehicle hardware is not exercised.');
  process.exit(0);
}
const url = new URL(values.base);
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('--base must be a plain HTTP(S) origin');
const seconds = Number(values.durationsec);
if (!Number.isSafeInteger(seconds) || seconds < 10 || seconds > 600) throw new Error('--durationsec must be an integer 10..600');
const base = url.origin;
const clients = [], abort = new AbortController();
let host, roomId, car, phone, heartbeat, heartbeatWork, effectSessionId, reportSeq = 0, stopping = false, interrupted = false;
let intentCount = 0, receiptCount = 0, stopCount = 0;
const log = (event, detail = {}) => console.log(JSON.stringify({ event, source: 'SIMULATED_NO_SDK', simulated: true, ...detail }));
const interrupt = () => { interrupted = true; abort.abort(); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);

async function request(path, body, token, method = 'POST') {
  if (path === '/api/session' && process.env.ZRIDE_TEST_ACCESS_KEY) body = { ...body, accessKey: process.env.ZRIDE_TEST_ACCESS_KEY };
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(8000),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error('HTTP_' + response.status + '_' + (value.error?.code ?? 'UNKNOWN'));
  return value;
}
async function connect(token, role) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { handshakeTimeout: 8000 });
  const waiting = new Map();
  let room;
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
    if (!value.ok) throw new Error('WS_' + (value.error?.code ?? 'UNKNOWN'));
    return value;
  } };
  clients.push(client);
  ws.on('error', () => {});
  ws.on('close', () => {
    for (const waiter of waiting.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('WS_CLOSED')); }
    waiting.clear();
    if (!stopping) { log('effects-demo.connection-lost', { role }); process.exitCode = 1; abort.abort(); }
  });
  ws.on('message', bytes => {
    let value; try { value = JSON.parse(bytes); } catch { return; }
    if (value.type === 'auth.ok') settle('auth', value);
    else if (value.type === 'snapshot') { room = value.room; settle('snapshot', value); }
    else if (value.type === 'result') settle(value.commandId, value);
    else if (value.type === 'vehicle.effect.stop') {
      stopCount++; log('effects-demo.stop', { reason: value.reason, channels: value.channels });
    } else if (value.type === 'vehicle.effect.intent') {
      intentCount++;
      log('effects-demo.intent', { sceneId: value.sceneId, channel: value.channel, cue: value.cue,
        intensity01: value.intensity01, durationMs: value.expiresAt - value.issuedAt });
      if (role === 'CAR_HOST' && !stopping) {
        // Receipt is a transport acknowledgement, never a hardware confirmation.
        client.send({ type: 'vehicle.effect.report', commandId: randomUUID(), effectSessionId: value.effectSessionId,
          effectId: value.effectId, effectSeq: value.effectSeq, status: 'RECEIVED' }).then(() => {
          receiptCount++; log('effects-demo.execution', { channel: value.channel, status: 'RECEIVED', hardwareApplied: false });
        }).catch(error => {
          log('effects-demo.receipt-failed', { code: error.message }); process.exitCode = 1; abort.abort();
        });
      }
    }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', () => reject(new Error('WS_CONNECT_FAILED'))); });
  const connected = Promise.all([wait('auth'), wait('snapshot')]);
  ws.send(JSON.stringify({ type: 'auth', token, roomId }));
  const [authenticated] = await connected; client.auth = authenticated;
  return client;
}
const effect = (operation, body = {}) => request('/api/rooms/' + roomId + '/effects/' + operation,
  { commandId: randomUUID(), ...(['scene', 'cue'].includes(operation) ? { effectSessionId } : {}), ...body }, host.token);
const game = action => car.send({ type: 'command', commandId: randomUUID(), roomEpoch: car.room.roomEpoch, action });
const vehicle = (gear = 'P', ux = 'ALLOWED') => car.send({ type: 'vehicle.report', commandId: randomUUID(), reportSeq: ++reportSeq,
  gear, ux, foreground: true, seats: [{ seat: 'FRONT_PASSENGER', occupancy: 'UNKNOWN' }], source: 'SIMULATED_NO_SDK' });

try {
  host = await request('/api/session', { role: 'CAR_HOST', nickname: 'TEST 4D NO SDK HOST' });
  const guest = await request('/api/session', { role: 'PHONE', nickname: 'TEST 4D PHONE' });
  const created = await request('/api/rooms', {}, host.token); roomId = created.roomId;
  const joined = await request('/api/join', { joinCode: created.joinCode, seat: 'FRONT_PASSENGER' }, guest.token);
  await request('/api/rooms/' + roomId + '/approve', { memberId: joined.memberId, allowManualUnknown: true }, host.token);
  car = await connect(host.token, 'CAR_HOST'); phone = await connect(guest.token, 'PHONE');
  await vehicle(); await game('round.start');
  const beforeEnable = await request('/api/rooms/' + roomId + '/effects', undefined, host.token, 'GET');
  const enabled = await effect('session', { enabled: true, locallyEnabled: true, channels: ['AIRFLOW', 'AMBIENT', 'AUDIO'], maxIntensity01: 0.5,
    vehicleConnectionId: car.auth.vehicleConnectionId, expectedControlVersion: beforeEnable.effects.controlVersion });
  effectSessionId = enabled.effects.effectSessionId;
  heartbeat = setInterval(() => {
    if (stopping || heartbeatWork) return;
    heartbeatWork = vehicle().catch(error => { log('effects-demo.report-failed', { code: error.message }); process.exitCode = 1; abort.abort(); }).finally(() => { heartbeatWork = null; });
  }, 2000);
  log('effects-demo.ready', { roomId, durationsec: seconds, actualVehicleSdk: false, hardwareApplied: false });
  const sceneId = 'effects-demo-escape';
  const steps = [
    [0, async () => { await effect('scene', { sceneId, virtualSpeedMps: 6 }); log('effects-demo.scene', { sceneId, virtualSpeedMps: 6 }); }],
    [0.2, async () => { await effect('scene', { sceneId, virtualSpeedMps: 18 }); log('effects-demo.scene', { sceneId, virtualSpeedMps: 18 }); }],
    [0.4, async () => { await effect('scene', { sceneId, virtualSpeedMps: 30 }); log('effects-demo.scene', { sceneId, virtualSpeedMps: 30 }); }],
    [0.55, () => effect('cue', { sceneId, cue: 'DANGER', intensity01: 0.5, durationMs: 2000 })],
    [0.7, () => effect('cue', { sceneId, cue: 'HIT', intensity01: 0.4, durationMs: 2000 })],
    [0.85, () => effect('cue', { sceneId, cue: 'ESCAPE', intensity01: 0.3, durationMs: 2000 })],
  ];
  const started = Date.now();
  for (const [fraction, run] of steps) {
    await sleep(Math.max(0, started + fraction * seconds * 1000 - Date.now()), undefined, { signal: abort.signal });
    await run();
  }
  await sleep(Math.max(0, started + seconds * 1000 - Date.now()), undefined, { signal: abort.signal });
  clearInterval(heartbeat); await heartbeatWork;
  await vehicle('D', 'RESTRICTED');
  const final = await request('/api/rooms/' + roomId + '/effects', undefined, host.token, 'GET');
  assert.equal(final.effects.enabled, false); assert.equal(final.effects.active.length, 0);
  assert.ok(intentCount >= 9, 'Three wind intents and two channels for each of three cues');
  assert.equal(receiptCount, intentCount); assert.ok(stopCount > 0);
  log('effects-demo.verified', { roomId, intents: intentCount, receipts: receiptCount, stops: stopCount,
    realGearTest: 'SIMULATED_D_RESTRICTED', effectsEnabled: final.effects.enabled, actualVehicleSdk: false, hardwareApplied: false });
} catch (error) {
  if (!interrupted || error.name !== 'AbortError') { process.exitCode = 1; log('effects-demo.failed', { code: error.message }); }
} finally {
  stopping = true; clearInterval(heartbeat); await heartbeatWork;
  if (host && roomId) await effect('stop').catch(() => {});
  if (car?.ws.readyState === WebSocket.OPEN && car.room) await game('round.pause').catch(() => {});
  for (const client of clients) client.ws.terminate();
  log('effects-demo.finished', { roomId: roomId ?? null, interrupted, actualVehicleSdk: false });
}
