import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameStateService, GAME_INPUT_RECEIPT_LIMIT } from '../game-state.mjs';

const rejects = (run, code) => assert.throws(run, value => value.code === code);
function fixture(options = {}) {
  let time = 1000000, nextCommand = 0;
  const service = createGameStateService({ clock: () => time, ...options });
  const game = service.initial();
  const context = { roomId: 'room-1', roomEpoch: 2, state: 'READY', gate: { allowed: true }, connectionId: 'car-1', role: 'CAR_HOST', memberId: 'host', inventorySupplies: 0, waveCleared: false,
    members: [
      { memberId: 'host', role: 'CAR_HOST', seat: 'DRIVER', approved: true, connected: true },
      { memberId: 'left', role: 'REAR_LEFT', seat: 'REAR_LEFT', approved: true, connected: true },
      { memberId: 'right', role: 'REAR_RIGHT', seat: 'REAR_RIGHT', approved: true, connected: true },
      { memberId: 'pending', role: 'FRONT_PASSENGER', seat: 'FRONT_PASSENGER', approved: false, connected: true },
    ] };
  const body = extra => ({ commandId: `command-${++nextCommand}`, roomEpoch: context.roomEpoch, expectedGameRevision: game.revision, ...extra });
  const configure = (scenarioId = 'heist-demo-v1', extra = {}) => service.configure(game, context, body({ scenarioId, ...extra }));
  const advance = () => service.advance(game, context, body());
  const tick = delta => { time += delta; return service.tick(game, context); };
  const input = (inputSeq = 1, fields = {}) => {
    const current = service.snapshot(game, context);
    return service.input(game, context, { commandId: `input-${++nextCommand}`, roomEpoch: context.roomEpoch, driverSessionId: current.driverSessionId, inputSeq, throttle: 1, brake: 0, ...fields });
  };
  return { service, game, context, body, configure, advance, tick, input, advanceTime: delta => { time += delta; } };
}

test('scenario catalog and snapshots are immutable and separate mission roles from vehicle seats', () => {
  const f = fixture();
  const presets = f.service.scenarios(); presets[0].stages.length = 0;
  assert.equal(f.service.scenarios()[0].stages.length, 1);
  f.configure('heist-demo-v1', { roleAssignments: [{ memberId: 'left', missionRole: 'SCOUT' }] });
  const snapshot = f.service.snapshot(f.game, f.context);
  assert.equal(snapshot.missionRoles.find(item => item.memberId === 'left').missionRole, 'SCOUT');
  assert.equal(f.context.members.find(item => item.memberId === 'left').seat, 'REAR_LEFT');
  assert.equal(snapshot.missionRoles.some(item => item.memberId === 'pending'), false);
  snapshot.roleAssignments.length = 0; snapshot.objectives[0].progress = 999;
  assert.equal(f.game.roleAssignments.length, 1); assert.equal(f.game.objectiveState.progress, 0);
  rejects(() => f.configure('heist-demo-v1', { roleAssignments: [{ memberId: 'left', missionRole: 'DRIVER' }] }), 'INVALID_MISSION_ROLES');
});

test('mission transitions require server-owned supply, distinct crew, combat and distance objectives', () => {
  const f = fixture(); f.configure(); f.context.state = 'PLAYING'; f.service.tick(f.game, f.context);
  rejects(() => f.advance(), 'GAME_OBJECTIVE_INCOMPLETE');
  f.context.inventorySupplies = 2; f.service.tick(f.game, f.context); f.advance();
  assert.equal(f.game.stageId, 'INFILTRATE');
  const interact = memberId => f.service.interact(f.game, { ...f.context, role: 'REAR_LEFT', memberId }, f.body({ objectiveId: 'TERMINALS', action: 'INTERACT' }));
  interact('left'); rejects(() => interact('left'), 'GAME_ALREADY_INTERACTED');
  rejects(() => interact('pending'), 'ROLE_FORBIDDEN'); rejects(() => f.advance(), 'GAME_OBJECTIVE_INCOMPLETE');
  interact('right');
  const enteredDefense = f.advance(); assert.equal(f.game.stageId, 'DEFEND');
  assert.equal(enteredDefense.events[0].stageId, 'DEFEND');
  rejects(() => f.advance(), 'GAME_OBJECTIVE_INCOMPLETE');
  f.context.waveCleared = true; f.service.tick(f.game, f.context); f.context.state = 'CLEARED'; f.advance();
  assert.equal(f.game.stageId, 'EXTRACT');
  f.context.state = 'PLAYING'; f.service.tick(f.game, f.context);
  let seq = 0;
  while (f.game.distanceM < 100) { f.input(++seq); f.tick(250); }
  assert.equal(f.game.distanceM, 100); assert.equal(f.game.virtualSpeedMps, 0);
  const finish = f.advance(); assert.equal(f.game.completed, true); assert.equal(f.game.stageId, 'COMPLETE');
  assert.equal(finish.events.some(event => event.type === 'mission.completed'), true);
  rejects(() => f.advance(), 'GAME_NO_NEXT_STAGE');
});

