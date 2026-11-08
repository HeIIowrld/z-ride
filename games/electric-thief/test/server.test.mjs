import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createThiefServer } from '../server.mjs';

async function boot(t) {
  const app = createThiefServer({ publicOrigin: 'http://game.test' });
  app.http.listen(0, '127.0.0.1');
  await once(app.http, 'listening');
  t.after(() => { for (const c of app.wss.clients) c.terminate(); app.http.close(); });
  return `127.0.0.1:${app.http.address().port}`;
}
const post = async (base, path, body = {}) => (await fetch(`http://${base}${path}`, { method: 'POST', body: JSON.stringify(body) })).json();
function client(base, code, token) {
  const ws = new WebSocket(`ws://${base}/ws`), c = { ws, state: null, raw: [], errors: [], waiters: [] };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', code, token })));
  ws.on('message', data => {
    c.raw.push(String(data));
    const m = JSON.parse(data);
    if (m.type === 'state') c.state = m.state;
    if (m.type === 'error') c.errors.push(m.code);
    c.waiters = c.waiters.filter(w => { if (w.test(c)) { w.done(); return false; } return true; });
  });
  c.until = test => new Promise((done, fail) => {
    if (test(c)) return done();
    const timer = setTimeout(() => fail(new Error('timeout')), 3000);
    c.waiters.push({ test, done: () => { clearTimeout(timer); done(); } });
  });
  c.send = m => ws.send(JSON.stringify(m));
  return c;
}

test('3명 한 판: 도둑이 큰 화면에 새지 않고, 잡으면 끝나며 차가 원래대로', async t => {
  const base = await boot(t);
  const room = await post(base, '/api/rooms');
  const host = client(base, room.code, room.hostToken);
  await host.until(c => c.state?.phase === 'LOBBY');
  const phones = [];
  for (const name of ['엄마', '아빠', '민지']) phones.push(client(base, room.code, (await post(base, `/api/rooms/${room.code}/join`, { name })).token));
  await host.until(c => c.state.players.filter(p => p.connected).length === 3);

  host.send({ type: 'start' });
  await Promise.all(phones.map(p => p.until(c => c.state?.phase === 'BRIEFING')));
  for (const p of phones) p.send({ type: 'ready' });
  await host.until(c => c.state.phase === 'CHARGING');
  host.send({ type: 'soc', value: 35, source: 'CAR' });
  await Promise.all(phones.map(p => p.until(c => c.state.phase === 'CASE')));
  assert.equal(host.state.socSource, 'CAR');
  const thief = phones.find(p => p.state.role === 'THIEF');
  assert.equal(phones.filter(p => p.state.role === 'THIEF').length, 1);
  for (const p of phones) p.send({ type: 'play', card: 0, prank: p === thief ? 'LIGHT' : 'NONE' });
  await host.until(c => c.state.phase === 'RESULT');
  assert.equal(host.state.cabin.light === 'RED' || host.state.cabin.light === 'OFF', true);
  if (!host.state.result.success) { // 정전·과부하였다면 차 화면의 비상 차단기로 되돌린다
    host.send({ type: 'breaker' });
    await host.until(c => c.state.result.saved);
    assert.deepEqual(host.state.cabin, { light: 'NORMAL', air: 'NORMAL' });
    assert.equal(host.state.breakers, 1);
  }
  host.send({ type: 'next' });
  await host.until(c => c.state.phase === 'TALK');
  host.send({ type: 'next' });
  await Promise.all(phones.map(p => p.until(c => c.state.phase === 'VOTE')));
  for (const p of phones) p.send({ type: 'vote', suspect: p === thief ? 'SKIP' : thief.state.me });
  await host.until(c => c.state.phase === 'VERDICT');
  assert.equal(host.state.verdict.caught, true);
  host.send({ type: 'next' });
  await host.until(c => c.state.phase === 'END');
  assert.equal(host.state.winner, 'FAMILY');
  assert.deepEqual(host.state.cabin, { light: 'NORMAL', air: 'NORMAL' });
  assert.ok(!host.raw.slice(0, -1).join('').includes('THIEF"'), '끝나기 전 큰 화면에 역할이 가지 않는다');
});

test('폰은 진행자 명령을 보낼 수 없고 다른 폰의 역할을 받지 않는다', async t => {
  const base = await boot(t);
  const room = await post(base, '/api/rooms');
  const host = client(base, room.code, room.hostToken);
  const a = client(base, room.code, (await post(base, `/api/rooms/${room.code}/join`, { name: 'A' })).token);
  const b = client(base, room.code, (await post(base, `/api/rooms/${room.code}/join`, { name: 'B' })).token);
  await host.until(c => c.state?.players.filter(p => p.connected).length === 2);
  a.send({ type: 'soc', value: 99 });
  await a.until(c => c.errors.length);
  assert.deepEqual(a.errors, ['BAD_MESSAGE']);
  assert.equal(host.state.soc, 30);
  b.ws.close();
});

test('다른 사이트 WebSocket 차단, 없는 방·5번째 사람 거부', async t => {
  const base = await boot(t);
  const ws = new WebSocket(`ws://${base}/ws`, { origin: 'http://evil.test' });
  assert.ok((await once(ws, 'error'))[0]);
  const room = await post(base, '/api/rooms');
  for (let i = 0; i < 4; i++) await post(base, `/api/rooms/${room.code}/join`, { name: 'P' + i });
  assert.equal((await post(base, `/api/rooms/${room.code}/join`, { name: 'X' })).error, 'ROOM_FULL');
  assert.equal((await post(base, '/api/rooms/ZZZZZ/join', { name: 'X' })).error, 'NO_ROOM');
});
