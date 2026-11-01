import { createHash } from 'node:crypto';

export const CABIN_AVAILABILITY = Object.freeze(['AVAILABLE', 'UNKNOWN', 'UNSUPPORTED', 'PERMISSION_DENIED', 'UNAVAILABLE']);
export const CABIN_SOURCES = Object.freeze(['PLEOS_READ', 'PLEOS_CALLBACK', 'SIMULATED', 'NONE']);
export const CABIN_SEATS = Object.freeze(['DRIVER', 'FRONT_PASSENGER', 'REAR_LEFT', 'REAR_RIGHT']);
export const CABIN_FRESHNESS_MS = 6000;
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const text = (value, max = 128) => typeof value === 'string' && value.length > 0 && value.length <= max;
const copy = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fields = (value, allowed) => {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail('INVALID_CABIN_REPORT', 'Cabin report has an unknown field or invalid object');
};
const positiveInteger = value => Number.isSafeInteger(value) && value >= 1;

/** Current-connection, client-reported observations. Never serialize this service to the game checkpoint. */
export function createCabinService({ clock = Date.now, freshnessMs = CABIN_FRESHNESS_MS, maxReceipts = 256 } = {}) {
  if (!Number.isSafeInteger(freshnessMs) || freshnessMs < 1 || !Number.isSafeInteger(maxReceipts) || maxReceipts < 1) throw new Error('Invalid cabin service configuration');
  const states = new Map();
  function blank(roomId, revision = 0, reason = 'NOT_REPORTED') {
    return { roomId, connectionId: null, revision, reportSeq: 0, receivedAt: null, observations: new Map(), staleKeys: new Set(), receipts: new Map(), resetReason: reason };
  }
  function context(input, host = false) {
    if (!input || !text(input.roomId)) throw fail('ROOM_REQUIRED', 'Current room is required');
    if (host && input.role !== 'CAR_HOST') throw fail('ROLE_FORBIDDEN', 'Only the current vehicle may report cabin observations', 403);
    if (host && !text(input.connectionId)) throw fail('CABIN_CONNECTION_REQUIRED', 'A current authenticated vehicle connection is required', 409);
  }
  function validateObservation(input, kind) {
    const extra = kind === 'hvac' ? ['areaId', 'power', 'fanSpeed', 'fanMin', 'fanMax'] : kind === 'energy' ? ['socPercent'] : ['seat', 'buckled'];
    fields(input, ['sampleSeq', 'availability', 'measuredAgeMs', 'source', ...extra]);
    if (!positiveInteger(input.sampleSeq) || !CABIN_AVAILABILITY.includes(input.availability) || !CABIN_SOURCES.includes(input.source)) throw fail('INVALID_CABIN_OBSERVATION', 'Explicit sequence, availability and known source are required');
    if (kind === 'belt' && !CABIN_SEATS.includes(input.seat)) throw fail('INVALID_CABIN_SEAT', 'Known cabin seat is required');
    if (kind === 'hvac' && input.areaId !== undefined && input.areaId !== null && (!text(input.areaId, 96) || !/^[\x20-\x7e]+$/.test(input.areaId))) throw fail('INVALID_CABIN_AREA', 'areaId must be bounded printable ASCII');
    const available = input.availability === 'AVAILABLE';
    const valueFields = kind === 'hvac' ? ['power', 'fanSpeed', 'fanMin', 'fanMax'] : kind === 'energy' ? ['socPercent'] : ['buckled'];
    if (!available) {
      if (input.source !== 'NONE' || input.measuredAgeMs != null || valueFields.some(key => input[key] != null)) throw fail('INVALID_CABIN_OBSERVATION', 'Unavailable observations must have NONE source and no asserted value or age');
    } else {
      if (input.source === 'NONE' || !Number.isSafeInteger(input.measuredAgeMs) || input.measuredAgeMs < 0 || input.measuredAgeMs > 60000) throw fail('INVALID_CABIN_OBSERVATION', 'Available observations require a reported source and age 0..60000 ms');
      if (kind === 'hvac' && (!text(input.areaId, 96) || typeof input.power !== 'boolean' || !finite(input.fanMin) || !finite(input.fanMax) || !finite(input.fanSpeed) || input.fanMin < 0 || input.fanMax <= input.fanMin || input.fanSpeed < input.fanMin || input.fanSpeed > input.fanMax)) throw fail('INVALID_CABIN_OBSERVATION', 'HVAC power and a valid reported fan range/value are required');
      if (kind === 'belt' && typeof input.buckled !== 'boolean') throw fail('INVALID_CABIN_OBSERVATION', 'Available belt observations require an explicit boolean');
      if (kind === 'energy' && (!finite(input.socPercent) || input.socPercent < 0 || input.socPercent > 100)) throw fail('INVALID_CABIN_OBSERVATION', 'SOC must be finite and 0..100 percent');
    }
    const normalized = { sampleSeq: input.sampleSeq, availability: input.availability, measuredAgeMs: available ? input.measuredAgeMs : null, source: input.source };
    for (const key of extra) normalized[key] = input[key] ?? null;
    // Age can advance while a client repeats a cached sample. It must never
    // move that sample's server-established origin forward.
    const semantic = { ...normalized }; delete semantic.measuredAgeMs;
    return { normalized, semanticDigest: digest(semantic) };
  }
  function observation(value, key, kind, at) {
    const stored = value.observations.get(key);
    if (!stored) {
      const values = kind === 'hvac' ? { areaId: null, power: null, fanSpeed: null, fanMin: null, fanMax: null, normalizedFan01: null } : kind === 'energy' ? { socPercent: null } : { seat: key.slice(5), buckled: null };
      return { ...values, availability: 'UNKNOWN', sampleSeq: 0, source: 'NONE', receivedAt: null, ageMs: null, quality: 'UNKNOWN' };
    }
    const input = stored.value;
    const ageMs = input.availability === 'AVAILABLE' ? Math.max(0, at - stored.sampledAt) : null;
    const quality = input.availability === 'AVAILABLE' ? ageMs <= freshnessMs && !value.staleKeys.has(key) ? 'FRESH' : 'STALE' : input.availability === 'UNKNOWN' ? 'UNKNOWN' : 'UNAVAILABLE';
    const projected = { ...input, receivedAt: stored.receivedAt, ageMs, quality }; delete projected.measuredAgeMs;
    if (kind === 'hvac') projected.normalizedFan01 = input.availability === 'AVAILABLE' ? (input.fanSpeed - input.fanMin) / (input.fanMax - input.fanMin) : null;
    return projected;
  }
  function project(input, value = states.get(input.roomId), at = clock()) {
    const connected = text(input.connectionId) && value?.connectionId === input.connectionId;
    const current = connected ? value : blank(input.roomId, value?.revision ?? 0, value?.connectionId ? 'CONNECTION_CHANGED' : value?.resetReason ?? 'NOT_REPORTED');
    const hvac = observation(current, 'hvac', 'hvac', at), energy = observation(current, 'energy', 'energy', at);
    const seatBelts = CABIN_SEATS.map(seat => observation(current, 'belt:' + seat, 'belt', at));
    const gateAllowed = connected && input.gate?.allowed === true;
    const purificationReason = !gateAllowed ? 'GATE_CLOSED' : input.airflowControlled === true ? 'AIRFLOW_EFFECT_ACTIVE' : hvac.quality !== 'FRESH' ? 'HVAC_NOT_FRESH' : !hvac.power ? 'HVAC_OFF' : 'AVAILABLE';
    const purification01 = purificationReason === 'AVAILABLE' ? hvac.normalizedFan01 : 0;
    const crew = (Array.isArray(input.members) ? input.members : []).filter(member => CABIN_SEATS.includes(member.seat)).slice(0, 4).map(member => {
      const belt = seatBelts.find(item => item.seat === member.seat);
      const reason = !member.approved ? 'MEMBER_PENDING' : !gateAllowed ? 'GATE_CLOSED' : member.seatEvidence === 'EMPTY' ? 'SEAT_EMPTY' : belt.quality !== 'FRESH' ? 'BELT_NOT_FRESH' : belt.buckled !== true ? 'BELT_UNBUCKLED' : 'AVAILABLE';
      return { memberId: text(member.memberId) ? member.memberId : null, seat: member.seat, approved: member.approved === true,
        seatEvidence: ['SENSOR', 'EMPTY', 'MANUAL_UNKNOWN'].includes(member.seatEvidence) ? member.seatEvidence : 'MANUAL_UNKNOWN',
        ready: reason === 'AVAILABLE', beltProtection: reason === 'AVAILABLE', reason };
    });
    return copy({ protocol: 'zride-cabin-v1', roomId: input.roomId, revision: current.revision, connected: !!connected, reportSeq: current.reportSeq,
      receivedAt: current.receivedAt, reportAgeMs: current.receivedAt == null ? null : Math.max(0, at - current.receivedAt),
      freshnessMs, resetReason: current.resetReason, hardwareAttested: false, trust: 'CLIENT_REPORTED_NOT_ATTESTED',
      hvac, seatBelts, energy, derived: { purificationInputEligible: purificationReason === 'AVAILABLE', fanInput01: purification01, purificationInputReason: purificationReason, crew } });
  }
  function snapshot(input) { context(input); return project(input); }
  function report(input, body) {
    context(input, true);
    fields(body, ['type', 'commandId', 'vehicleConnectionId', 'reportSeq', 'hvac', 'seatBelts', 'energy']);
    if (body.type !== undefined && body.type !== 'vehicle.cabin.report') throw fail('INVALID_CABIN_REPORT', 'Known cabin report type required');
    if (!text(body.commandId)) throw fail('COMMAND_ID_REQUIRED', 'Unique commandId is required');
    if (body.vehicleConnectionId !== input.connectionId) throw fail('CABIN_CONNECTION_STALE', 'Bind the current vehicle connection', 409);
    if (!positiveInteger(body.reportSeq)) throw fail('INVALID_CABIN_REPORT', 'Increasing reportSeq is required');
    if (body.hvac === undefined && body.seatBelts === undefined && body.energy === undefined) throw fail('INVALID_CABIN_REPORT', 'At least one cabin observation is required');
    const before = states.get(input.roomId), sameConnection = before?.connectionId === input.connectionId;
    const value = sameConnection ? before : blank(input.roomId, before?.revision ?? 0, before ? 'CONNECTION_CHANGED' : 'NOT_REPORTED');
    const bodyDigest = digest(body), receipt = value.receipts.get(body.commandId);
    if (receipt) {
      if (receipt !== bodyDigest) throw fail('IDEMPOTENCY_CONFLICT', 'Same commandId with a different cabin report', 409);
      return { data: project(input, value), changed: false, replayed: true };
    }
    if (body.reportSeq <= value.reportSeq) throw fail('CABIN_STALE_REPORT', 'reportSeq must increase on this vehicle connection', 409);
    const prepared = [];
    if (body.hvac !== undefined) prepared.push(['hvac', validateObservation(body.hvac, 'hvac')]);
    if (body.energy !== undefined) prepared.push(['energy', validateObservation(body.energy, 'energy')]);
    if (body.seatBelts !== undefined) {
      if (!Array.isArray(body.seatBelts) || !body.seatBelts.length || body.seatBelts.length > 4 || new Set(body.seatBelts.map(item => item?.seat)).size !== body.seatBelts.length) throw fail('INVALID_CABIN_SEAT', 'One to four unique cabin seats are required');
      for (const item of body.seatBelts) { const preparedBelt = validateObservation(item, 'belt'); prepared.push(['belt:' + item.seat, preparedBelt]); }
    }
    for (const [key, candidate] of prepared) {
      const old = value.observations.get(key);
      if (old && candidate.normalized.sampleSeq < old.value.sampleSeq) throw fail('CABIN_STALE_SAMPLE', 'Signal sampleSeq must not move backwards', 409);
      if (old && candidate.normalized.sampleSeq === old.value.sampleSeq && candidate.semanticDigest !== old.semanticDigest) throw fail('CABIN_SAMPLE_CONFLICT', 'Same signal sampleSeq cannot change its value or availability', 409);
    }
    const at = clock(), next = { ...value, connectionId: input.connectionId, revision: value.revision + 1, reportSeq: body.reportSeq,
      receivedAt: at, resetReason: null, observations: new Map(value.observations), staleKeys: new Set(value.staleKeys), receipts: new Map(value.receipts) };
    for (const [key, candidate] of prepared) {
      if (next.observations.get(key)?.value.sampleSeq === candidate.normalized.sampleSeq) continue;
      next.observations.set(key, { value: candidate.normalized, semanticDigest: candidate.semanticDigest,
        receivedAt: at, sampledAt: candidate.normalized.measuredAgeMs == null ? null : at - candidate.normalized.measuredAgeMs });
      next.staleKeys.delete(key);
    }
    for (const [key, sample] of next.observations) if (sample.value.availability === 'AVAILABLE' && at - sample.sampledAt > freshnessMs) next.staleKeys.add(key);
    if (next.receipts.size >= maxReceipts) next.receipts.delete(next.receipts.keys().next().value);
    next.receipts.set(body.commandId, bodyDigest); states.set(input.roomId, next);
    return { data: project(input, next, at), changed: true, replayed: false };
  }
  function reset(input, reason = 'RESET') {
    context(input);
    const before = states.get(input.roomId);
    if (!before?.connectionId) return { data: project(input, before), changed: false, replayed: false };
    const next = blank(input.roomId, before.revision + 1, String(reason).slice(0, 64));
    states.set(input.roomId, next);
    return { data: project(input, next), changed: true, replayed: false };
  }
  function tick(input) {
    context(input);
    const before = states.get(input.roomId);
    if (before?.connectionId && before.connectionId !== input.connectionId) return reset(input, 'CONNECTION_CHANGED');
    const at = clock();
    const expired = before ? [...before.observations].filter(([key, sample]) => sample.value.availability === 'AVAILABLE' && !before.staleKeys.has(key) && at - sample.sampledAt > freshnessMs).map(([key]) => key) : [];
    if (expired.length) {
      const next = { ...before, revision: before.revision + 1, staleKeys: new Set([...before.staleKeys, ...expired]) };
      states.set(input.roomId, next);
      return { data: project(input, next, at), changed: true, replayed: false };
    }
    // An ordinary vehicle heartbeat cannot revive a confirmed stale sample.
    return { data: project(input, before), changed: false, replayed: false };
  }
  return { report, snapshot, tick, reset };
}
