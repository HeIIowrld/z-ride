import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createDemoServer } from '../server.mjs';

test('team host leaves phone seats free, rotates one-use invite, approves, starts and pauses on timed exit', { timeout: 15000 }, async () => {
  const accessKey = 'fixture-only-team-host-enrollment';
  const app = createDemoServer({ testAccessKey: accessKey });
  const address = await app.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const invitePath = fileURLToPath(new URL('../../work/team-host-test-' + randomUUID() + '.private.json', import.meta.url));
  let child, phoneSocket, output = '';
  const post = async (path, body, token) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
    assert.ok(response.ok, 'HTTP ' + response.status + ' ' + path);
    return response.json();
  };
  const until = async check => {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolveTick => setTimeout(resolveTick, 50)); }
    throw new Error('team host condition timed out');
  };
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL('../tools/team-host.mjs', import.meta.url)), '--base', base, '--durationsec', '5', '--invite-file', invitePath], { env: { ...process.env, ZRIDE_TEST_ACCESS_KEY: accessKey }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => resolveExit(code)); });
    child.stdout.on('data', bytes => { output += bytes.toString('utf8'); });
    child.stderr.resume();
    const initial = await until(async () => { try { return JSON.parse(await readFile(invitePath, 'utf8')); } catch { return null; } });
    assert.deepEqual(initial.freeSeats, ['FRONT_PASSENGER', 'REAR_LEFT', 'REAR_RIGHT']);
    assert.equal(initial.source, 'SIMULATED_API_CLIENTS');
    assert.equal(Object.hasOwn(initial, 'token'), false);
    const phone = await post('/api/session', { role: 'PHONE', nickname: 'Harness passenger', accessKey });
    await post('/api/join', { joinCode: initial.joinCode, seat: 'REAR_LEFT' }, phone.token);
    phoneSocket = new WebSocket(base.replace('http:', 'ws:') + '/ws');
    phoneSocket.on('error', () => {});
    await new Promise((resolveOpen, reject) => { phoneSocket.once('open', resolveOpen); phoneSocket.once('error', reject); });
    phoneSocket.send(JSON.stringify({ type: 'auth', token: phone.token, roomId: initial.roomId }));
    const active = await until(async () => {
      const response = await fetch(base + '/api/rooms/' + initial.roomId, { headers: { authorization: 'Bearer ' + phone.token } });
      const value = (await response.json()).room;
      return value?.state === 'PLAYING' ? value : null;
    });
    assert.equal(active.members.filter(member => member.role !== 'CAR_HOST').length, 1);
    assert.equal(active.members.find(member => member.seat === 'REAR_LEFT').approved, true);
    assert.equal(active.vehicle.source, 'SIMULATED_API_CLIENTS');
    await until(async () => {
      const current = JSON.parse(await readFile(invitePath, 'utf8'));
      return current.joinCode && current.joinCode !== initial.joinCode && current.freeSeats.length === 2;
    });
    assert.equal(await exited, 0);
    const stopped = JSON.parse(await readFile(invitePath, 'utf8'));
    assert.equal(stopped.status, 'STOPPED'); assert.equal(stopped.joinCode, null);
    const final = await (await fetch(base + '/api/rooms/' + initial.roomId, { headers: { authorization: 'Bearer ' + phone.token } })).json();
    assert.equal(final.room.state, 'PAUSED');
    assert.equal(output.includes(accessKey), false);
    assert.equal(output.includes(initial.joinCode), false);
    assert.equal(output.includes(phone.token), false);
  } finally {
    phoneSocket?.terminate();
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await app.close();
    await rm(invitePath, { force: true });
    await rm(invitePath + '.partial', { force: true });
  }
});
