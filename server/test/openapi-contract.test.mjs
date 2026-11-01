import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EFFECT_CHANNELS, EFFECT_REPORT_STATUSES, EFFECT_DEFAULT_TTL_MS, EFFECT_MAX_TTL_MS } from '../effects.mjs';
import { CABIN_AVAILABILITY, CABIN_SOURCES, CABIN_FRESHNESS_MS } from '../cabin.mjs';
import { createGameStateService, MISSION_ROLES } from '../game-state.mjs';

const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
const protocol = JSON.parse(readFileSync(new URL('../protocol.json', import.meta.url), 'utf8'));
const methods = new Set(['get','post','put','patch','delete','options','head','trace']);

test('OpenAPI covers exactly the implemented REST route inventory', () => {
  assert.equal(spec.openapi, '3.1.0');
  const actual = Object.entries(spec.paths).flatMap(([path,item]) => Object.keys(item).filter(m => methods.has(m)).map(m => `${m.toUpperCase()} ${path}`)).sort();
  assert.deepEqual(actual, protocol.http.map(r => `${r.method} ${r.path}`).sort());
  assert.equal(actual.length, 21);
  assert.equal(spec.paths['/ws'], undefined, 'WS is a separate appendix, not an HTTP operation');
  assert.equal(spec.paths['/observer/ws'], undefined, 'Observer WS is also a separate appendix');
  const ids = Object.values(spec.paths).flatMap(p => Object.entries(p).filter(([m]) => methods.has(m)).map(([,op]) => op.operationId));
  assert.equal(new Set(ids).size, actual.length);
});

test('OpenAPI has resolvable local refs, explicit auth and exact world policy', () => {
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      assert.ok(value.$ref.startsWith('#/'));
      const resolved = value.$ref.slice(2).split('/').reduce((at,key) => at?.[key.replaceAll('~1','/').replaceAll('~0','~')], spec);
      assert.notEqual(resolved, undefined, value.$ref);
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(spec);
  assert.deepEqual(spec.security, [{bearerAuth:[]}]);
  assert.deepEqual(spec.paths['/healthz'].get.security, []);
  assert.deepEqual(spec.paths['/api/session'].post.security, []);
  assert.equal(spec.components.schemas.PhoneLocation.properties.accuracyM.maximum, protocol.worldPolicy.maxAccuracyM);
  assert.equal(spec.components.schemas.PhoneLocation.properties.measuredAgeMs.maximum, protocol.worldPolicy.maxMeasuredAgeMs);
  assert.equal(spec.components.schemas.LocationPolicy.properties.collectRadiusM.const, protocol.worldPolicy.collectRadiusM);
  assert.equal(spec.components.schemas.ClaimRequest.properties.version.const, protocol.worldPolicy.worldVersion);
});

test('OpenAPI distinguishes read-only operator authorization and durable-storage failure', () => {
  assert.deepEqual(spec.paths['/api/observer/rooms'].get.security, [{observerOperatorAuth:[]}]);
  assert.equal(spec.components.securitySchemes.observerOperatorAuth.scheme, 'bearer');
  assert.equal(spec.components.schemas.ObserverRoomsResponse.properties.readOnly.const, true);
  assert.equal(spec.components.schemas.ObserverRoomSummary.additionalProperties, false);
  assert.equal(spec.components.schemas.HealthUnavailable.properties.ok.const, false);
  assert.equal(spec.paths['/healthz'].get.responses['503'].content['application/json'].schema.$ref, '#/components/schemas/HealthUnavailable');
  for (const [path, item] of Object.entries(spec.paths)) {
    if (path === '/healthz') continue;
    for (const [method, operation] of Object.entries(item)) {
      if (methods.has(method)) assert.ok(operation.responses['503']['x-error-codes'].includes('STORAGE_UNAVAILABLE'), path);
    }
  }
  assert.equal(protocol.persistence.formatVersion, 1);
  assert.equal(protocol.observer.readOnly, true);
  assert.equal(protocol.observer.viewMode, 'SERVER_STATE_NOT_SCREEN_CAPTURE');
  assert.equal(spec['x-observer-websocket'].path, protocol.observer.webSocketPath);
});

