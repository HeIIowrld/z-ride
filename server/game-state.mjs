import { randomUUID } from 'node:crypto';

export const MISSION_ROLES = Object.freeze(['DRIVER', 'SCOUT', 'TECH', 'COVER']);
export const GAME_INPUT_RECEIPT_LIMIT = 256;
const DEFINITIONS = Object.freeze([
  { scenarioId: 'generic-coop-v1', title: 'Generic cooperative session', stages: [
    { stageId: 'COOP', title: 'Cooperative play', objectiveId: null, type: 'OPEN', target: 0, drivable: true },
  ] },
  { scenarioId: 'heist-demo-v1', title: 'Cooperative heist demonstration', stages: [
    { stageId: 'PREPARE', title: 'Prepare shared supplies', objectiveId: 'SUPPLIES_READY', type: 'SHARED_SUPPLIES', target: 2, drivable: false },
    { stageId: 'INFILTRATE', title: 'Crew terminal interaction', objectiveId: 'TERMINALS', type: 'UNIQUE_PHONE_INTERACTIONS', target: 2, drivable: false },
    { stageId: 'DEFEND', title: 'Defend the vehicle', objectiveId: 'DEFENSE_CLEAR', type: 'SERVER_COMBAT_CLEAR', target: 1, drivable: false },
    { stageId: 'EXTRACT', title: 'Virtual extraction', objectiveId: 'EXTRACTION_DISTANCE', type: 'VIRTUAL_DISTANCE', target: 100, drivable: true },
    { stageId: 'COMPLETE', title: 'Mission complete', objectiveId: null, type: 'COMPLETE', target: 0, drivable: false },
  ] },
]);
const DEFAULT_ROLE = Object.freeze({ DRIVER: 'DRIVER', FRONT_PASSENGER: 'SCOUT', REAR_LEFT: 'TECH', REAR_RIGHT: 'COVER' });
const copy = value => structuredClone(value);
const error = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const text = (value, maximum = 128) => typeof value === 'string' && value.length > 0 && value.length <= maximum;
const round = value => Math.round(value * 1000) / 1000;
const scene = game => `${game.missionRunId}:${game.stageId}`;

