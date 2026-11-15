import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createDemoServer, chargeGamesFromEnv, DEFAULT_CHARGE_GAMES } from '../server.mjs';

const REVIEW = 'charge-review-token-fixture';
const charger = { placeId: 'charger', name: 'Fixture charger', category: 'CHARGER', latitude: 37.5, longitude: 126.9 };
const navigation = { source: 'PLEOS_NAVI_HELPER', sdkConnected: true, owned: false, routeRevision: 1, event: 'ARRIVED',
  status: 'IDLE', latitude: charger.latitude, longitude: charger.longitude, locationAgeMs: 0 };

/** 충전 게임 서버 대역: 방 만들기와 참가만 한다. */
async function fakeGame(t) {
  const calls = [];
  const upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/rooms') return res.end(JSON.stringify({ code: 'ABC23', hostToken: 'host-token-fixture-123', joinUrl: 'x' }));
      if (req.url === '/api/rooms/ABC23/join') return res.end(JSON.stringify({ code: 'ABC23', playerId: randomUUID(), token: 'player-token-fixture-' + calls.length }));
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  return { origin: 'http://127.0.0.1:' + upstream.address().port, calls };
}

async function fixture(t, chargeGames, demoCharger) {
  const app = createDemoServer({ leaseMs: 60000, startRound: false, chargeGames, demoCharger, placeReviewToken: REVIEW,
    placesCatalog: { version: 'charge-fixture', places: [charger] } });
  const address = await app.listen(0);
  const sockets = [];
  t.after(async () => { for (const ws of sockets) ws.terminate(); await app.close(); });
  const api = async (path, body, token, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  async function connect(token, roomId) {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    sockets.push(ws);
    const messages = [], waiters = new Set();
    ws.on('message', bytes => {
      const value = JSON.parse(bytes); messages.push(value);
      for (const w of [...waiters]) if (w.test(value)) { waiters.delete(w); clearTimeout(w.timer); w.done(value); }
    });
    const wait = test => {
      const found = [...messages].reverse().find(test); if (found) return Promise.resolve(found);
      return new Promise((done, reject) => {
        const w = { test, done, timer: setTimeout(() => { waiters.delete(w); reject(new Error('timed out')); }, 3000) };
        waiters.add(w);
      });
    };
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'auth', token, roomId }));
    await wait(value => value.type === 'auth.ok');
    const send = body => { const id = body.commandId ?? randomUUID(); ws.send(JSON.stringify({ ...body, commandId: id }));
      return wait(value => value.type === 'result' && value.commandId === id); };
    return { ws, wait, send, messages };
  }
  const host = (await api('/api/session', { role: 'CAR_HOST', nickname: 'Car' })).body;
  const phone = (await api('/api/session', { role: 'PHONE', nickname: '지우' })).body;
  const room = (await api('/api/rooms', {}, host.token)).body;
  const joined = (await api('/api/join', { joinCode: room.joinCode, seat: 'REAR_LEFT' }, phone.token)).body;
  assert.equal((await api(`/api/rooms/${room.roomId}/approve`, { memberId: joined.memberId, allowManualUnknown: true }, host.token)).status, 200);
  const car = await connect(host.token, room.roomId);
  const passenger = await connect(phone.token, room.roomId);
  let seq = 0;
  const park = (gear = 'P', ux = 'ALLOWED') => car.send({ type: 'vehicle.report', reportSeq: ++seq, gear, ux, foreground: true,
    seats: [{ seat: 'REAR_LEFT', occupancy: 'UNKNOWN' }], source: 'SIMULATED_API_CLIENTS' });
  const arrive = async () => {
    const reviewed = await fetch(`http://127.0.0.1:${address.port}/api/admin/places/review`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + REVIEW },
      body: JSON.stringify({ commandId: 'review', placeId: charger.placeId, expectedRevision: 0, accessStatus: 'VERIFIED', enabled: true,
        entrance: navigation, playZone: { latitude: charger.latitude, longitude: charger.longitude, radiusM: 60 },
        parkingAllowed: true, dwellAllowed: true, evidence: 'Synthetic test review only' }) });
    assert.equal(reviewed.status, 200);
    assert.equal((await car.send({ type: 'navigation.report', reportSeq: 1, navigation })).ok, true);
  };
  return { api, host, phone, room, joined, car, passenger, park, arrive, path: `/api/rooms/${room.roomId}/charge-game`,
    base: `http://127.0.0.1:${address.port}` };
}

