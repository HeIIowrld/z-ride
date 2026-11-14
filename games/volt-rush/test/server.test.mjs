import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createVoltServer } from '../server.mjs';

async function boot(t) {
  const app = createVoltServer({ publicOrigin: 'http://game.test' });
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

test('방을 열고 두 명이 들어와 움직이고 아이템을 쓴다', async t => {
  const { base } = await boot(t);
  const room = await post(base, '/api/rooms');
  assert.match(room.body.joinUrl, /^http:\/\/game\.test\/p#[A-Z0-9]{5}$/);
  const host = client(base, room.body.code, room.body.hostToken);
  const a = await post(base, `/api/rooms/${room.body.code}/join`, { name: '엄마' });
  const b = await post(base, `/api/rooms/${room.body.code}/join`, { name: '아빠' });
  const pa = client(base, room.body.code, a.body.token), pb = client(base, room.body.code, b.body.token);
  await host.until(c => c.state?.players.length === 2 && c.state.players.every(p => p.connected));
  host.send({ type: 'soc', soc: 30, target: 80 });
  await host.until(c => c.state.budget === 60);
  host.send({ type: 'start' });
  await host.until(c => c.state.phase === 'RULES');
  host.send({ type: 'skip' });
  await pa.until(c => c.state?.phase === 'PLAY', 5000);
  assert.equal(pa.state.bag.length, 2);
  assert.equal(host.state.bag, undefined, '큰 화면엔 가방 내용이 없다');
  const before = pa.state.players.find(p => p.id === a.body.playerId).energy;
  pa.send({ type: 'move', dir: pa.state.players[0].x === 0 ? 'R' : 'L' });
  pa.send({ type: 'move', dir: 'D' }); // 간격 안이라 무시된다
  await host.until(c => c.state.players.find(p => p.id === a.body.playerId).trail.length >= 2);
  await new Promise(r => setTimeout(r, 150));
  const me = host.state.players.find(p => p.id === a.body.playerId);
  assert.equal(me.trail.length, 2);
  assert.equal(me.energy, before - 1);
  pa.send({ type: 'item', id: pa.state.bag[0].id });
  await pa.until(c => c.state.bag.length === 1);
  pa.send({ type: 'item', id: 'nope' });
  await pa.until(c => c.errors.includes('NO_ITEM'));
  host.send({ type: 'next' });
  assert.ok(pb.state);
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
