import { createHash, randomUUID } from 'node:crypto';

export const WORLD_VERSION = 'seoul-demo-v1';
export const LOCATION_POLICY = Object.freeze({ collectRadiusM: 80, maxAccuracyM: 50, maxMeasuredAgeMs: 10000, maxQueryRadiusM: 2000 });
const SOURCES = ['ANDROID_GPS', 'ANDROID_NETWORK', 'ANDROID_FUSED', 'EMULATOR_GPS', 'MOCK'];
const POINTS = Object.freeze([
  { spawnId: 'SEOUL_CITYHALL_TEST_A', latitude: 37.5665, longitude: 126.9780, title: '서울 시청 주변 테스트 보급 A' },
  { spawnId: 'SEOUL_CITYHALL_TEST_B', latitude: 37.5669, longitude: 126.9783, title: '서울 시청 주변 테스트 보급 B' },
  { spawnId: 'SEOUL_CITYHALL_TEST_C', latitude: 37.5659, longitude: 126.9775, title: '서울 시청 주변 테스트 보급 C' },
]);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function distanceMeters(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const hav = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(hav), Math.sqrt(Math.max(0, 1 - hav)));
}
function coordinate(input) {
  if (!input || !finite(input.latitude) || !finite(input.longitude) || input.latitude < -90 || input.latitude > 90 || input.longitude < -180 || input.longitude > 180) throw fail('INVALID_COORDINATE', 'WGS84 latitude -90..90 and longitude -180..180 required');
  return { latitude: input.latitude, longitude: input.longitude };
}
function checkedLocation(input) {
  const point = coordinate(input);
  if (!finite(input.accuracyM) || input.accuracyM <= 0 || input.accuracyM > LOCATION_POLICY.maxAccuracyM) throw fail('LOCATION_INACCURATE', 'Reported accuracy must be >0 and <=50 metres', 409);
  if (!finite(input.measuredAgeMs) || input.measuredAgeMs < 0 || input.measuredAgeMs > LOCATION_POLICY.maxMeasuredAgeMs) throw fail('LOCATION_STALE', 'Reported measurement age must be 0..10000 milliseconds', 409);
  if (!SOURCES.includes(input.source) || typeof input.isMock !== 'boolean') throw fail('LOCATION_SOURCE_REQUIRED', 'Explicit source and isMock boolean required');
  const validationTier = input.isMock || ['EMULATOR_GPS', 'MOCK'].includes(input.source) ? 'MOCK_DEMO' : 'CLIENT_REPORTED';
  return { ...point, accuracyM: input.accuracyM, measuredAgeMs: input.measuredAgeMs, locationSource: input.source, isMock: input.isMock, validationTier };
}

