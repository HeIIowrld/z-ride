import test from 'node:test';
import assert from 'node:assert/strict';
import { createEffectsService } from '../effects.mjs';

function fixture(options = {}) {
  let time = 1000000;
  const service = createEffectsService({ clock: () => time, ...options });
  const context = { roomId: 'room-fixture', roomEpoch: 3, state: 'PLAYING', gate: { allowed: true }, connectionId: 'socket-1', role: 'CAR_HOST' };
  const enableBodies = new Map(), sceneBodies = new Map();
  const enable = (commandId = 'enable', extra = {}) => {
    const proposed = { commandId, enabled: true, locallyEnabled: true, channels: ['AIRFLOW', 'AMBIENT', 'AUDIO'], maxIntensity01: .6,
      vehicleConnectionId: context.connectionId, expectedControlVersion: service.snapshot(context.roomId).controlVersion, ...extra };
    const request = enableBodies.has(commandId) && !Object.keys(extra).length ? enableBodies.get(commandId) : proposed;
    if (!enableBodies.has(commandId)) enableBodies.set(commandId, structuredClone(request));
    return service.session(context, request);
  };
  const scene = (commandId = 'scene', extra = {}) => {
    const proposed = { commandId, effectSessionId: service.snapshot(context.roomId).effectSessionId, sceneId: 'escape-01', virtualSpeedMps: 15, ...extra };
    const request = sceneBodies.has(commandId) && !Object.keys(extra).length ? sceneBodies.get(commandId) : proposed;
    if (!sceneBodies.has(commandId)) sceneBodies.set(commandId, structuredClone(request));
    return service.scene(context, request);
  };
  const report = (intent, commandId, status, extra = {}) => service.report(context, { type: 'vehicle.effect.report', commandId,
    effectSessionId: intent.effectSessionId, effectId: intent.effectId, effectSeq: intent.effectSeq, status, ...extra });
  return { service, context, enable, scene, report, advance: milliseconds => { time += milliseconds; } };
}
const rejectsCode = (run, code) => assert.throws(run, value => value.code === code);

test('effect opt-in validates locally declared channels, current vehicle authority and caps before changing an active session', () => {
  const f = fixture();
  rejectsCode(() => f.service.session({ ...f.context, role: 'PHONE' }, { commandId: 'phone', enabled: true }), 'ROLE_FORBIDDEN');
  rejectsCode(() => f.enable('missing-optin', { locallyEnabled: false }), 'EFFECT_LOCAL_OPT_IN_REQUIRED');
  rejectsCode(() => f.enable('bad-channel', { channels: ['AIRFLOW', 'AIRFLOW'] }), 'INVALID_EFFECT_CHANNELS');
  rejectsCode(() => f.enable('bad-cap', { maxIntensity01: 1.01 }), 'INVALID_EFFECT_INTENSITY');
  f.enable(); const before = f.service.snapshot(f.context.roomId);
  rejectsCode(() => f.enable('invalid-replace', { channels: ['WINDOW'] }), 'INVALID_EFFECT_CHANNELS');
  assert.deepEqual(f.service.snapshot(f.context.roomId), before, 'failed reconfiguration does not discard existing authorization');
  rejectsCode(() => f.service.scene({ ...f.context, connectionId: 'socket-2' }, { commandId: 'stale-connection', sceneId: 'escape-01', virtualSpeedMps: 1 }), 'EFFECT_SESSION_STALE');
  rejectsCode(() => f.service.scene({ ...f.context, gate: { allowed: false } }, { commandId: 'stale-gate', sceneId: 'escape-01', virtualSpeedMps: 1 }), 'GATE_CLOSED');
});