test('driver authority, sequence and lease are server-managed while movement does not race mission revisions', () => {
  const f = fixture(); f.context.state = 'PLAYING'; f.service.tick(f.game, f.context);
  const initialRevision = f.game.revision, first = f.service.snapshot(f.game, f.context);
  assert.ok(first.driverSessionId);
  assert.equal(f.service.snapshot(f.game, { ...f.context, role: 'REAR_LEFT', memberId: 'left' }).driverSessionId, null);
  rejects(() => f.service.input(f.game, { ...f.context, role: 'REAR_LEFT' }, { commandId: 'phone-input' }), 'ROLE_FORBIDDEN');
  f.input(1); f.tick(250); assert.ok(f.game.virtualSpeedMps > 0); assert.equal(f.game.revision, initialRevision);
  const before = f.game.motionSeq; rejects(() => f.input(1), 'GAME_INPUT_ORDER'); assert.equal(f.game.motionSeq, before);
  f.advanceTime(3000); f.service.tick(f.game, f.context);
  assert.equal(f.service.snapshot(f.game, f.context).driverControl.inputFresh, false);
  assert.equal(f.service.snapshot(f.game, f.context).driverControl.throttle, 0);
  const originalSession = f.service.snapshot(f.game, f.context).driverSessionId;
  f.context.connectionId = 'car-2'; f.service.tick(f.game, f.context);
  assert.notEqual(f.service.snapshot(f.game, f.context).driverSessionId, originalSession);
  rejects(() => f.input(2, { driverSessionId: originalSession }), 'GAME_CONTROL_STALE');
});

test('pause, restart and clamped ticks preserve logical progress without restoring held driving authority', () => {
  const f = fixture(); f.context.state = 'PLAYING'; f.service.tick(f.game, f.context); f.input(1); f.tick(250);
  const distance = f.game.distanceM; f.tick(10000);
  assert.ok(f.game.distanceM < distance + 10, 'long scheduling gaps never integrate unbounded motion');
  f.input(2); f.tick(250); const saved = f.service.durable(f.game);
  assert.equal(JSON.stringify(saved).includes('driverSessionId'), false);
  assert.equal(JSON.stringify(saved).includes('throttle'), false);
  f.context.state = 'PAUSED'; f.service.tick(f.game, f.context);
  assert.equal(f.game.virtualSpeedMps, 0); assert.equal(f.service.snapshot(f.game, f.context).driverSessionId, null);
  const restarted = createGameStateService({ clock: () => 2000000 }), restored = restarted.restore(saved);
  assert.equal(restored.distanceM, saved.distanceM); assert.equal(restored.virtualSpeedMps, 0);
  assert.equal(restarted.snapshot(restored, { ...f.context, state: 'PLAYING' }).driverSessionId, null);
  assert.equal(restarted.snapshot(restored, f.context).driverControl.inputFresh, false);
});

test('stale configuration and unknown client state fields cannot rewrite mission authority', () => {
  const f = fixture(); const initial = f.service.snapshot(f.game, f.context);
  rejects(() => f.configure('not-a-scenario'), 'GAME_SCENARIO_NOT_FOUND');
  assert.deepEqual(f.service.snapshot(f.game, f.context), initial);
  const old = f.body({ scenarioId: 'heist-demo-v1' }); f.configure();
  rejects(() => f.service.configure(f.game, f.context, old), 'GAME_REVISION_STALE');
  const before = f.service.durable(f.game);
  rejects(() => f.service.configure(f.game, f.context, f.body({ scenarioId: 'heist-demo-v1', completed: true })), 'INVALID_GAME_REQUEST');
  assert.deepEqual(f.service.durable(f.game), before);
  f.context.state = 'PLAYING'; rejects(() => f.configure(), 'GAME_REQUIRES_PAUSE');
});

test('paused collection snapshots expose one current objective without granting new control or mutating saved progress', () => {
  const f = fixture(); f.configure(); f.context.state = 'PAUSED';
  const before = f.service.durable(f.game); f.context.inventorySupplies = 2;
  const current = f.service.snapshot(f.game, f.context);
  assert.equal(current.objectiveState.progress, 2); assert.equal(current.objectiveState.complete, true);
  assert.deepEqual(current.objectiveState, current.objectives[0]);
  assert.equal(current.driverSessionId, null);
  assert.deepEqual(f.service.durable(f.game), before, 'read projection does not create authority or mutate a checkpoint');
});

