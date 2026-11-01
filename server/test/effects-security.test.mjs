import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createDemoServer } from '../server.mjs';

async function until(predicate, message, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timeout: ' + message);
}

test('a forbidden phone effect request cannot consume an expired native STOP before the committed timer sends it', async () => {
  let effectTime = 1000000, clockReads = 0;
  const app = createDemoServer({ leaseMs: 10000, effectsClock: () => { clockReads++; return effectTime; } });
  const address = await app.listen(0), base = `http://127.0.0.1:${address.port}`;
  const clients = [];
  async function post(path, body, token, expected = 200) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, expected, path + ': ' + value.error?.code); return value;
  }
  async function connect(token, roomId) {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws');
    const client = { socket, messages: [], room: null }; clients.push(client);
    socket.on('error', () => {});
    socket.on('message', data => { const message = JSON.parse(data); client.messages.push(message); if (message.type === 'snapshot') client.room = message.room; });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'auth', token, roomId }));
    await until(() => client.room, 'authenticated room snapshot'); return client;
  }
  async function send(client, message) {
    const commandId = randomUUID(); client.socket.send(JSON.stringify({ ...message, commandId }));
    const result = await until(() => client.messages.find(value => value.commandId === commandId), 'command result');
    assert.equal(result.ok, true, result.error?.code); return result;
  }
  try {
    const host = await post('/api/session', { role: 'CAR_HOST', nickname: 'STOP timer test host' }, null, 201);
    const phone = await post('/api/session', { role: 'PHONE', nickname: 'STOP timer test phone' }, null, 201);
    const room = await post('/api/rooms', {}, host.token, 201);
    const car = await connect(host.token, room.roomId);
    await send(car, { type: 'vehicle.report', reportSeq: 1, ux: 'ALLOWED', gear: 'P', foreground: true, seats: [{ seat: 'REAR_LEFT', occupancy: 'OCCUPIED' }], source: 'SIMULATED_API_CLIENTS' });
    const joined = await post('/api/join', { joinCode: room.joinCode, seat: 'REAR_LEFT' }, phone.token, 201);
    await post('/api/rooms/' + room.roomId + '/approve', { memberId: joined.memberId }, host.token);
    await connect(phone.token, room.roomId);
    await send(car, { type: 'command', action: 'round.start', roomEpoch: car.room.roomEpoch });
    const prefix = '/api/rooms/' + room.roomId + '/effects';
    const enabled = await post(prefix + '/session', { commandId: 'enable', enabled: true, locallyEnabled: true, channels: ['AIRFLOW'], maxIntensity01: .5,
      vehicleConnectionId: car.messages.find(message => message.type === 'auth.ok').vehicleConnectionId,
      expectedControlVersion: car.room.effects.controlVersion }, host.token);
    await post(prefix + '/scene', { commandId: 'wind', effectSessionId: enabled.effects.effectSessionId, sceneId: 'escape-01', virtualSpeedMps: 20 }, host.token);
    await until(() => car.messages.find(message => message.type === 'vehicle.effect.intent'), 'fresh wind intent');
    // Synchronize just after an ordinary non-expiring timer observation, leaving
    // a full timer interval for the deliberately forbidden HTTP request.
    const observed = clockReads;
    await until(() => clockReads > observed, 'normal effects timer observation');
    effectTime += 3001;
    const rejected = await post(prefix + '/scene', { commandId: 'forbidden-expiry', effectSessionId: enabled.effects.effectSessionId, sceneId: 'escape-01', virtualSpeedMps: 1 }, phone.token, 403);
    assert.equal(rejected.error.code, 'ROLE_FORBIDDEN');
    const stop = await until(() => car.messages.find(message => message.type === 'vehicle.effect.stop' && message.reason === 'EXPIRED'), 'committed expiry stop after forbidden request');
    assert.deepEqual(stop.channels, ['AIRFLOW']);
    const status = await fetch(base + prefix, { headers: { authorization: 'Bearer ' + host.token } });
    const snapshot = await status.json(); assert.equal(status.status, 200); assert.deepEqual(snapshot.effects.active, []);
  } finally { for (const client of clients) client.socket.terminate(); await app.close(); }
});