test('effect receipts never re-emit physical intents or re-enable a stopped/replaced session', () => {
  const f = fixture(); f.enable();
  const first = f.scene(); assert.equal(first.events.length, 1); assert.equal(first.events[0].intensity01, .3);
  const replay = f.scene(); assert.equal(replay.replayed, true); assert.deepEqual(replay.events, []);
  rejectsCode(() => f.scene('scene', { virtualSpeedMps: 20 }), 'IDEMPOTENCY_CONFLICT');
  f.service.stop(f.context, { commandId: 'stop' });
  rejectsCode(() => f.enable(), 'EFFECT_SESSION_STALE');
  f.enable('enable-fresh');
  rejectsCode(() => f.scene(), 'EFFECT_SESSION_STALE');
  assert.equal(f.service.snapshot(f.context.roomId).active.length, 0);
  f.service.session(f.context, { commandId: 'disable-session', enabled: false, locallyEnabled: false });
  rejectsCode(() => f.service.session(f.context, { commandId: 'disable-session', enabled: false, locallyEnabled: true }), 'IDEMPOTENCY_CONFLICT');
  rejectsCode(() => f.service.stop(f.context, { commandId: 'disable-session' }), 'IDEMPOTENCY_CONFLICT');
});

test('latest channel intent and scene changes reject stale hardware reports; immutable projections cannot rewrite state', () => {
  const f = fixture(); f.enable(); const old = f.scene().events[0];
  const latest = f.scene('scene-2', { virtualSpeedMps: 100 }).events[0];
  assert.equal(latest.intensity01, .6, 'virtual speed saturates at the explicit user intensity cap');
  rejectsCode(() => f.report(old, 'superseded', 'DISPATCHED'), 'EFFECT_SUPERSEDED');
  const view = f.service.snapshot(f.context.roomId); view.channels.length = 0; view.active[0].intensity01 = 9;
  assert.equal(f.service.snapshot(f.context.roomId).active[0].intensity01, .6);
  const changed = f.scene('scene-3', { sceneId: 'escape-02' });
  assert.equal(changed.events[0].type, 'vehicle.effect.stop'); assert.equal(changed.events[0].reason, 'SCENE_CHANGED');
  rejectsCode(() => f.report(latest, 'old-scene', 'APPLIED_CONFIRMED', { observedValue: 5 }), 'EFFECT_SUPERSEDED');
});

test('expiry stops only active channels and never permits a late confirmation or an old request to replay', () => {
  const f = fixture(); f.enable(); const wind = f.scene().events[0];
  f.advance(3000);
  rejectsCode(() => f.report(wind, 'late', 'APPLIED_CONFIRMED', { observedValue: 5 }), 'EFFECT_EXPIRED');
  const tick = f.service.tick(f.context); assert.equal(tick.changed, true); assert.equal(tick.events[0].reason, 'EXPIRED');
  assert.deepEqual(tick.events[0].channels, ['AIRFLOW']); assert.equal(f.service.snapshot(f.context.roomId).active.length, 0);
  assert.equal(f.service.snapshot(f.context.roomId).enabled, true, 'expiry does not silently create another cue or lose explicit local opt-in');
  assert.deepEqual(f.scene().events, [], 'retry of an expired command never sends physical output');
  assert.equal(f.scene('new-explicit-scene').events.length, 1);
  f.context.roomEpoch++;
  const changed = f.service.tick(f.context); assert.equal(changed.events[0].reason, 'ROUND_CHANGED'); assert.equal(changed.data.enabled, false);
});

test('execution status requires a scalar actual observation, rejects regression, and honors user/unsupported vetoes', () => {
  const f = fixture(); f.enable(); const wind = f.scene().events[0];
  rejectsCode(() => f.report(wind, 'object-observation', 'APPLIED_CONFIRMED', { observedValue: { latitude: 1 } }), 'INVALID_EFFECT_REPORT');
  rejectsCode(() => f.report(wind, 'string-observation', 'APPLIED_CONFIRMED', { observedValue: 'private-data' }), 'INVALID_EFFECT_REPORT');
  rejectsCode(() => f.report(wind, 'missing-observation', 'APPLIED_CONFIRMED'), 'INVALID_EFFECT_REPORT');
  f.report(wind, 'received', 'RECEIVED'); f.report(wind, 'applied', 'APPLIED_CONFIRMED', { observedValue: 5 });
  rejectsCode(() => f.report(wind, 'regression', 'DISPATCHED'), 'EFFECT_REPORT_REGRESSION');
  f.report(wind, 'override', 'USER_OVERRIDDEN');
  assert.equal(f.service.snapshot(f.context.roomId).channels.includes('AIRFLOW'), false);
  assert.deepEqual(f.scene('speed-after-manual-change').events, [], 'later speed changes cannot take back the manual override');
  const effectSessionId = f.service.snapshot(f.context.roomId).effectSessionId;
  const cue = f.service.cue(f.context, { commandId: 'danger', effectSessionId, sceneId: 'escape-01', cue: 'DANGER', intensity01: .4, durationMs: 100 });
  const ambient = cue.events.find(event => event.channel === 'AMBIENT');
  f.report(ambient, 'ambient-unsupported', 'UNSUPPORTED');
  const next = f.service.cue(f.context, { commandId: 'danger-again', effectSessionId, sceneId: 'escape-01', cue: 'HIT', intensity01: .4 });
  assert.deepEqual(next.events.map(event => event.channel), ['AUDIO']);
});