/** Server-owned logical mission state. Driver authority and held input never enter the durable checkpoint. */
export function createGameStateService({ clock = Date.now, driverLeaseMs = 2000, maxTickMs = 250 } = {}) {
  if (!Number.isSafeInteger(driverLeaseMs) || driverLeaseMs < 1 || !Number.isSafeInteger(maxTickMs) || maxTickMs < 1 || maxTickMs > 1000) throw new Error('Invalid game timing');
  const runtime = new Map();
  const definition = id => {
    const item = DEFINITIONS.find(value => value.scenarioId === id);
    if (!item) throw error('GAME_SCENARIO_NOT_FOUND', 'Unknown scenario preset', 404);
    return item;
  };
  const stage = game => definition(game.scenarioId).stages[game.stageIndex];
  const host = context => { if (context?.role !== 'CAR_HOST') throw error('ROLE_FORBIDDEN', 'Vehicle host required', 403); };
  const approved = context => context?.members?.find(member => member.memberId === context.memberId && member.approved);
  function request(input, allowed) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !text(input.commandId) || Object.keys(input).some(key => !allowed.includes(key))) throw error('INVALID_GAME_REQUEST', 'Known game fields and commandId required');
  }
  function epoch(context, input) {
    if (!Number.isSafeInteger(input.roomEpoch) || input.roomEpoch !== context.roomEpoch) throw error('STALE_EPOCH', 'Use the current roomEpoch', 409);
  }
  function revision(game, input) {
    if (!Number.isSafeInteger(input.expectedGameRevision) || input.expectedGameRevision !== game.revision) throw error('GAME_REVISION_STALE', 'Refresh game revision before changing mission state', 409);
  }
  function playable(context, allowCleared = false) {
    if (!context?.connectionId || !context.gate?.allowed) throw error('GATE_CLOSED', 'Fresh parked vehicle conditions required', 409);
    if (context.state !== 'PLAYING' && !(allowCleared && context.state === 'CLEARED')) throw error('NOT_PLAYING', 'Active parked game required', 409);
  }
  function objective(game, context) {
    const current = stage(game);
    let progress = 0;
    if (current.type === 'SHARED_SUPPLIES') progress = Math.max(0, Number(context.inventorySupplies) || 0);
    if (current.type === 'UNIQUE_PHONE_INTERACTIONS') progress = game.interactions.length;
    if (current.type === 'SERVER_COMBAT_CLEAR') progress = context.waveCleared === true ? 1 : 0;
    if (current.type === 'VIRTUAL_DISTANCE') progress = game.distanceM;
    return { objectiveId: current.objectiveId, type: current.type, target: current.target,
      progress: Math.min(progress, current.target), complete: current.objectiveId !== null && progress >= current.target };
  }
  function refreshObjective(game, context) {
    const next = objective(game, context), previous = game.objectiveState;
    const changed = JSON.stringify(previous) !== JSON.stringify(next);
    if (previous.complete !== next.complete) game.revision++;
    game.objectiveState = next;
    return changed;
  }
  function initial(scenarioId = 'generic-coop-v1') {
    const current = definition(scenarioId).stages[0], at = clock();
    return { schemaVersion: 1, missionRunId: randomUUID(), scenarioId, revision: 0, motionSeq: 0,
      stageId: current.stageId, stageIndex: 0, virtualSpeedMps: 0, distanceM: 0,
      stageElapsedMs: 0, totalElapsedMs: 0, completed: false, completedAt: null,
      roleAssignments: [], interactions: [], objectiveState: { objectiveId: current.objectiveId, type: current.type,
        target: current.target, progress: 0, complete: false },
      lastTransition: { from: null, to: current.stageId, reason: 'CREATED', at }, updatedAt: at };
  }
  function validated(saved) {
    if (!saved || saved.schemaVersion !== 1 || !text(saved.missionRunId)) throw new Error('Invalid persisted game state');
    const preset = definition(saved.scenarioId);
    if (!Number.isSafeInteger(saved.stageIndex) || preset.stages[saved.stageIndex]?.stageId !== saved.stageId) throw new Error('Invalid persisted game stage');
    for (const field of ['revision', 'motionSeq', 'stageElapsedMs', 'totalElapsedMs']) if (!Number.isSafeInteger(saved[field]) || saved[field] < 0) throw new Error('Invalid persisted game counter');
    for (const field of ['virtualSpeedMps', 'distanceM', 'updatedAt']) if (!finite(saved[field]) || saved[field] < 0) throw new Error('Invalid persisted game number');
    if (!Array.isArray(saved.roleAssignments) || saved.roleAssignments.length > 4 || !Array.isArray(saved.interactions) || saved.interactions.length > 3 || saved.interactions.some(id => !text(id)) || new Set(saved.interactions).size !== saved.interactions.length) throw new Error('Invalid persisted game members');
    if (saved.roleAssignments.some(item => !item || !text(item.memberId) || !MISSION_ROLES.includes(item.missionRole)) || new Set(saved.roleAssignments.map(item => item.memberId)).size !== saved.roleAssignments.length) throw new Error('Invalid persisted mission roles');
    if (typeof saved.completed !== 'boolean' || saved.completed !== (saved.stageId === 'COMPLETE') || (saved.completedAt !== null && !finite(saved.completedAt))) throw new Error('Invalid persisted completion');
    if (!saved.objectiveState || typeof saved.objectiveState.complete !== 'boolean' || !finite(saved.objectiveState.progress) || !finite(saved.objectiveState.target)) throw new Error('Invalid persisted objective');
    return { schemaVersion: 1, missionRunId: saved.missionRunId, scenarioId: saved.scenarioId, revision: saved.revision,
      motionSeq: saved.motionSeq, stageId: saved.stageId, stageIndex: saved.stageIndex,
      virtualSpeedMps: saved.virtualSpeedMps, distanceM: saved.distanceM, stageElapsedMs: saved.stageElapsedMs,
      totalElapsedMs: saved.totalElapsedMs, completed: saved.completed, completedAt: saved.completedAt,
      roleAssignments: saved.roleAssignments.map(item => ({ memberId: item.memberId, missionRole: item.missionRole })),
      interactions: [...saved.interactions], objectiveState: copy(saved.objectiveState),
      lastTransition: copy(saved.lastTransition), updatedAt: saved.updatedAt };
  }
  function durable(game) { return validated(game); }
  function restore(saved) {
    if (saved == null) return initial();
    const game = validated(saved); game.virtualSpeedMps = 0; game.motionSeq++; game.updatedAt = clock();
    return game;
  }
  function roles(game, context) {
    return (context.members ?? []).filter(member => member.approved).map(member => ({ memberId: member.memberId,
      missionRole: game.roleAssignments.find(item => item.memberId === member.memberId)?.missionRole
        ?? (member.role === 'CAR_HOST' ? 'DRIVER' : Object.hasOwn(DEFAULT_ROLE, member.seat) ? DEFAULT_ROLE[member.seat] : 'COVER') }));
  }
  function snapshot(game, context) {
    const live = runtime.get(context.roomId), current = stage(game), active = live && live.missionRunId === game.missionRunId && live.sceneId === scene(game)
      && live.roomEpoch === context.roomEpoch && live.connectionId === context.connectionId && context.state === 'PLAYING' && context.gate?.allowed;
    const currentObjective = objective(game, context);
    return { ...durable(game), objectiveState: currentObjective, sceneId: scene(game), missionStatus: game.completed ? 'COMPLETED' : context.state,
      stageTitle: current.title, drivable: current.drivable, objectives: current.objectiveId ? [copy(currentObjective)] : [],
      missionRoles: roles(game, context), driverSessionId: context.role === 'CAR_HOST' && active ? live.driverSessionId : null,
      driverControl: { throttle: active ? live.throttle : 0, brake: active ? live.brake : 0,
        inputSeq: active ? live.inputSeq : 0, inputFresh: !!active && live.receivedAt !== null && clock() - live.receivedAt <= driverLeaseMs,
        leaseRemainingMs: active && live.receivedAt !== null ? Math.max(0, driverLeaseMs - (clock() - live.receivedAt)) : 0 },
      motionPolicy: { driverLeaseMs, maxTickMs, maximumVirtualSpeedMps: 30, accelerationMps2: 6, brakingMps2: 10 } };
  }
  const outcome = (game, context, changed, events = []) => ({ data: snapshot(game, context), changed, events });
  function suspend(game, context, reason = 'SUSPENDED') {
    const existed = runtime.delete(context.roomId), moving = game.virtualSpeedMps !== 0;
    if (moving) { game.virtualSpeedMps = 0; game.motionSeq++; game.updatedAt = clock(); }
    return outcome(game, context, existed || moving, existed || moving ? [{ type: 'control.stopped', reason }] : []);
  }
  function tick(game, context) {
    const at = clock();
    if (context.state !== 'PLAYING' || !context.gate?.allowed || !context.connectionId || game.completed) return suspend(game, context, game.completed ? 'MISSION_COMPLETE' : 'GAME_NOT_ACTIVE');
    let current = runtime.get(context.roomId), changed = false;
    if (!current || current.connectionId !== context.connectionId || current.roomEpoch !== context.roomEpoch || current.sceneId !== scene(game)) {
      suspend(game, context, 'CONTROL_CONTEXT_CHANGED');
      current = { missionRunId: game.missionRunId, sceneId: scene(game), roomEpoch: context.roomEpoch, connectionId: context.connectionId,
        driverSessionId: randomUUID(), inputSeq: 0, throttle: 0, brake: 0, receivedAt: null, lastTickAt: at, inputReceipts: new Map() };
      runtime.set(context.roomId, current); changed = true;
    }
    const delta = Math.max(0, Math.min(maxTickMs, at - current.lastTickAt)); current.lastTickAt = Math.max(current.lastTickAt, at);
    if (refreshObjective(game, context)) changed = true;
    const currentStage = stage(game), fresh = current.receivedAt !== null && at - current.receivedAt <= driverLeaseMs;
    if (!fresh) { current.throttle = 0; current.brake = 1; }
    if (delta > 0) {
      game.stageElapsedMs += delta; game.totalElapsedMs += delta;
      const seconds = delta / 1000, before = game.virtualSpeedMps;
      if (currentStage.drivable && !game.objectiveState.complete) {
        const acceleration = (fresh ? current.throttle * 6 : 0) - current.brake * 10 - 1.5;
        game.virtualSpeedMps = round(Math.max(0, Math.min(30, before + acceleration * seconds)));
        game.distanceM = round(game.distanceM + (before + game.virtualSpeedMps) * .5 * seconds);
        if (currentStage.type === 'VIRTUAL_DISTANCE' && game.distanceM >= currentStage.target) {
          game.distanceM = currentStage.target; game.virtualSpeedMps = 0; current.throttle = 0; current.brake = 1;
        }
      } else game.virtualSpeedMps = 0;
      game.motionSeq++; game.updatedAt = at; changed = true;
      if (refreshObjective(game, context)) changed = true;
    }
    return outcome(game, context, changed);
  }
  function configure(game, context, input) {
    host(context); request(input, ['commandId', 'roomEpoch', 'expectedGameRevision', 'scenarioId', 'roleAssignments']); epoch(context, input); revision(game, input);
    if (context.state === 'PLAYING') throw error('GAME_REQUIRES_PAUSE', 'Pause before configuring or resetting a mission', 409);
    definition(input.scenarioId);
    const assignments = input.roleAssignments ?? [];
    if (!Array.isArray(assignments) || assignments.length > 4 || new Set(assignments.map(item => item?.memberId)).size !== assignments.length) throw error('INVALID_MISSION_ROLES', 'Distinct approved member assignments required');
    for (const item of assignments) {
      const member = context.members?.find(value => value.memberId === item?.memberId && value.approved);
      if (!item || Object.keys(item).some(key => !['memberId', 'missionRole'].includes(key)) || !member || !MISSION_ROLES.includes(item.missionRole)
        || (member.role === 'CAR_HOST') !== (item.missionRole === 'DRIVER')) throw error('INVALID_MISSION_ROLES', 'Only the host may be DRIVER; assign known mission roles to approved members');
    }
    const next = initial(input.scenarioId), previous = game.stageId; next.revision = game.revision + 1; next.roleAssignments = copy(assignments);
    Object.assign(game, next); runtime.delete(context.roomId); refreshObjective(game, context);
    return outcome(game, context, true, [{ type: 'stage.changed', stageId: game.stageId, previousStageId: previous, configured: true }]);
  }
  function advance(game, context, input) {
    host(context); request(input, ['commandId', 'roomEpoch', 'expectedGameRevision']); epoch(context, input); revision(game, input); playable(context, true);
    const preset = definition(game.scenarioId), current = stage(game);
    if (current.type === 'OPEN' || game.completed) throw error('GAME_NO_NEXT_STAGE', 'Current mission has no next stage', 409);
    if (!objective(game, context).complete) throw error('GAME_OBJECTIVE_INCOMPLETE', 'Server objective must complete before advancing', 409);
    const previous = game.stageId; game.stageIndex++; game.stageId = preset.stages[game.stageIndex].stageId;
    game.virtualSpeedMps = 0; game.stageElapsedMs = 0; game.interactions = []; game.revision++; game.motionSeq++;
    game.completed = game.stageId === 'COMPLETE'; game.completedAt = game.completed ? clock() : null;
    game.lastTransition = { from: previous, to: game.stageId, reason: 'OBJECTIVE_COMPLETE', at: clock() }; game.updatedAt = clock();
    const adjusted = game.stageId === 'DEFEND' ? { ...context, waveCleared: false } : context;
    game.objectiveState = objective(game, adjusted); runtime.delete(context.roomId);
    return outcome(game, adjusted, true, [{ type: 'stage.changed', stageId: game.stageId, previousStageId: previous, configured: false },
      ...(game.completed ? [{ type: 'mission.completed', missionRunId: game.missionRunId }] : [])]);
  }
  function interact(game, context, input) {
    request(input, ['commandId', 'roomEpoch', 'expectedGameRevision', 'objectiveId', 'action']); epoch(context, input); revision(game, input); playable(context);
    const member = approved(context);
    if (!member || member.role === 'CAR_HOST') throw error('ROLE_FORBIDDEN', 'Approved phone crew required for this interaction', 403);
    if (game.stageId !== 'INFILTRATE' || input.objectiveId !== 'TERMINALS' || input.action !== 'INTERACT') throw error('GAME_INTERACTION_UNAVAILABLE', 'This stage has no matching interaction', 409);
    if (game.interactions.includes(context.memberId)) throw error('GAME_ALREADY_INTERACTED', 'Each crew member contributes once', 409);
    if (game.interactions.length >= 2) throw error('GAME_STAGE_COMPLETE', 'Terminal objective is already complete', 409);
    game.interactions.push(context.memberId); game.revision++; game.updatedAt = clock(); game.objectiveState = objective(game, context);
    return outcome(game, context, true, [{ type: 'objective.progress', objectiveId: 'TERMINALS', progress: game.interactions.length }]);
  }
  function input(game, context, body) {
    host(context); request(body, ['commandId', 'roomEpoch', 'driverSessionId', 'inputSeq', 'throttle', 'brake']); epoch(context, body); playable(context);
    const current = runtime.get(context.roomId);
    if (!current || !text(body.driverSessionId) || current.driverSessionId !== body.driverSessionId || current.connectionId !== context.connectionId
      || current.roomEpoch !== context.roomEpoch || current.sceneId !== scene(game)) throw error('GAME_CONTROL_STALE', 'Use the current driver session from the host snapshot', 409);
    // Fixed field order canonicalizes equivalent JSON objects. This cache is
    // bound to this ephemeral driver session and never renews a held input.
    const fingerprint = JSON.stringify([body.roomEpoch, body.driverSessionId, body.inputSeq, body.throttle, body.brake]);
    if (current.inputReceipts.has(body.commandId)) {
      if (current.inputReceipts.get(body.commandId) !== fingerprint) throw error('IDEMPOTENCY_CONFLICT', 'Same game input commandId with different input', 409);
      return { ...outcome(game, context, false), replayed: true };
    }
    if (!Number.isSafeInteger(body.inputSeq) || body.inputSeq <= current.inputSeq) throw error('GAME_INPUT_ORDER', 'inputSeq must increase for this driver session', 409);
    if (!finite(body.throttle) || body.throttle < 0 || body.throttle > 1 || !finite(body.brake) || body.brake < 0 || body.brake > 1) throw error('INVALID_DRIVER_INPUT', 'throttle and brake must be finite 0..1');
    if (!stage(game).drivable || game.completed || objective(game, context).complete) throw error('GAME_SCENE_NOT_DRIVABLE', 'Current mission stage does not accept driving input', 409);
    tick(game, context);
    current.inputSeq = body.inputSeq;
    current.throttle = objective(game, context).complete ? 0 : body.throttle;
    current.brake = objective(game, context).complete ? 1 : body.brake;
    current.receivedAt = clock();
    current.inputReceipts.set(body.commandId, fingerprint);
    if (current.inputReceipts.size > GAME_INPUT_RECEIPT_LIMIT) current.inputReceipts.delete(current.inputReceipts.keys().next().value);
    game.motionSeq++; game.updatedAt = clock();
    return { ...outcome(game, context, true), replayed: false };
  }
  return { scenarios: () => copy(DEFINITIONS), initial, restore, durable, snapshot, configure, advance, interact, input, tick, suspend };
}
