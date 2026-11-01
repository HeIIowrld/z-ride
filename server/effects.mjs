import { createHash, randomUUID } from 'node:crypto';

export const EFFECT_CHANNELS = Object.freeze(['AIRFLOW', 'AMBIENT', 'AUDIO']);
export const EFFECT_CUES = Object.freeze(['DANGER', 'HIT', 'ESCAPE']);
export const EFFECT_REPORT_STATUSES = Object.freeze(['RECEIVED', 'DISPATCHED', 'APPLIED_CONFIRMED', 'UNSUPPORTED', 'REJECTED_GATE', 'USER_OVERRIDDEN', 'FAILED', 'STOPPED']);
export const EFFECT_DEFAULT_TTL_MS = 3000;
export const EFFECT_MAX_TTL_MS = 5000;

const error = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, maximum = 128) => typeof value === 'string' && value.length > 0 && value.length <= maximum;
const number = value => typeof value === 'number' && Number.isFinite(value);
const copy = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = (operation, body) => createHash('sha256').update(JSON.stringify([operation, canonical(body)])).digest('hex');
const PROGRESS = Object.freeze({ ISSUED: -1, RECEIVED: 0, DISPATCHED: 1, APPLIED_CONFIRMED: 2 });
const TERMINAL = new Set(['UNSUPPORTED', 'REJECTED_GATE', 'USER_OVERRIDDEN', 'FAILED', 'STOPPED', 'EXPIRED', 'SUPERSEDED']);