test('a delayed fresh driver input integrates only the old expired control before renewing the current session', () => {
  const f = fixture(); f.context.state = 'PLAYING'; f.service.tick(f.game, f.context);
  f.input(1);
  for (let index = 0; index < 4; index++) f.tick(250);
  const beforeSpeed = f.game.virtualSpeedMps, beforeDistance = f.game.distanceM;
  const session = f.service.snapshot(f.game, f.context).driverSessionId, revision = f.game.revision;
  f.advanceTime(3000); f.input(2);
  assert.ok(f.game.virtualSpeedMps < beforeSpeed, 'new throttle is never applied to the preceding expired interval');
  assert.ok(f.game.distanceM - beforeDistance < beforeSpeed * .251, 'input also clamps elapsed integration to 250ms');
  const renewed = f.service.snapshot(f.game, f.context);
  assert.equal(renewed.driverSessionId, session); assert.equal(renewed.driverControl.inputFresh, true);
  assert.equal(renewed.driverControl.throttle, 1); assert.equal(renewed.driverControl.brake, 0);
  assert.equal(f.game.revision, revision);
  const renewedSpeed = f.game.virtualSpeedMps; f.tick(250); assert.ok(f.game.virtualSpeedMps > renewedSpeed);
});

test('distance completion reached during input integration neutralizes the new held throttle before projection', () => {
  const f = fixture(); f.configure(); f.context.state = 'PLAYING'; f.context.inventorySupplies = 2;
  f.service.tick(f.game, f.context); f.advance();
  for (const memberId of ['left', 'right']) f.service.interact(f.game, { ...f.context, role: 'REAR_LEFT', memberId }, f.body({ objectiveId: 'TERMINALS', action: 'INTERACT' }));
  f.advance(); f.context.waveCleared = true; f.service.tick(f.game, f.context); f.advance();
  f.service.tick(f.game, f.context);
  let sequence = 0;
  const nextDistance = () => f.game.distanceM + (f.game.virtualSpeedMps + Math.min(30, f.game.virtualSpeedMps + 4.5 * .25)) * .125;
  while (nextDistance() < 100) { f.input(++sequence); f.tick(250); }
  assert.ok(f.game.distanceM < 100);
  f.advanceTime(250); f.input(++sequence);
  const result = f.service.snapshot(f.game, f.context);
  assert.equal(result.distanceM, 100); assert.equal(result.virtualSpeedMps, 0);
  assert.equal(result.objectives[0].complete, true);
  assert.equal(result.driverControl.throttle, 0); assert.equal(result.driverControl.brake, 1);
  const finished = f.service.durable(f.game);
  rejects(() => f.input(++sequence), 'GAME_SCENE_NOT_DRIVABLE');
  assert.deepEqual(f.service.durable(f.game), finished);
});

test('idempotent driver input retries do not renew the lease, integrate motion or accept a changed body', () => {
  const f = fixture(); f.context.state = 'PLAYING'; f.service.tick(f.game, f.context);
  const body = { commandId: 'held-input', roomEpoch: f.context.roomEpoch,
    driverSessionId: f.service.snapshot(f.game, f.context).driverSessionId, inputSeq: 1, throttle: 1, brake: 0 };
  assert.equal(f.service.input(f.game, f.context, body).replayed, false);
  f.advanceTime(2001);
  const checkpoint = f.service.durable(f.game);
  const retried = f.service.input(f.game, f.context, { brake: 0, throttle: 1, inputSeq: 1,
    driverSessionId: body.driverSessionId, roomEpoch: body.roomEpoch, commandId: body.commandId });
  assert.equal(retried.replayed, true); assert.equal(retried.changed, false);
  assert.equal(retried.data.driverControl.inputFresh, false);
  assert.equal(retried.data.driverControl.leaseRemainingMs, 0);
  assert.deepEqual(f.service.durable(f.game), checkpoint);
  rejects(() => f.service.input(f.game, f.context, { ...body, inputSeq: 2, throttle: .5 }), 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(f.service.durable(f.game), checkpoint);
  f.service.tick(f.game, f.context);
  const stopped = f.service.snapshot(f.game, f.context);
  assert.equal(stopped.driverControl.throttle, 0); assert.equal(stopped.driverControl.inputFresh, false);
  assert.equal(JSON.stringify(f.service.durable(f.game)).includes('inputReceipts'), false);
});

test('bounded driver input receipts cannot make an evicted old sequence active again', () => {
  const f = fixture(); f.context.state = 'PLAYING'; f.service.tick(f.game, f.context);
  const driverSessionId = f.service.snapshot(f.game, f.context).driverSessionId;
  const first = { commandId: 'first-input', roomEpoch: f.context.roomEpoch, driverSessionId, inputSeq: 1, throttle: 1, brake: 0 };
  f.service.input(f.game, f.context, first);
  for (let sequence = 2; sequence <= GAME_INPUT_RECEIPT_LIMIT + 1; sequence++) {
    f.service.input(f.game, f.context, { ...first, commandId: `input-${sequence}`, inputSeq: sequence });
  }
  const checkpoint = f.service.durable(f.game);
  f.advanceTime(2001);
  rejects(() => f.service.input(f.game, f.context, first), 'GAME_INPUT_ORDER');
  assert.deepEqual(f.service.durable(f.game), checkpoint);
  assert.equal(f.service.snapshot(f.game, f.context).driverControl.inputFresh, false);
  f.context.connectionId = 'car-replaced'; f.service.tick(f.game, f.context);
  rejects(() => f.service.input(f.game, f.context, first), 'GAME_CONTROL_STALE');
});
