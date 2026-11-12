import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createTugServer } from '../server.mjs';

async function boot(t) {
  const app = createTugServer({ publicOrigin: 'http://game.test' });
  app.http.listen(0, '127.0.0.1');
  await once(app.http, 'listening');
  const base = `127.0.0.1:${app.http.address().port}`;
  t.after(() => { for (const c of app.wss.clients) c.terminate(); app.http.close(); app.http.closeAllConnections(); });
  return { app, base };
}
const post = async (base, path, body = {}) => {
  const r = await fetch(`http://${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
function client(base, code, token) {
  const ws = new WebSocket(`ws://${base}/ws`);
  const c = { ws, state: null, errors: [], waiters: [] };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', code, token })));
  ws.on('message', data => {
    const m = JSON.parse(data);
    if (m.type === 'state') c.state = m.state;
    if (m.type === 'error') c.errors.push(m.code);
    c.waiters = c.waiters.filter(w => { if (w.test(c)) { w.done(); return false; } return true; });
  });
  c.until = (test, ms = 3000) => new Promise((done, fail) => {
    if (test(c)) return done();
    const timer = setTimeout(() => fail(new Error('timeout ' + test)), ms);
    c.waiters.push({ test, done: () => { clearTimeout(timer); done(); } });
  });
  c.send = m => ws.send(JSON.stringify(m));
  return c;
}

test('정적 파일과 차량 SDK를 보안 헤더와 함께 준다', async t => {
  const { base } = await boot(t);
  for (const path of ['/', '/p', '/host.js', '/phone.js', '/zride-car.js']) {
    const r = await fetch(`http://${base}${path}`);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  }
});

test('방을 열고 두 명이 들어와 연타로 한 판을 끝낸다', async t => {
  const { base } = await boot(t);
  const room = await post(base, '/api/rooms');
  assert.match(room.body.joinUrl, /^http:\/\/game\.test\/p#[A-Z0-9]{5}$/);
  const host = client(base, room.body.code, room.body.hostToken);
  const a = await post(base, `/api/rooms/${room.body.code}/join`, { name: '엄마' });
  const b = await post(base, `/api/rooms/${room.body.code}/join`, { name: '아빠' });
  const pa = client(base, room.body.code, a.body.token), pb = client(base, room.body.code, b.body.token);
  await host.until(c => c.state?.players.length === 2 && c.state.players.every(p => p.connected));
  assert.equal(pa.state.me, a.body.playerId);
  assert.deepEqual(host.state.players.map(p => p.team), ['MINT', 'PINK']);

  host.send({ type: 'start' });
  await pa.until(c => c.state?.phase === 'PULL', 5000);
  // 민트이 계속 두드린다. 초당 16번 상한이라 끝에 닿는 데 몇 초 걸린다
  const timer = setInterval(() => pa.send({ type: 'tap', n: 2 }), 120);
  t.after(() => clearInterval(timer));
  await host.until(c => c.state?.phase === 'ROUND_END', 15000);
  clearInterval(timer);
  assert.equal(host.state.roundWinner, 'MINT');
  assert.equal(host.state.wins.MINT, 1);
  assert.ok(pb.state.players.find(p => p.id === a.body.playerId).taps > 0);
});

test('잘못된 토큰과 이상한 메시지는 막는다', async t => {
  const { base } = await boot(t);
  const room = await post(base, '/api/rooms');
  const bad = client(base, room.body.code, 'nope');
  const [code] = await once(bad.ws, 'close');
  assert.equal(code, 4401);
  const a = await post(base, `/api/rooms/${room.body.code}/join`, { name: 'x' });
  const pa = client(base, room.body.code, a.body.token);
  await pa.until(c => c.state);
  pa.send({ type: 'start' });
  await pa.until(c => c.errors.includes('BAD_MESSAGE'));
  assert.equal((await post(base, `/api/rooms/${room.body.code}/join`, { name: '  ' })).status, 400);
});
