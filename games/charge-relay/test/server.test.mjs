import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createRelayServer } from '../server.mjs';

const line = { strokes: [{ c: 0, w: 1, p: [0, 0, 500, 500] }] };

async function boot(t) {
  const app = createRelayServer({ publicOrigin: 'http://game.test' });
  app.http.listen(0, '127.0.0.1');
  await once(app.http, 'listening');
  const base = `127.0.0.1:${app.http.address().port}`;
  t.after(() => { for (const c of app.wss.clients) c.terminate(); app.http.close(); });
  return { app, base };
}
const post = async (base, path, body = {}) => {
  const r = await fetch(`http://${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

function client(base, code, token) {
  const ws = new WebSocket(`ws://${base}/ws`);
  const c = { ws, state: null, errors: [], waiters: [], closed: null };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', code, token })));
  ws.on('close', codeNum => { c.closed = codeNum; });
  ws.on('message', data => {
    const m = JSON.parse(data);
    if (m.type === 'state') c.state = m.state;
    if (m.type === 'error') c.errors.push(m.code);
    c.waiters = c.waiters.filter(w => { if (w.test(c)) { w.done(); return false; } return true; });
  });
  c.until = test => new Promise((done, fail) => {
    if (test(c)) return done();
    const timer = setTimeout(() => fail(new Error('timeout ' + test)), 3000);
    c.waiters.push({ test, done: () => { clearTimeout(timer); done(); } });
  });
  c.send = m => ws.send(JSON.stringify(m));
  return c;
}

test('QR 주소·참가·게임 한 판을 실제 WebSocket으로 끝까지', async t => {
  const { base } = await boot(t);
  const { body: room } = await post(base, '/api/rooms');
  assert.equal(room.joinUrl, `http://game.test/p#${room.code}`);
  const host = client(base, room.code, room.hostToken);
  await host.until(c => c.state?.phase === 'LOBBY');

  const phones = [];
  for (const name of ['엄마', '아빠', '민지']) {
    const { status, body } = await post(base, `/api/rooms/${room.code}/join`, { name });
    assert.equal(status, 200);
    phones.push(client(base, room.code, body.token));
  }
  await host.until(c => c.state.players.filter(p => p.connected).length === 3);

  host.send({ type: 'start', rounds: 2 });
  for (let round = 1; round <= 2; round++) {
    for (let step = 0; step < 3; step++) {
      await Promise.all(phones.map(p => p.until(c => c.state.phase === 'PLAY' && c.state.round === round && c.state.step === step)));
      for (const p of phones) p.send(p.state.task.kind === 'DRAW' ? { type: 'submit', step, drawing: line } : { type: 'submit', step, text: '호두과자' });
    }
    await host.until(c => c.state.phase === 'REVEAL');
    assert.equal(host.state.reveal.shown, 0);
    while (host.state.phase === 'REVEAL') {
      const before = JSON.stringify(host.state.reveal);
      host.send({ type: 'next' });
      await host.until(c => c.state.phase !== 'REVEAL' || JSON.stringify(c.state.reveal) !== before);
    }
    assert.equal(host.state.phase, 'ROUND_END');
    host.send({ type: 'next' });
    await host.until(c => c.state.phase !== 'ROUND_END');
  }
  assert.equal(host.state.phase, 'END');
  assert.equal(host.state.family.total, 6);
});

test('토큰이 틀리면 끊고, 폰이 진행자 명령을 보내도 무시한다', async t => {
  const { base } = await boot(t);
  const { body: room } = await post(base, '/api/rooms');
  const bad = client(base, room.code, 'nope');
  await once(bad.ws, 'close');
  assert.equal(bad.closed, 4401);
  const { body } = await post(base, `/api/rooms/${room.code}/join`, { name: 'A' });
  const phone = client(base, room.code, body.token);
  await phone.until(c => c.state);
  phone.send({ type: 'start', rounds: 2 });
  await phone.until(c => c.errors.length);
  assert.deepEqual(phone.errors, ['BAD_MESSAGE']);
  assert.equal(phone.state.phase, 'LOBBY');
});

test('끊겼다 다시 붙으면 같은 자리, 옛 연결은 4409로 닫힌다', async t => {
  const { base } = await boot(t);
  const { body: room } = await post(base, '/api/rooms');
  const { body } = await post(base, `/api/rooms/${room.code}/join`, { name: 'A' });
  const first = client(base, room.code, body.token);
  await first.until(c => c.state?.players[0].connected);
  const second = client(base, room.code, body.token);
  await second.until(c => c.state);
  await once(first.ws, 'close');
  assert.equal(first.closed, 4409);
  await second.until(c => c.state.players.length === 1 && c.state.players[0].connected);
});

test('5번째 사람과 없는 방, 빈 이름은 거부', async t => {
  const { base } = await boot(t);
  const { body: room } = await post(base, '/api/rooms');
  for (let i = 0; i < 4; i++) assert.equal((await post(base, `/api/rooms/${room.code}/join`, { name: 'P' + i })).status, 200);
  const full = await post(base, `/api/rooms/${room.code}/join`, { name: 'X' });
  assert.deepEqual([full.status, full.body.error], [409, 'ROOM_FULL']);
  assert.equal((await post(base, '/api/rooms/ZZZZZ/join', { name: 'X' })).status, 404);
  const { body: other } = await post(base, '/api/rooms');
  assert.equal((await post(base, `/api/rooms/${other.code}/join`, { name: '  ' })).status, 400);
});

test('다른 사이트에서 연 WebSocket은 막는다', async t => {
  const { base } = await boot(t);
  const ws = new WebSocket(`ws://${base}/ws`, { origin: 'http://evil.test' });
  const [error] = await once(ws, 'error');
  assert.ok(error);
});