test('기본은 이 서버가 충전 게임 4종을 직접 띄우고, 환경 변수로 바꾸거나 끈다', () => {
  assert.deepEqual(chargeGamesFromEnv(undefined), DEFAULT_CHARGE_GAMES);
  assert.deepEqual(DEFAULT_CHARGE_GAMES, { 'power-castle': 'local', 'volt-rush': 'local', 'power-tug': 'local', 'charge-relay': 'local' });
  assert.deepEqual(chargeGamesFromEnv('{"volt-rush":"local"}'), { 'volt-rush': 'local' });
  assert.deepEqual(chargeGamesFromEnv('off'), {});
  assert.deepEqual(chargeGamesFromEnv('{"charge-relay":"https://relay.example"}'), { 'charge-relay': 'https://relay.example' });
  assert.throws(() => chargeGamesFromEnv('[]'));
});

test('충전소에 주차하면 게임 방을 만들고 크루를 미리 참가시켜 입장권을 준다', async t => {
  const game = await fakeGame(t);
  const f = await fixture(t, { 'charge-relay': game.origin });
  await f.car.wait(value => value.type === 'snapshot' && value.room.chargeGamesAvailable?.includes('charge-relay'));
  assert.equal((await f.api(f.path, { action: 'open', game: 'charge-relay' }, f.phone.token)).status, 403);
  await f.park();
  assert.equal((await f.api(f.path, { action: 'open', game: 'charge-relay' }, f.host.token)).body.error.code, 'CHARGING_STOP_REQUIRED');
  await f.arrive();
  assert.equal((await f.api(f.path, { action: 'open', game: 'nope' }, f.host.token)).body.error.code, 'UNKNOWN_GAME');
  const opened = await f.api(f.path, { action: 'open', game: 'charge-relay' }, f.host.token);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.hostUrl, game.origin + '/#host=ABC23.host-token-fixture-123');
  assert.equal(opened.body.crew, 1);
  assert.deepEqual(game.calls.find(c => c.url === '/api/rooms/ABC23/join').body, { name: '지우' });
  const seen = await f.passenger.wait(value => value.type === 'snapshot' && value.room.chargeGame);
  assert.match(seen.room.chargeGame.joinUrl, new RegExp('^' + game.origin + '/p#join=ABC23\\.[0-9a-f-]{36}\\.player-token-fixture-\\d+$'));
  const hostView = await f.car.wait(value => value.type === 'snapshot' && value.room.chargeGame);
  assert.deepEqual(hostView.room.chargeGame, { game: 'charge-relay' });
  // 주행으로 바뀌면 입장권을 내리지 않는다
  await f.park('D', 'RESTRICTED');
  await f.passenger.wait(value => value.type === 'snapshot' && !value.room.chargeGame);
});