export function createWorldService({ clock = Date.now, maxReceipts = 10000 } = {}) {
  function schedule() {
    const now = clock(); const date = new Date(now).toISOString().slice(0, 10);
    const opensAt = Date.parse(date + 'T00:00:00.000Z');
    return { now, scheduleId: date, opensAt, expiresAt: opensAt + 86400000 };
  }
  function spawns() {
    const period = schedule();
    return { ...period, items: POINTS.map(p => ({ ...p, resource: 'supplies', amount: 1,
      collectRadiusM: LOCATION_POLICY.collectRadiusM, opensAt: period.opensAt, expiresAt: period.expiresAt,
      scheduleId: period.scheduleId, version: WORLD_VERSION, pointKind: 'TEST_GAME_POINT_NOT_CHARGER' })) };
  }
  function claims(member) {
    if (!member.worldClaims) member.worldClaims = new Map();
    return member.worldClaims;
  }
  function nearby(member, input) {
    const center = coordinate(input); const radiusM = input.radiusM ?? 500;
    if (!finite(radiusM) || radiusM < 1 || radiusM > LOCATION_POLICY.maxQueryRadiusM) throw fail('INVALID_RADIUS', 'radiusM must be 1..2000 metres');
    const world = spawns();
    return { worldVersion: WORLD_VERSION, scheduleId: world.scheduleId, serverTime: world.now,
      spawns: world.items.filter(p => distanceMeters(center, p) <= radiusM).map(p => ({ ...p, claimed: claims(member).has(world.scheduleId + ':' + p.spawnId) })),
      locationPolicy: LOCATION_POLICY, pointKind: 'TEST_GAME_POINT_NOT_CHARGER',
      browsingIsNotLocationProof: true, hardwareAttested: false };
  }
  function observe(member, body) {
    if (body.passengerConfirmed !== true) throw fail('PASSENGER_CONFIRMATION_REQUIRED', 'Confirm passenger role', 403);
    const location = checkedLocation(body.location);
    const receivedAt = clock();
    member.locationQualitySummary = { receivedAt, expiresAt: receivedAt + 30000,
      source: location.locationSource, validationTier: location.validationTier,
      accuracyM: location.accuracyM, measuredAgeMs: location.measuredAgeMs };
    // The raw latitude/longitude is intentionally not retained or broadcast.
    return { locationReceiptId: randomUUID(), receivedAt, expiresAt: receivedAt + 30000,
      locationValidated: true, hardwareAttested: false, validationTier: location.validationTier,
      locationSource: location.locationSource, purpose: 'QUALITY_INPUT_CHECK_ONLY_NOT_VISIT_PROOF' };
  }
  function claim(room, member, body) {
    if (!body || typeof body.commandId !== 'string' || body.commandId.length < 1 || body.commandId.length > 128) throw fail('COMMAND_ID_REQUIRED', 'Unique commandId required');
    if (body.passengerConfirmed !== true) throw fail('PASSENGER_CONFIRMATION_REQUIRED', 'Confirm passenger role', 403);
    if (!member.worldReceipts) member.worldReceipts = new Map();
    const fingerprint = hash(body); const old = member.worldReceipts.get(body.commandId);
    if (old) {
      if (old.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', 'Same commandId with different request', 409);
      return { ...old.response, replayed: true };
    }
    if (member.worldReceipts.size >= maxReceipts) throw fail('COMMAND_LIMIT', 'Demo world receipt capacity reached', 429);
    const world = spawns(); const spawn = world.items.find(p => p.spawnId === body.spawnId);
    if (!spawn) throw fail('SPAWN_NOT_FOUND', 'Known Seoul test game spawn required', 404);
    if (body.scheduleId !== world.scheduleId) throw fail('SPAWN_EXPIRED', 'Current nearby scheduleId is required', 409);
    if (body.version !== WORLD_VERSION) throw fail('WORLD_VERSION_CONFLICT', 'Current spawn version is required', 409);
    if (world.now < spawn.opensAt || world.now >= spawn.expiresAt) throw fail('SPAWN_EXPIRED', 'Spawn is not active', 409);
    const key = world.scheduleId + ':' + spawn.spawnId;
    if (claims(member).has(key)) throw fail('ALREADY_CLAIMED', 'This passenger already claimed this spawn in this UTC schedule', 409);
    const location = checkedLocation(body.location);
    const distanceM = distanceMeters(location, spawn);
    if (distanceM > spawn.collectRadiusM) throw fail('OUTSIDE_SPAWN', 'Reported location is outside the 80 metre collection radius', 409);
    claims(member).set(key, { at: world.now, validationTier: location.validationTier });
    room.collection.inventory.supplies += spawn.amount;
    // Do not broadcast the spawn ID/coordinates from another phone's claim.
    room.collection.lastCollect = { memberId: member.memberId, pickupId: 'WORLD_CLAIM', amount: spawn.amount,
      at: world.now, mode: 'WORLD_CLIENT_LOCATION', validationTier: location.validationTier };
    const response = { claimed: true, spawnId: spawn.spawnId, scheduleId: world.scheduleId, version: WORLD_VERSION,
      amount: spawn.amount, inventory: { ...room.collection.inventory },
      locationValidated: true, hardwareAttested: false, validationTier: location.validationTier,
      locationSource: location.locationSource, isMock: location.isMock, distanceM: Math.round(distanceM * 100) / 100,
      pointKind: 'TEST_GAME_POINT_NOT_CHARGER', receivedAt: world.now, replayed: false };
    member.worldReceipts.set(body.commandId, { fingerprint, response });
    return response;
  }
  function pruneQuality(member) {
    if (member.locationQualitySummary?.expiresAt <= clock()) delete member.locationQualitySummary;
  }
  return { nearby, observe, claim, pruneQuality };
}
