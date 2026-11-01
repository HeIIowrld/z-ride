import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
const protocol = JSON.parse(readFileSync(new URL('../protocol.json', import.meta.url), 'utf8'));
const methods = new Set(['get','post','put','patch','delete','options','head','trace']);

test('OpenAPI covers exactly the implemented REST route inventory', () => {
  assert.equal(spec.openapi, '3.1.0');
  const actual = Object.entries(spec.paths).flatMap(([path,item]) => Object.keys(item).filter(m => methods.has(m)).map(m => `${m.toUpperCase()} ${path}`)).sort();
  assert.deepEqual(actual, protocol.http.map(r => `${r.method} ${r.path}`).sort());
  assert.equal(actual.length, 9);
  assert.equal(spec.paths['/ws'], undefined, 'WS is a separate appendix, not an HTTP operation');
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