test('4D contract separates logical API state from native-only physical effect execution', () => {
  const base = '/api/rooms/{roomId}/effects';
  assert.equal(spec.paths[base].get.operationId, 'getVehicleEffects');
  for (const action of ['session', 'scene', 'cue', 'stop']) {
    const operation = spec.paths[base + '/' + action].post;
    assert.ok(operation.requestBody.required);
    assert.ok(operation.responses['409']);
  }
  assert.equal(spec.paths[base + '/report'], undefined, 'Native execution reports belong to the authenticated current game WebSocket');
  assert.deepEqual(spec.components.schemas.EffectChannel.enum, protocol.vehicleEffects.channels);
  assert.deepEqual(spec.components.schemas.EffectReportStatus.enum, protocol.vehicleEffects.reportStatuses);
  assert.deepEqual(spec.components.schemas.EffectChannel.enum, EFFECT_CHANNELS);
  assert.deepEqual(spec.components.schemas.EffectReportStatus.enum, EFFECT_REPORT_STATUSES);
  assert.equal(spec.components.schemas.EffectCueRequest.properties.durationMs.default, EFFECT_DEFAULT_TTL_MS);
  assert.equal(spec.components.schemas.EffectCueRequest.properties.durationMs.maximum, EFFECT_MAX_TTL_MS);
  assert.equal(spec.components.schemas.EffectSceneRequest.properties.virtualSpeedMps.maximum, 100);
  assert.ok(spec.components.schemas.EffectSceneRequest.required.includes('effectSessionId'));
  assert.ok(spec.components.schemas.EffectCueRequest.required.includes('effectSessionId'));
  assert.ok(spec.components.schemas.EffectSummary.required.includes('controlVersion'));
  assert.ok(spec.components.schemas.EffectSessionRequest.allOf[0].then.required.includes('vehicleConnectionId'));
  assert.ok(spec.components.schemas.EffectSessionRequest.allOf[0].then.required.includes('expectedControlVersion'));
  assert.equal(spec.components.schemas.Health.properties.contractRevision.const, 6);
  assert.equal(protocol.vehicleEffects.executionReport.type, 'vehicle.effect.report');
  assert.ok(spec.paths[base + '/scene'].post.responses['409']['x-error-codes'].includes('GAME_SCENE_MANAGED'));
});

test('server-state contract separates durable mission data from driver/cabin/effect authority', () => {
  const base = '/api/rooms/{roomId}';
  assert.equal(spec.paths['/api/scenarios'].get.operationId, 'getScenarioCatalog');
  assert.equal(spec.paths[base + '/state'].get.operationId, 'getRoomState');
  for (const action of ['configure', 'input', 'advance', 'interact']) {
    const operation = spec.paths[base + '/game/' + action].post;
    assert.ok(operation.requestBody.required);
    assert.ok(operation.responses['409']);
  }
  assert.deepEqual(spec.components.schemas.GameConfigureRequest.properties.scenarioId.enum,
    createGameStateService().scenarios().map(item => item.scenarioId));
  assert.deepEqual(spec.components.schemas.MissionRole.enum, MISSION_ROLES);
  assert.deepEqual(spec.components.schemas.CabinAvailability.enum, CABIN_AVAILABILITY);
  assert.deepEqual(spec.components.schemas.CabinSource.enum, CABIN_SOURCES);
  assert.equal(spec.components.schemas.CabinSnapshot.properties.freshnessMs.const, CABIN_FRESHNESS_MS);
  assert.equal(spec.components.schemas.CabinSnapshot.properties.hardwareAttested.const, false);
  assert.ok(spec.components.schemas.GameInputRequest.required.includes('driverSessionId'));
  assert.ok(spec.components.schemas.GameInputRequest.required.includes('inputSeq'));
  assert.equal(spec.components.schemas.GameInputRequest.properties.expectedGameRevision, undefined,
    'Frequent driver inputs use a control session and sequence, not a racing per-tick revision');
  assert.equal(spec.components.schemas.GameLogicalState.properties.driverSessionId, undefined);
  assert.equal(spec.components.schemas.GameLogicalState.properties.driverControl, undefined);
  assert.equal(spec['x-cabin-websocket'].messageSchema.$ref, '#/components/schemas/CabinReport');
  assert.equal(protocol.serverState.revision, 6);
  assert.equal(protocol.cabin.reportType, 'vehicle.cabin.report');
  assert.equal(spec.paths['/api/rooms'].post.requestBody.required, false);
  assert.ok(spec.paths['/api/rooms'].post.responses['400']['x-error-codes'].includes('INVALID_JSON'));
  assert.ok(spec.paths['/api/rooms'].post.responses['413']['x-error-codes'].includes('PAYLOAD_TOO_LARGE'));
});