test('bounded history does not replay evicted effects and receipt exhaustion cannot block stopping physical output', () => {
  const f = fixture({ maxRecords: 3 }); f.enable(); const old = f.scene().events[0];
  for (let i = 0; i < 6; i++) f.scene('next-' + i);
  rejectsCode(() => f.report(old, 'evicted-report', 'DISPATCHED'), 'EFFECT_NOT_FOUND');
  const small = fixture({ maxReceipts: 2 }); small.enable(); small.scene();
  rejectsCode(() => small.scene('overflow'), 'COMMAND_LIMIT');
  const stopped = small.service.stop(small.context, { commandId: 'always-stop' });
  assert.equal(stopped.data.enabled, false); assert.equal(stopped.events[0].type, 'vehicle.effect.stop');
  assert.deepEqual(small.service.stop(small.context, { commandId: 'always-stop' }).events, []);
  const onlyEnable = fixture({ maxReceipts: 1 }); onlyEnable.enable();
  assert.equal(onlyEnable.service.session(onlyEnable.context, { commandId: 'disable-at-limit', enabled: false }).data.enabled, false);
});

test('unseen delayed enable, scene and cue requests cannot acquire a later vehicle control session', () => {
  const f = fixture();
  const heldEnable = { commandId: 'held-before-first-stop', enabled: true, locallyEnabled: true, channels: ['AIRFLOW'], maxIntensity01: .5,
    vehicleConnectionId: f.context.connectionId, expectedControlVersion: 0 };
  assert.equal(f.service.snapshot(f.context.roomId).controlVersion, 0);
  const stoppedWhileOff = f.service.stop(f.context, { commandId: 'stop-before-enable' });
  assert.equal(stoppedWhileOff.data.controlVersion, 1);
  rejectsCode(() => f.service.session(f.context, heldEnable), 'EFFECT_CONTROL_STALE');
  f.enable('enable-after-stop');
  const oldId = f.service.snapshot(f.context.roomId).effectSessionId;
  const heldScene = { commandId: 'held-scene-never-delivered', effectSessionId: oldId, sceneId: 'escape-01', virtualSpeedMps: 90 };
  const heldCue = { commandId: 'held-cue-never-delivered', effectSessionId: oldId, sceneId: 'escape-01', cue: 'HIT', intensity01: 1 };
  f.service.stop(f.context, { commandId: 'end-old-session' }); f.enable('enable-next'); f.scene('current-scene');
  const before = f.service.snapshot(f.context.roomId);
  rejectsCode(() => f.service.scene(f.context, heldScene), 'EFFECT_SESSION_STALE');
  rejectsCode(() => f.service.cue(f.context, heldCue), 'EFFECT_SESSION_STALE');
  assert.deepEqual(f.service.snapshot(f.context.roomId), before);
  const heldForPreviousConnection = { ...heldEnable, commandId: 'held-old-socket', expectedControlVersion: before.controlVersion };
  f.context.connectionId = 'socket-2';
  rejectsCode(() => f.service.session(f.context, heldForPreviousConnection), 'EFFECT_SESSION_STALE');
});