test('보급품 사용은 열린 게임에만, 남은 보급품이 있을 때만 하나씩 차감한다', async t => {
  const game = await fakeGame(t);
  const f = await fixture(t, { 'charge-relay': game.origin });
  await f.park(); await f.arrive();
  assert.equal((await f.api(f.path, { action: 'item', game: 'charge-relay' }, f.host.token)).body.error.code, 'NO_CHARGE_GAME');
  assert.equal((await f.api(f.path, { action: 'open', game: 'charge-relay' }, f.host.token)).status, 200);
  assert.equal((await f.api(f.path, { action: 'item', game: 'charge-relay' }, f.host.token)).body.error.code, 'SUPPLY_REQUIRED');
  const epoch = (await f.passenger.wait(value => value.type === 'snapshot')).room.roomEpoch;
  const collected = await f.passenger.send({ type: 'command', roomEpoch: epoch, action: 'mobile.collect', pickupId: 'DEMO_PICKUP_A', passengerConfirmed: true });
  assert.equal(collected.ok, true, JSON.stringify(collected));
  const used = await f.api(f.path, { action: 'item', game: 'charge-relay' }, f.host.token);
  assert.equal(used.status, 200);
  assert.equal(used.body.supplies, 0);
  assert.equal((await f.api(f.path, { action: 'item', game: 'power-castle' }, f.host.token)).body.error.code, 'NO_CHARGE_GAME');
  assert.equal((await f.api(f.path, { action: 'close' }, f.host.token)).body.closed, true);
  await f.passenger.wait(value => value.type === 'snapshot' && !value.room.chargeGame);
});

test('설정이 없으면 충전 게임 연결은 꺼져 있다', async t => {
  const f = await fixture(t, undefined);
  const view = await f.car.wait(value => value.type === 'snapshot');
  assert.equal(view.room.chargeGamesAvailable, undefined);
  assert.equal((await f.api(f.path, { action: 'open', game: 'charge-relay' }, f.host.token)).status, 404);
});

test('시연 충전 거점은 등록된 데모 경로와 시뮬레이션 위치에서만 열린다', async t => {
  const game = await fakeGame(t);
  const f = await fixture(t, { 'volt-rush': game.origin }, charger);
  await f.park();
  const action = { action: 'open', game: 'volt-rush' };
  const report = (reportSeq, positionSource, point = {}) => f.car.send({ type: 'navigation.report', reportSeq,
    navigation: { ...navigation, ...point, owned: false, positionSource } });
  const testRoute = {
    commandId: 'demo-route', expectedRouteRevision: 0, source: 'DEMO_ROUTE',
    geometry: [charger, { ...charger, latitude: charger.latitude + 0.02 }],
  };
  await report(1, 'SIMULATED');
  assert.equal((await f.api(f.path, action, f.host.token)).body.error.code, 'CHARGING_STOP_REQUIRED');
  assert.equal((await f.api('/api/rooms/' + f.room.roomId + '/route', testRoute, f.host.token)).status, 200);
  await report(2, 'PLEOS_NAVI_HELPER');
  assert.equal((await f.api(f.path, action, f.host.token)).body.error.code, 'CHARGING_STOP_REQUIRED');
  await report(3, 'ANDROID_GNSS', { latitude: charger.latitude + 0.001 });
  assert.equal((await f.api(f.path, action, f.host.token)).body.error.code, 'CHARGING_STOP_REQUIRED');
  await report(4, 'ANDROID_GNSS');
  assert.equal((await f.api(f.path, action, f.host.token)).status, 200);
});

/** 게임 WebSocket에 입장권으로 붙어 첫 상태를 받는다 */
function gameSocket(base, game, code, token) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/charge/' + game + '/ws?room=' + code);
  const messages = [];
  const wait = test => new Promise((done, reject) => {
    const found = messages.find(test); if (found) return done(found);
    const timer = setTimeout(() => reject(new Error('timed out')), 3000);
    ws.on('message', function on(bytes) { const value = JSON.parse(bytes); if (test(value)) { clearTimeout(timer); ws.off('message', on); done(value); } });
  });
  ws.on('message', bytes => messages.push(JSON.parse(bytes)));
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', code, token })));
  return { ws, wait };
}

