import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createDemoServer } from '../server.mjs';

test('configured team key gates both guest roles without storing or echoing enrollment key', async () => {
  const accessKey = 'fixture-only-enrollment-value';
  const saved = [];
  const app = createDemoServer({ testAccessKey: accessKey, stateStore: { load() { return null; }, save(state) { saved.push(JSON.stringify(state)); }, close() {} } });
  const address = await app.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const session = body => fetch(base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const health = await (await fetch(base + '/healthz')).json();
    assert.deepEqual(Object.keys(health).sort(), ['contractRevision', 'ok', 'protocol']);
    assert.equal(health.contractRevision, 8);
    for (const role of ['CAR_HOST', 'PHONE']) {
      for (const supplied of [undefined, '', 'wrong', 123, { value: accessKey }, accessKey + 'x']) {
        const rejected = await session({ role, nickname: 'Test', accessKey: supplied });
        assert.equal(rejected.status, 401);
        assert.equal((await rejected.json()).error.code, 'TEST_ACCESS_REQUIRED');
      }
      const response = await session({ role, nickname: 'Test', accessKey });
      assert.equal(response.status, 201);
      const created = await response.json();
      assert.equal(created.role, role);
      assert.equal(JSON.stringify(created).includes(accessKey), false);
      if (role === 'CAR_HOST') {
        const room = await fetch(base + '/api/rooms', { method: 'POST', headers: { authorization: 'Bearer ' + created.token } });
        assert.equal(room.status, 201, 'issued bearer works without sending enrollment key again');
      }
    }
    assert.ok(saved.length > 0);
    assert.equal(saved.some(value => value.includes(accessKey)), false);
  } finally { await app.close(); }
});

test('local fixtures can omit enrollment protection; independent operator key never enrolls', async () => {
  const local = createDemoServer();
  const address = await local.listen(0);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'PHONE', nickname: 'Local' }) })).status, 201);
  } finally { await local.close(); }
  const protectedApp = createDemoServer({ testAccessKey: 'fixture-enroll', observerToken: 'fixture-observe' });
  const protectedAddress = await protectedApp.listen(0);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${protectedAddress.port}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'PHONE', nickname: 'Observe', accessKey: 'fixture-observe' }) })).status, 401);
  } finally { await protectedApp.close(); }
});

test('browser game socket accepts its served host and rejects unrelated Origin', async () => {
  const app = createDemoServer();
  const address = await app.listen(0);
  const origin = `http://127.0.0.1:${address.port}`;
  const sockets = [];
  try {
    for (const validOrigin of [origin, undefined]) {
      const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { origin: validOrigin });
      sockets.push(ws);
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    }
    const forbidden = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { origin: 'https://unrelated.invalid' });
    forbidden.on('error', () => {});
    const status = await new Promise((resolve, reject) => {
      forbidden.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode); });
      forbidden.once('open', () => reject(new Error('foreign Origin was accepted')));
      forbidden.once('error', reject);
    });
    forbidden.terminate();
    assert.equal(status, 403);
  } finally { for (const ws of sockets) ws.terminate(); await app.close(); }
});
