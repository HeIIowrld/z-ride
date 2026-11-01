import test from 'node:test';
import assert from 'node:assert/strict';
import { createCabinService, CABIN_SEATS } from '../cabin.mjs';

const hvac = (sampleSeq = 1, extra = {}) => ({ sampleSeq, availability: 'AVAILABLE', measuredAgeMs: 0, source: 'PLEOS_CALLBACK',
  areaId: '[ROW_1_LEFT, ROW_1_RIGHT]', power: true, fanSpeed: 4, fanMin: 0, fanMax: 8, ...extra });
const belt = (seat = 'REAR_LEFT', buckled = true, sampleSeq = 1, extra = {}) => ({ seat, buckled, sampleSeq,
  availability: 'AVAILABLE', measuredAgeMs: 0, source: 'PLEOS_READ', ...extra });
const unavailable = (availability = 'UNKNOWN', sampleSeq = 1) => ({ sampleSeq, availability, source: 'NONE', measuredAgeMs: null });
const code = (run, expected) => assert.throws(run, error => error.code === expected);
function fixture(options = {}) {
  let time = 100000, command = 0;
  const service = createCabinService({ clock: () => time, ...options });
  const context = { roomId: 'cabin-room', role: 'CAR_HOST', connectionId: 'car-connection-1', gate: { allowed: true }, airflowControlled: false,
    members: [{ memberId: 'driver', seat: 'DRIVER', approved: true, seatEvidence: 'SENSOR' },
      { memberId: 'left', seat: 'REAR_LEFT', approved: true, seatEvidence: 'MANUAL_UNKNOWN' },
      { memberId: 'right', seat: 'REAR_RIGHT', approved: false, seatEvidence: 'SENSOR' }] };
  const body = extra => ({ type: 'vehicle.cabin.report', commandId: 'cabin-' + (++command), vehicleConnectionId: context.connectionId,
    reportSeq: command, hvac: hvac(), seatBelts: [belt(), belt('DRIVER', false)], ...extra });
  return { service, context, body, report: extra => service.report(context, body(extra)), snapshot: () => service.snapshot(context), advance: value => { time += value; } };
}

test('cabin telemetry is current-vehicle only and invalid observations cannot partially change state', () => {
  const f = fixture();
  code(() => f.service.report({ ...f.context, role: 'PHONE' }, f.body()), 'ROLE_FORBIDDEN');
  code(() => f.report({ vehicleConnectionId: 'old-connection' }), 'CABIN_CONNECTION_STALE');
  code(() => f.service.report({ ...f.context, connectionId: null }, f.body()), 'CABIN_CONNECTION_REQUIRED');
  f.report(); const before = f.snapshot();
  code(() => f.report({ hvac: hvac(2, { fanSpeed: 5 }), seatBelts: [belt('REAR_LEFT', false, 1)] }), 'CABIN_SAMPLE_CONFLICT');
  assert.deepEqual(f.snapshot(), before, 'invalid belt must not commit the otherwise valid new HVAC sample');
  for (const invalid of [NaN, Infinity, -1, 9]) code(() => f.report({ hvac: hvac(2, { fanSpeed: invalid }) }), 'INVALID_CABIN_OBSERVATION');
  code(() => f.report({ hvac: hvac(2, { fanMax: 0 }) }), 'INVALID_CABIN_OBSERVATION');
  code(() => f.report({ unknown: true }), 'INVALID_CABIN_REPORT');
  code(() => f.report({ seatBelts: [belt(), belt()] }), 'INVALID_CABIN_SEAT');
  assert.deepEqual(f.snapshot(), before);
});

test('fresh reported cabin state distinguishes false from unknown and exposes only derived eligibility', () => {
  const f = fixture();
  const initial = f.snapshot(); assert.equal(initial.connected, false); assert.equal(initial.hvac.power, null);
  assert.deepEqual(initial.seatBelts.map(item => item.seat), CABIN_SEATS);
  assert.equal(initial.seatBelts[0].buckled, null);
  const actual = f.report({ energy: { sampleSeq: 1, availability: 'AVAILABLE', measuredAgeMs: 20, source: 'SIMULATED', socPercent: 67 } }).data;
  assert.equal(actual.hvac.quality, 'FRESH'); assert.equal(actual.hvac.normalizedFan01, .5);
  assert.equal(actual.derived.purificationInputEligible, true); assert.equal(actual.derived.fanInput01, .5);
  assert.equal(actual.derived.crew.find(item => item.memberId === 'left').beltProtection, true);
  assert.equal(actual.derived.crew.find(item => item.memberId === 'driver').reason, 'BELT_UNBUCKLED');
  assert.equal(actual.seatBelts.find(item => item.seat === 'REAR_RIGHT').buckled, null);
  assert.equal(actual.energy.socPercent, 67); assert.equal(actual.hardwareAttested, false);
  assert.equal(actual.trust, 'CLIENT_REPORTED_NOT_ATTESTED');
  assert.equal('connectionId' in actual, false); assert.equal('receipts' in actual, false); assert.equal('commandId' in actual, false);
  actual.hvac.fanSpeed = 99; actual.derived.crew[0].ready = true;
  assert.equal(f.snapshot().hvac.fanSpeed, 4, 'projection cannot mutate source state');
});