test('Cloudflare 없이 이 서버가 충전 게임 화면·방·입장권을 직접 처리한다', async t => {
  const f = await fixture(t, DEFAULT_CHARGE_GAMES);
  const page = await fetch(f.base + '/charge/power-castle/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /\.\/host\.js/);
  assert.equal((await fetch(f.base + '/charge/power-castle/p')).status, 200);
  assert.equal((await fetch(f.base + '/charge/power-castle/zride-car.js')).status, 200);
  assert.equal((await fetch(f.base + '/charge/power-castle', { redirect: 'manual' })).headers.get('location'), '/charge/power-castle/');
  assert.equal((await fetch(f.base + '/charge/nope/')).status, 404);
  await f.park(); await f.arrive();
  const opened = await f.api(f.path, { action: 'open', game: 'power-castle' }, f.host.token);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const host = /^\/charge\/power-castle\/#host=([A-Z0-9]{5})\.(.+)$/.exec(opened.body.hostUrl);
  assert.ok(host, opened.body.hostUrl);
  const seen = await f.passenger.wait(value => value.type === 'snapshot' && value.room.chargeGame);
  const crew = /^\/charge\/power-castle\/p#join=([A-Z0-9]{5})\.([0-9a-f-]{36})\.(.+)$/.exec(seen.room.chargeGame.joinUrl);
  assert.ok(crew, seen.room.chargeGame.joinUrl);
  assert.equal(crew[1], host[1]);
  const car = gameSocket(f.base, 'power-castle', host[1], host[2]);
  t.after(() => car.ws.terminate());
  assert.equal((await car.wait(value => value.type === 'auth.ok')).role, 'HOST');
  const lobby = await car.wait(value => value.type === 'state');
  assert.deepEqual(lobby.state.players.map(player => player.name), ['지우']);
  const phone = gameSocket(f.base, 'power-castle', crew[1], crew[3]);
  t.after(() => phone.ws.terminate());
  assert.equal((await phone.wait(value => value.type === 'auth.ok')).role, 'PLAYER');
  // 없는 방은 4404로 닫는다
  const stale = new WebSocket(f.base.replace(/^http/, 'ws') + '/charge/power-castle/ws?room=ZZZZZ');
  stale.on('open', () => stale.send(JSON.stringify({ type: 'auth', code: 'ZZZZZ', token: 'x' })));
  assert.equal(await new Promise(done => stale.on('close', done)), 4404);
  // 브라우저에서 직접 연 방(QR 참가)도 된다
  const direct = await (await fetch(f.base + '/charge/power-tug/api/rooms', { method: 'POST' })).json();
  assert.match(direct.code, /^[A-Z0-9]{5}$/);
  const joined = await fetch(f.base + '/charge/power-tug/api/rooms/' + direct.code + '/join', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '민' }) });
  assert.equal(joined.status, 200);
});

test('서버 안 Volt Rush는 크루 가방을 같은 서버 재고에서 쓰고, 운전자도 QR로 합류한다', async t => {
  const f = await fixture(t, DEFAULT_CHARGE_GAMES);
  await f.park(); await f.arrive();
  const opened = await f.api(f.path, { action: 'open', game: 'volt-rush' }, f.host.token);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const [, code, hostToken] = /#host=([A-Z0-9]{5})\.(.+)$/.exec(opened.body.hostUrl);
  // 운전자는 차 화면 QR로 크루 방에 들어온다
  const driver = await fetch(f.base + '/charge/volt-rush/api/rooms/' + code + '/join', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '아빠' }) });
  assert.equal(driver.status, 200);
  const car = gameSocket(f.base, 'volt-rush', code, hostToken);
  t.after(() => car.ws.terminate());
  await car.wait(value => value.type === 'auth.ok');
  car.ws.send(JSON.stringify({ type: 'start' }));
  // 시작하면 먼저 크루 가방(loadout)을 서버 재고에서 받는다. 실패하면 GAME_ITEMS_* 오류가 난다.
  // 크루 1명 + QR로 들어온 운전자 = 2명이라 규칙 화면까지 간다
  const started = await car.wait(value => value.type === 'error' || (value.type === 'state' && value.state.phase !== 'LOBBY'));
  assert.equal(started.type, 'state', JSON.stringify(started));
  assert.equal(started.state.phase, 'RULES');
});
