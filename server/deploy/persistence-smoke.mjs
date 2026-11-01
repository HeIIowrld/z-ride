import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// CI-only fixture: credentials go to RUNNER_TEMP, never stdout or artifacts.
// Protected deployment: pass ZRIDE_TEST_ACCESS_KEY as a private environment value.
const mode = process.argv[2];
const base = process.env.ZRIDE_SMOKE_BASE_URL ?? 'http://127.0.0.1:18000';
const stateFile = process.env.ZRIDE_SMOKE_STATE_FILE;
if (!stateFile) throw new Error('ZRIDE_SMOKE_STATE_FILE must name a private temporary file');
if (!['seed', 'verify', 'health'].includes(mode)) throw new Error('Expected seed, verify, or health');
async function request(path, body, token, method = 'POST') {
  if (path === '/api/session' && process.env.ZRIDE_TEST_ACCESS_KEY) body = { ...body, accessKey: process.env.ZRIDE_TEST_ACCESS_KEY };
  const response = await fetch(base + path, {
    method, signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${value.error?.code ?? 'HTTP_ERROR'}`);
  return value;
}
async function healthy() {
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      const health = await request('/healthz', undefined, undefined, 'GET');
      assert.equal(health.ok, true);
      assert.equal(health.protocol, 'zride-demo-v1');
      assert.ok(health.contractRevision >= 3);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
await healthy();
if (mode === 'seed') {
  const host = await request('/api/session', { role: 'CAR_HOST', nickname: 'CI host' });
  const phone = await request('/api/session', { role: 'PHONE', nickname: 'CI passenger' });
  const created = await request('/api/rooms', {}, host.token);
  const joined = await request('/api/join', { joinCode: created.joinCode, seat: 'FRONT_PASSENGER' }, phone.token);
  await request(`/api/rooms/${created.roomId}/approve`, { memberId: joined.memberId }, host.token);
  const world = await request('/api/world/nearby', { latitude: 37.5665, longitude: 126.978, radiusM: 500 }, phone.token);
  const spawn = world.spawns[0];
  assert.ok(spawn);
  const claimBody = {
    commandId: randomUUID(), spawnId: spawn.spawnId, scheduleId: world.scheduleId,
    version: spawn.version, passengerConfirmed: true,
    location: { latitude: spawn.latitude, longitude: spawn.longitude, accuracyM: 5, measuredAgeMs: 1, source: 'EMULATOR_GPS', isMock: false },
  };
  const reward = await request('/api/world/claim', claimBody, phone.token);
  assert.equal(reward.claimed, true);
  assert.equal(reward.inventory.supplies, 1);
  await writeFile(stateFile, JSON.stringify({ hostToken: host.token, phoneToken: phone.token, roomId: created.roomId, memberId: joined.memberId, claimBody }), { mode: 0o600 });
  console.log('Persistence fixture seeded: approved room, inventory=1, idempotent claim.');
} else if (mode === 'verify') {
  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  const { room } = await request(`/api/rooms/${saved.roomId}`, undefined, saved.hostToken, 'GET');
  assert.equal(room.roomId, saved.roomId);
  assert.equal(room.collection.inventory.supplies, 1);
  assert.ok(room.members.some(member => member.memberId === saved.memberId && member.approved));
  assert.equal(room.vehicle.playAllowed, false);
  assert.equal(room.vehicle.foreground, false);
  const replay = await request('/api/world/claim', saved.claimBody, saved.phoneToken);
  assert.equal(replay.replayed, true);
  assert.equal(replay.inventory.supplies, 1);
  const latest = await request(`/api/rooms/${saved.roomId}`, undefined, saved.hostToken, 'GET');
  assert.equal(latest.room.collection.inventory.supplies, 1);
  console.log('Persistence verified: same room/session/approval/inventory, one reward, unsafe vehicle gate closed.');
} else {
  console.log('Server health endpoint passed.');
}