test('heartbeat and idempotent replay cannot renew the same signal sample or revive confirmed staleness', () => {
  const f = fixture(); const firstBody = f.body();
  const first = f.service.report(f.context, firstBody); assert.equal(first.changed, true);
  f.advance(4000);
  const replay = f.service.report(f.context, firstBody); assert.equal(replay.replayed, true); assert.equal(replay.changed, false);
  assert.equal(replay.data.hvac.ageMs, 4000); assert.equal(replay.data.receivedAt, first.data.receivedAt);
  f.report(); assert.equal(f.snapshot().hvac.ageMs, 4000, 'new reportSeq with cached sampleSeq does not refresh it');
  f.advance(2001); assert.equal(f.service.tick(f.context).changed, true); assert.equal(f.service.tick(f.context).changed, false);
  assert.equal(f.snapshot().hvac.quality, 'STALE'); assert.equal(f.snapshot().derived.purificationInputEligible, false);
  assert.equal(f.snapshot().derived.crew.find(item => item.memberId === 'left').ready, false);
  f.report(); assert.equal(f.snapshot().hvac.quality, 'STALE', 'claimed age zero on the same sample still cannot revive it');
  f.advance(-4000); assert.equal(f.snapshot().hvac.quality, 'STALE', 'a server wall-clock rollback cannot revive a confirmed stale sample');
  f.report({ hvac: hvac(2), seatBelts: [belt('REAR_LEFT', true, 2)] });
  assert.equal(f.snapshot().hvac.quality, 'FRESH'); assert.equal(f.snapshot().derived.fanInput01, .5);
});

test('sample sequence conflicts and evicted report receipts still cannot freshen old observations', () => {
  const f = fixture({ maxReceipts: 1 }); const original = f.body(); f.service.report(f.context, original);
  f.report({ hvac: hvac(2), seatBelts: [belt('REAR_LEFT', true, 2)] }); const before = f.snapshot();
  code(() => f.service.report(f.context, original), 'CABIN_STALE_REPORT');
  code(() => f.report({ hvac: hvac(1) }), 'CABIN_STALE_SAMPLE');
  assert.deepEqual(f.snapshot(), before);
  const next = f.body({ hvac: hvac(3), seatBelts: [belt('REAR_LEFT', false, 3)] });
  f.service.report(f.context, next);
  code(() => f.service.report(f.context, { ...next, hvac: hvac(3, { fanSpeed: 5 }) }), 'IDEMPOTENCY_CONFLICT');
});

test('gate, 4D airflow ownership, pending members and empty seats suppress gameplay eligibility', () => {
  const f = fixture(); f.report();
  const revision = f.snapshot().revision;
  f.context.airflowControlled = true;
  assert.equal(f.snapshot().derived.fanInput01, 0); assert.equal(f.snapshot().derived.purificationInputReason, 'AIRFLOW_EFFECT_ACTIVE');
  assert.equal(f.snapshot().derived.crew.find(item => item.memberId === 'left').beltProtection, true);
  f.context.members[1].seatEvidence = 'EMPTY';
  assert.equal(f.snapshot().derived.crew.find(item => item.memberId === 'left').reason, 'SEAT_EMPTY');
  assert.equal(f.snapshot().derived.crew.find(item => item.memberId === 'right').reason, 'MEMBER_PENDING');
  f.context.gate.allowed = false;
  assert.equal(f.snapshot().derived.crew[0].reason, 'GATE_CLOSED'); assert.equal(f.snapshot().derived.fanInput01, 0);
  assert.equal(f.snapshot().revision, revision, 'context projection does not silently mutate stored observations');
});

test('availability remains distinct and asserted unavailable values are rejected', () => {
  const f = fixture();
  const actual = f.report({ hvac: unavailable('UNSUPPORTED'), seatBelts: [{ ...unavailable('PERMISSION_DENIED'), seat: 'REAR_LEFT' }], energy: unavailable('UNAVAILABLE') }).data;
  assert.equal(actual.hvac.availability, 'UNSUPPORTED'); assert.equal(actual.hvac.fanSpeed, null); assert.equal(actual.hvac.quality, 'UNAVAILABLE');
  assert.equal(actual.seatBelts.find(item => item.seat === 'REAR_LEFT').availability, 'PERMISSION_DENIED');
  assert.equal(actual.energy.availability, 'UNAVAILABLE'); assert.equal(actual.energy.socPercent, null);
  code(() => f.report({ hvac: { ...unavailable('UNKNOWN', 2), power: false } }), 'INVALID_CABIN_OBSERVATION');
  code(() => f.report({ seatBelts: [{ ...unavailable('UNKNOWN', 2), seat: 'REAR_LEFT', buckled: false }] }), 'INVALID_CABIN_OBSERVATION');
  code(() => f.report({ hvac: hvac(2, { source: 'NONE' }) }), 'INVALID_CABIN_OBSERVATION');
  code(() => f.report({ energy: { ...hvac(2), socPercent: 101 } }), 'INVALID_CABIN_REPORT');
});

test('connection replacement and restart cannot retain cabin values or protections', () => {
  const f = fixture(); f.report(); const before = f.snapshot();
  f.context.connectionId = 'car-connection-2';
  const hidden = f.snapshot(); assert.equal(hidden.connected, false); assert.equal(hidden.hvac.power, null);
  assert.equal(hidden.derived.crew.find(item => item.memberId === 'left').beltProtection, false);
  assert.equal(f.service.tick(f.context).changed, true); assert.equal(f.service.tick(f.context).changed, false);
  assert.equal(f.snapshot().resetReason, 'CONNECTION_CHANGED');
  code(() => f.service.report(f.context, { ...f.body(), vehicleConnectionId: 'car-connection-1' }), 'CABIN_CONNECTION_STALE');
  const next = f.report({ reportSeq: 1 }).data; assert.equal(next.reportSeq, 1); assert.ok(next.revision > before.revision);
  const restarted = createCabinService(); assert.equal(restarted.snapshot(f.context).hvac.power, null);
  f.context.connectionId = null; assert.equal(f.service.tick(f.context).changed, true);
  assert.equal(f.snapshot().energy.socPercent, null); assert.equal(f.snapshot().derived.fanInput01, 0);
});