/** Ephemeral effect authorization. No intent, opt-in, receipt or report belongs in the durable room checkpoint. */
export function createEffectsService({ clock = Date.now, maxReceipts = 10000, maxRecords = 256 } = {}) {
  if (!Number.isSafeInteger(maxReceipts) || maxReceipts < 1 || !Number.isSafeInteger(maxRecords) || maxRecords < 3) throw new Error('Invalid effects capacity');
  const states = new Map();
  const now = () => clock();
  function blank(roomId) {
    return { roomId, enabled: false, effectSessionId: null, connectionId: null, roomEpoch: null, sceneId: null,
      virtualSpeedMps: 0, channels: [], maxIntensity01: 0, effectSeq: 0, active: new Map(), records: new Map(),
      receipts: new Map(), controlVersion: 0, lastReport: null, lastStopReason: 'NOT_ENABLED', updatedAt: now() };
  }
  function state(roomId) {
    let value = states.get(roomId);
    if (!value) { value = blank(roomId); states.set(roomId, value); }
    return value;
  }
  function project(value) {
    return copy({ protocol: 'zride-effects-v1', roomId: value.roomId, enabled: value.enabled, effectSessionId: value.effectSessionId,
      roomEpoch: value.roomEpoch, controlVersion: value.controlVersion, sceneId: value.sceneId, virtualSpeedMps: value.virtualSpeedMps,
      channels: value.channels, maxIntensity01: value.maxIntensity01, effectSeq: value.effectSeq,
      active: [...value.active.values()].map(id => value.records.get(id)).filter(Boolean).map(record => ({
        effectId: record.intent.effectId, effectSeq: record.intent.effectSeq, sceneId: record.intent.sceneId,
        channel: record.intent.channel, cue: record.intent.cue, intensity01: record.intent.intensity01,
        issuedAt: record.intent.issuedAt, expiresAt: record.intent.expiresAt, status: record.status,
        observedValue: record.lastReport?.observedValue ?? null,
      })), lastReport: value.lastReport, lastStopReason: value.lastStopReason, updatedAt: value.updatedAt });
  }
  function snapshot(roomId) { return project(states.get(roomId) ?? blank(roomId)); }
  function host(context) {
    if (!context || context.role !== 'CAR_HOST') throw error('ROLE_FORBIDDEN', 'Only the room vehicle host may control effects', 403);
    if (!text(context.roomId)) throw error('ROOM_REQUIRED', 'Current room required');
  }
  function playing(context) {
    host(context);
    if (!text(context.connectionId)) throw error('EFFECT_CONNECTION_REQUIRED', 'A current authenticated vehicle connection is required', 409);
    if (!context.gate?.allowed) throw error('GATE_CLOSED', 'Fresh P, allowed UX and active vehicle app are required', 409);
    if (context.state !== 'PLAYING') throw error('NOT_PLAYING', 'Start the parked game before enabling or issuing effects', 409);
  }
  function active(context, value) {
    playing(context);
    if (!value.enabled) throw error('EFFECT_SESSION_REQUIRED', 'Explicitly enable effects for this vehicle connection', 409);
    if (value.connectionId !== context.connectionId || value.roomEpoch !== context.roomEpoch) throw error('EFFECT_SESSION_STALE', 'Enable a new effect session for the current connection and round', 409);
  }
  function body(input, allowed) {
    if (!object(input)) throw error('INVALID_EFFECT_REQUEST', 'JSON object required');
    if (!text(input.commandId)) throw error('COMMAND_ID_REQUIRED', 'Unique commandId required');
    if (Object.keys(input).some(key => !allowed.includes(key))) throw error('INVALID_EFFECT_REQUEST', 'Unknown effect request field');
  }
  function receipt(value, context, operation, input, stopping = false) {
    const digest = fingerprint(operation, input), old = value.receipts.get(input.commandId);
    if (old) {
      if (old.digest !== digest) throw error('IDEMPOTENCY_CONFLICT', 'Same commandId with a different effect request', 409);
      if (old.connectionId !== context.connectionId || old.roomEpoch !== context.roomEpoch) throw error('EFFECT_SESSION_STALE', 'Past effect requests cannot be replayed on a new connection or round', 409);
      if (operation !== 'stop' && old.effectSessionId !== value.effectSessionId) throw error('EFFECT_SESSION_STALE', 'Past effect requests cannot re-enable or replay stopped effects', 409);
      return { digest, replay: { data: copy(old.data), events: [], changed: false, replayed: true } };
    }
    // Receipt pressure may deny another cue, but must never deny an explicit stop.
    if (value.receipts.size >= maxReceipts && operation !== 'stop' && !stopping) throw error('COMMAND_LIMIT', 'Effect receipt limit reached; no action applied', 429);
    return { digest, replay: null };
  }
  function finish(value, context, input, digest, data, events = [], changed = true) {
    if (value.receipts.size < maxReceipts || value.receipts.has(input.commandId)) value.receipts.set(input.commandId, { digest, connectionId: context.connectionId, roomEpoch: context.roomEpoch,
      effectSessionId: value.effectSessionId, data: copy(data) });
    return { data: copy(data), events: copy(events), changed, replayed: false };
  }
  function stopChannels(value, channels, reason, events) {
    if (!channels.length || !value.effectSessionId) return false;
    for (const channel of channels) {
      const record = value.records.get(value.active.get(channel));
      if (record && !TERMINAL.has(record.status)) record.status = reason === 'EXPIRED' ? 'EXPIRED' : 'STOPPED';
      value.active.delete(channel);
    }
    events.push({ type: 'vehicle.effect.stop', schemaVersion: 1, roomId: value.roomId, roomEpoch: value.roomEpoch,
      effectSessionId: value.effectSessionId, effectSeq: ++value.effectSeq, channels: [...channels], reason, issuedAt: now() });
    value.updatedAt = now(); return true;
  }
  function invalidate(value, reason, explicit = false, bumpVersion = true) {
    if (!value.enabled) {
      if (!explicit) return { data: project(value), events: [], changed: false, replayed: false };
      value.controlVersion++; value.lastStopReason = reason; value.updatedAt = now();
      return { data: project(value), events: [], changed: true, replayed: false };
    }
    const events = [];
    // Stop every opted-in channel, including one whose most recent cue has already expired locally.
    stopChannels(value, value.channels, reason, events);
    value.enabled = false; value.effectSessionId = null; value.connectionId = null;
    if (bumpVersion) value.controlVersion++;
    value.channels = []; value.sceneId = null; value.virtualSpeedMps = 0; value.lastStopReason = reason; value.updatedAt = now();
    return { data: project(value), events, changed: true, replayed: false };
  }
  function stop(context, reasonOrBody = 'USER_STOP') {
    if (object(reasonOrBody)) {
      host(context); body(reasonOrBody, ['commandId']);
      const value = state(context.roomId), checked = receipt(value, context, 'stop', reasonOrBody);
      if (checked.replay) return checked.replay;
      const result = invalidate(value, 'USER_STOP', true);
      return finish(value, context, reasonOrBody, checked.digest, result.data, result.events, result.changed);
    }
    const value = states.get(context.roomId);
    return value ? invalidate(value, String(reasonOrBody).slice(0, 64)) : { data: snapshot(context.roomId), events: [], changed: false, replayed: false };
  }
  function session(context, input) {
    host(context); body(input, ['commandId', 'enabled', 'locallyEnabled', 'channels', 'maxIntensity01', 'vehicleConnectionId', 'expectedControlVersion']);
    if (typeof input.enabled !== 'boolean') throw error('INVALID_EFFECT_REQUEST', 'Explicit enabled boolean required');
    const value = state(context.roomId);
    if (!input.enabled) {
      const checked = receipt(value, context, 'session', input, true);
      if (checked.replay) return checked.replay;
      const result = invalidate(value, 'USER_STOP', true);
      return finish(value, context, input, checked.digest, result.data, result.events, result.changed);
    }
    playing(context);
    if (input.locallyEnabled !== true) throw error('EFFECT_LOCAL_OPT_IN_REQUIRED', 'The vehicle user must explicitly enable physical effects', 409);
    if (!Array.isArray(input.channels) || !input.channels.length || input.channels.length > EFFECT_CHANNELS.length || new Set(input.channels).size !== input.channels.length || input.channels.some(channel => !EFFECT_CHANNELS.includes(channel))) throw error('INVALID_EFFECT_CHANNELS', 'Explicit locally supported enabled channels required');
    if (!number(input.maxIntensity01) || input.maxIntensity01 < 0 || input.maxIntensity01 > 1) throw error('INVALID_EFFECT_INTENSITY', 'maxIntensity01 must be 0..1');
    const checked = receipt(value, context, 'session', input); if (checked.replay) return checked.replay;
    if (!text(input.vehicleConnectionId) || input.vehicleConnectionId !== context.connectionId) throw error('EFFECT_SESSION_STALE', 'Enable request must bind the current vehicle connection', 409);
    if (!Number.isSafeInteger(input.expectedControlVersion) || input.expectedControlVersion < 0 || input.expectedControlVersion !== value.controlVersion) throw error('EFFECT_CONTROL_STALE', 'Refresh the current effect control version before enabling', 409);
    const previous = invalidate(value, 'SESSION_REPLACED', false, false);
    value.enabled = true; value.effectSessionId = randomUUID(); value.connectionId = context.connectionId;
    value.roomEpoch = context.roomEpoch; value.controlVersion++; value.sceneId = null; value.virtualSpeedMps = 0;
    value.channels = [...input.channels]; value.maxIntensity01 = input.maxIntensity01; value.effectSeq = 0;
    value.active.clear(); value.records.clear(); value.lastReport = null; value.lastStopReason = null; value.updatedAt = now();
    return finish(value, context, input, checked.digest, project(value), previous.events);
  }
  function duration(input) {
    const result = input.durationMs ?? EFFECT_DEFAULT_TTL_MS;
    if (!Number.isInteger(result) || result < 100 || result > EFFECT_MAX_TTL_MS) throw error('INVALID_EFFECT_DURATION', 'durationMs must be an integer 100..5000');
    return result;
  }
  function sceneId(input) {
    if (!text(input.sceneId, 64) || !/^[A-Za-z0-9_.:-]+$/.test(input.sceneId)) throw error('INVALID_EFFECT_SCENE', 'sceneId must be 1..64 ASCII letters, digits, dot, colon, underscore or hyphen');
  }
  function trimRecords(value) {
    if (value.records.size < maxRecords) return;
    for (const [id, record] of value.records) {
      if (value.active.get(record.intent.channel) !== id) value.records.delete(id);
      if (value.records.size < maxRecords) return;
    }
    throw error('EFFECT_CAPACITY', 'Effect history capacity reached', 429);
  }
  function intent(value, channel, cue, intensity, ttl, events) {
    const old = value.records.get(value.active.get(channel)); if (old) old.status = 'SUPERSEDED';
    value.active.delete(channel); trimRecords(value);
    const issuedAt = now();
    const event = { type: 'vehicle.effect.intent', schemaVersion: 1, roomId: value.roomId, roomEpoch: value.roomEpoch,
      effectSessionId: value.effectSessionId, effectId: randomUUID(), effectSeq: ++value.effectSeq,
      sceneId: value.sceneId, channel, cue, intensity01: Math.min(intensity, value.maxIntensity01),
      transitionMs: channel === 'AIRFLOW' ? 500 : 200, issuedAt, expiresAt: issuedAt + ttl };
    value.records.set(event.effectId, { intent: event, status: 'ISSUED', lastReport: null });
    value.active.set(channel, event.effectId); events.push(event); value.updatedAt = issuedAt; return event;
  }
  function scene(context, input) {
    host(context); body(input, ['commandId', 'effectSessionId', 'sceneId', 'virtualSpeedMps']); sceneId(input);
    if (!number(input.virtualSpeedMps) || input.virtualSpeedMps < 0 || input.virtualSpeedMps > 100) throw error('INVALID_VIRTUAL_SPEED', 'virtualSpeedMps must be finite and 0..100');
    const value = state(context.roomId); active(context, value);
    if (!text(input.effectSessionId) || input.effectSessionId !== value.effectSessionId) throw error('EFFECT_SESSION_STALE', 'Scene request must bind the current effect session', 409);
    const checked = receipt(value, context, 'scene', input); if (checked.replay) return checked.replay;
    const events = [];
    if (value.sceneId && value.sceneId !== input.sceneId) stopChannels(value, [...value.active.keys()], 'SCENE_CHANGED', events);
    value.sceneId = input.sceneId; value.virtualSpeedMps = input.virtualSpeedMps;
    const intents = value.channels.includes('AIRFLOW') ? [intent(value, 'AIRFLOW', 'DRIVE_WIND', Math.min(input.virtualSpeedMps / 30, 1) * value.maxIntensity01, EFFECT_DEFAULT_TTL_MS, events)] : [];
    value.updatedAt = now();
    return finish(value, context, input, checked.digest, { effects: project(value), intents }, events);
  }
  function cue(context, input) {
    host(context); body(input, ['commandId', 'effectSessionId', 'sceneId', 'cue', 'intensity01', 'durationMs']); sceneId(input);
    if (!EFFECT_CUES.includes(input.cue)) throw error('INVALID_EFFECT_CUE', 'cue must be DANGER, HIT or ESCAPE');
    if (!number(input.intensity01) || input.intensity01 < 0 || input.intensity01 > 1) throw error('INVALID_EFFECT_INTENSITY', 'intensity01 must be 0..1');
    const ttl = duration(input), value = state(context.roomId); active(context, value);
    if (!text(input.effectSessionId) || input.effectSessionId !== value.effectSessionId) throw error('EFFECT_SESSION_STALE', 'Cue request must bind the current effect session', 409);
    if (!value.sceneId || input.sceneId !== value.sceneId) throw error('EFFECT_SCENE_MISMATCH', 'Set the current virtual scene before requesting this cue', 409);
    const channels = value.channels.filter(channel => channel === 'AMBIENT' || channel === 'AUDIO');
    if (!channels.length) throw error('EFFECT_CHANNEL_UNAVAILABLE', 'No locally enabled visual or audio cue channel', 409);
    const checked = receipt(value, context, 'cue', input); if (checked.replay) return checked.replay;
    const events = [], intents = channels.map(channel => intent(value, channel, input.cue, input.intensity01, ttl, events));
    return finish(value, context, input, checked.digest, { effects: project(value), intents }, events);
  }
  function report(context, input) {
    host(context); body(input, ['type', 'commandId', 'effectSessionId', 'effectId', 'effectSeq', 'status', 'observedValue']);
    if (!text(input.effectSessionId) || !text(input.effectId) || !Number.isSafeInteger(input.effectSeq) || input.effectSeq < 1 || !EFFECT_REPORT_STATUSES.includes(input.status)) throw error('INVALID_EFFECT_REPORT', 'Effect session, ID, sequence and a known execution status required');
    if (Object.hasOwn(input, 'observedValue') && input.observedValue !== null && typeof input.observedValue !== 'boolean' && !number(input.observedValue)) throw error('INVALID_EFFECT_REPORT', 'observedValue must be a finite number, boolean or null');
    if (input.status === 'APPLIED_CONFIRMED' && (input.observedValue === undefined || input.observedValue === null)) throw error('INVALID_EFFECT_REPORT', 'Actual scalar observation required for APPLIED_CONFIRMED');
    const value = state(context.roomId); active(context, value);
    if (input.effectSessionId !== value.effectSessionId) throw error('EFFECT_SESSION_STALE', 'Execution report belongs to a different effect session', 409);
    const record = value.records.get(input.effectId);
    if (!record || record.intent.effectSeq !== input.effectSeq) throw error('EFFECT_NOT_FOUND', 'Unknown effect ID or sequence', 404);
    if (record.intent.expiresAt <= now()) throw error('EFFECT_EXPIRED', 'Expired effects cannot be confirmed or replayed', 409);
    const checked = receipt(value, context, 'report', input); if (checked.replay) return checked.replay;
    if (value.active.get(record.intent.channel) !== input.effectId || TERMINAL.has(record.status)) throw error('EFFECT_SUPERSEDED', 'Effect is no longer active', 409);
    if (Object.hasOwn(PROGRESS, input.status) && PROGRESS[input.status] < PROGRESS[record.status]) throw error('EFFECT_REPORT_REGRESSION', 'Execution status cannot move backwards', 409);
    const observedValue = input.observedValue ?? null;
    if (input.status === record.status) {
      if (observedValue !== (record.lastReport?.observedValue ?? null)) throw error('EFFECT_REPORT_CONFLICT', 'Same execution status cannot change its observation', 409);
      return finish(value, context, input, checked.digest, { effects: project(value), report: copy(record.lastReport) }, [], false);
    }
    const receivedAt = now();
    const execution = { effectId: input.effectId, effectSeq: input.effectSeq, channel: record.intent.channel,
      status: input.status, observedValue, receivedAt };
    record.status = input.status; record.lastReport = execution; value.lastReport = execution; value.updatedAt = receivedAt;
    const events = [];
    if (TERMINAL.has(input.status)) {
      value.active.delete(record.intent.channel);
      stopChannels(value, [record.intent.channel], input.status, events);
      if (['USER_OVERRIDDEN', 'UNSUPPORTED'].includes(input.status)) value.channels = value.channels.filter(channel => channel !== record.intent.channel);
      if (input.status === 'REJECTED_GATE') events.push(...invalidate(value, 'VEHICLE_REJECTED_GATE').events);
    }
    return finish(value, context, input, checked.digest, { effects: project(value), report: execution }, events);
  }
  function tick(context) {
    const value = states.get(context.roomId);
    if (!value?.enabled) return { data: snapshot(context.roomId), events: [], changed: false, replayed: false };
    if (context.connectionId !== value.connectionId) return invalidate(value, 'CONNECTION_CHANGED');
    if (context.roomEpoch !== value.roomEpoch) return invalidate(value, 'ROUND_CHANGED');
    if (!context.gate?.allowed) return invalidate(value, 'GATE_CLOSED');
    if (context.state !== 'PLAYING') return invalidate(value, 'NOT_PLAYING');
    const channels = [...value.active.keys()].filter(channel => value.records.get(value.active.get(channel)).intent.expiresAt <= now());
    const events = [];
    const changed = stopChannels(value, channels, 'EXPIRED', events);
    return { data: project(value), events, changed, replayed: false };
  }
  return { session, scene, cue, report, stop, tick, snapshot };
}
