import test from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { placeSigns, gameSequence, SIGN_GAMES, SIGN_ROTATION, projectOnRoute, simplify, distanceM, osrmRouter, createRoutePlanner } from '../route-signs.mjs';
import { navigationReport } from '../navigation.mjs';
import { createDemoServer } from '../server.mjs';

// 남쪽으로 약 11km 직선 경로
const line = Array.from({ length: 101 }, (_, i) => ({ latitude: 37.566 - i * 0.001, longitude: 126.978 }));
const cumulative = points => points.reduce((acc, p, i) => (acc.push(i ? acc[i - 1] + distanceM(points[i - 1], p) : 0), acc), []);

test('signs are placed deterministically along the route with spacing and edge margins', () => {
  const a = placeSigns('room:route:1', line), b = placeSigns('room:route:1', line), c = placeSigns('room:route:2', line);
  assert.deepEqual(a, b, 'same seed → same signs for the whole crew');
  assert.notDeepEqual(a, c, 'new route revision → new random layout');
  const total = cumulative(line).at(-1);
  assert.ok(a.length >= 5 && a.length <= 9, '11km → 5–9 signs, got ' + a.length);
  for (const [i, sign] of a.entries()) {
    assert.ok(sign.alongM >= 400 && sign.alongM <= total - 400);
    if (i) assert.ok(sign.alongM - a[i - 1].alongM >= 1200);
    const { offsetM } = projectOnRoute(line, cumulative(line), sign);
    assert.ok(offsetM < 1, 'sign sits on the route line');
  }
  assert.deepEqual(placeSigns('x', line.slice(0, 2)), [], 'routes under 300m get no signs');
  for (const sign of a) assert.ok(SIGN_ROTATION.includes(sign.gameId), 'every sign has one game');
});

test('sign games rotate: every game once before repeating, never twice in a row', () => {
  for (let seed = 1; seed <= 200; seed++) {
    let state = seed;
    const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
    const next = gameSequence(random), games = Array.from({ length: SIGN_ROTATION.length * 5 }, next);
    for (let i = 1; i < games.length; i++) assert.notEqual(games[i], games[i - 1], 'no back-to-back game');
    for (let i = 0; i < games.length; i += SIGN_ROTATION.length)
      assert.deepEqual([...games.slice(i, i + SIGN_ROTATION.length)].sort(), [...SIGN_ROTATION].sort(), 'each round shows every game');
  }
  const long = Array.from({ length: 401 }, (_, i) => ({ latitude: 37.566 - i * 0.001, longitude: 126.978 }));
  const signs = placeSigns('room:long', long);
  assert.equal(signs.length, 12);
  assert.ok(signs.every((sign, i) => !i || sign.gameId !== signs[i - 1].gameId));
  assert.deepEqual(new Set(signs.slice(0, SIGN_ROTATION.length).map(s => s.gameId)), new Set(SIGN_ROTATION));
});

test('projection, simplification and OSRM parsing', async () => {
  const cum = cumulative(line);
  const near = { latitude: 37.556, longitude: 126.9781 };
  const projected = projectOnRoute(line, cum, near);
  assert.ok(Math.abs(projected.alongM - distanceM(line[0], { latitude: 37.556, longitude: 126.978 })) < 2);
  assert.ok(projected.offsetM < 15);
  const dense = Array.from({ length: 1000 }, (_, i) => ({ latitude: 37.5 + i * 1e-5, longitude: 127 + Math.sin(i / 50) * 1e-4 }));
  assert.ok(simplify(dense, 100).length <= 100);
  let requested;
  const router = osrmRouter('https://router.example', { fetchImpl: async url => {
    requested = String(url);
    return { ok: true, json: async () => ({ code: 'Ok', routes: [{ geometry: { coordinates: [[126.97, 37.56], [126.98, 37.55]] } }] }) };
  } });
  assert.deepEqual(await router({ latitude: 37.56, longitude: 126.97 }, { latitude: 37.55, longitude: 126.98 }),
    [{ latitude: 37.56, longitude: 126.97 }, { latitude: 37.55, longitude: 126.98 }]);
  assert.match(requested, /\/route\/v1\/driving\/126\.970000,37\.560000;126\.980000,37\.550000\?overview=full&geometries=geojson$/);
});

test('planner falls back to a straight line when the router fails and tracks sign state', async () => {
  let now = 0, ready = 0;
  const planner = createRoutePlanner({ router: async () => { throw new Error('offline'); }, clock: () => now, onReady: () => { ready++; } });
  planner.sync('r', { key: 'k', source: 'EXTERNAL_ROUTING_OSRM', origin: line[0], destination: line.at(-1) });
  assert.equal(planner.view('r', line[0]).status, 'PENDING');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, 1);
  const view = planner.view('r', line[0]);
  assert.equal(view.source, 'STRAIGHT_LINE_FALLBACK');
  assert.ok(view.signs.every(sign => sign.state === 'AHEAD'));
  const first = view.signs[0];
  planner.observe('r', { latitude: first.latitude, longitude: first.longitude });
  assert.equal(planner.view('r', first).signs[0].state, 'READY');
  // 지나친 뒤: 경로상 200m·30초 이내에는 아직 열려 있고, 그보다 멀어지거나 늦으면 닫힌다
  const ahead = m => ({ latitude: first.latitude - m / 111000, longitude: first.longitude });
  now = 10_000; planner.observe('r', ahead(400));
  assert.equal(planner.view('r', ahead(400)).signs[0].state, 'READY');
  now = 15_000; planner.observe('r', ahead(620));
  assert.equal(planner.view('r', ahead(620)).signs[0].state, 'MISSED', 'closed once 500m+ past the sign');
  const later = ahead(620);
  assert.equal(planner.view('r', later, { 'k:s1': ['m1'] }, 'm1').signs[0].state, 'CLAIMED');
});

test('a sign across a U-turn is not ready until the car reaches it along the route', () => {
  // 남쪽으로 1.5km 갔다가 30m 옆 차로로 되돌아오는 경로
  const out = Array.from({ length: 41 }, (_, i) => ({ latitude: 37.566 - i * 0.001, longitude: 126.978 }));
  const back = out.slice().reverse().map(p => ({ latitude: p.latitude, longitude: 126.97834 }));
  const planner = createRoutePlanner({ clock: () => 0 });
  planner.sync('u', { key: 'u1', source: 'TEST', geometry: [...out, ...back] });
  const signs = planner.view('u', out[0]).signs;
  const returning = signs.find(sign => sign.alongM > 5600);
  assert.ok(returning, 'a sign exists on the return leg');
  const opposite = { latitude: returning.latitude, longitude: 126.978 }; // 가는 길에서 표지판 맞은편
  for (const p of out) if (p.latitude > opposite.latitude) planner.observe('u', p); // 맞은편까지만 주행
  planner.observe('u', opposite);
  assert.ok(planner.view('u', opposite).progressM < 4000, 'car is still on the outbound leg');
  assert.equal(planner.view('u', opposite).signs.find(s => s.signId === returning.signId).state, 'AHEAD');
});

test('re-route: old route stays visible while fetching, off-route driving asks for a new route', async () => {
  let now = 0, release;
  const planner = createRoutePlanner({ clock: () => now,
    router: (origin, destination) => new Promise(resolve => { release = () => resolve([origin, destination]); }) });
  planner.sync('r', { key: 'a', source: 'X', origin: line[0], destination: line.at(-1), native: true });
  release(); await new Promise(r => setImmediate(r));
  const first = planner.view('r', line[0]);
  assert.equal(first.key, 'a');
  // 목적지 변경 → 새 경로를 받는 동안 기존 경로 유지
  planner.sync('r', { key: 'b', source: 'X', origin: line[10], destination: { latitude: 37.5, longitude: 127.05 }, native: true });
  assert.equal(planner.key('r'), 'b');
  const during = planner.view('r', line[10]);
  assert.equal(during.key, 'a'); assert.equal(during.rerouting, true);
  release(); await new Promise(r => setImmediate(r));
  const after = planner.view('r', line[10]);
  assert.equal(after.key, 'b'); assert.equal(after.rerouting, false);
  assert.notDeepEqual(after.signs.map(x => [x.latitude, x.longitude]), first.signs.map(x => [x.latitude, x.longitude]));
  // 경로에서 150m 넘게 8초 이상 벗어나면 재탐색 필요
  const off = { latitude: line[10].latitude, longitude: line[10].longitude + 0.01 };
  planner.observe('r', off); assert.equal(planner.offRoute('r'), false);
  now = 9_000; planner.observe('r', off); assert.equal(planner.offRoute('r'), true);
  planner.observe('r', line[10]); assert.equal(planner.offRoute('r'), false, 'back on route');
});

test('navigation report keeps destination coordinates and heading', () => {
  const value = navigationReport({ source: 'PLEOS_NAVI_HELPER', sdkConnected: true, owned: false, routeRevision: 1, status: 'ROUTE_DRIVE',
    latitude: 37.5, longitude: 126.9, locationAgeMs: 0, heading: 182, positionSource: 'SIMULATED',
    destinationLatitude: 37.55, destinationLongitude: 126.97 });
  assert.deepEqual(value.destinationPosition, { latitude: 37.55, longitude: 126.97 });
  assert.equal(value.heading, 182);
  assert.equal(value.positionSource, 'SIMULATED');
  assert.equal(navigationReport({ source: 'PLEOS_NAVI_HELPER', sdkConnected: true, owned: false, routeRevision: 1,
    destinationLatitude: 0, destinationLongitude: 0 }).destinationPosition, undefined, '(0,0) means no destination');
});

test('route sign flow: route from destination → sign near car → game challenge → crew bag reward', async t => {
  const calls = [];
  const links = {};
  const worker = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    const reply = value => response.end(JSON.stringify(value));
    if (request.url === '/api/zride/rooms') {
      links.deadzone = body.crewKey;
      return reply({ code: 'ABC234', dashboardToken: 'dashboard-test', partySeatsRequired: true });
    }
    if (request.url === '/api/zride/rooms/ABC234/status')
      return reply({ schema: 'zride.dashboard.v1', roomCode: 'ABC234', players: [], wave: 0, state: 'lobby' });
    if (request.url === '/volt-rush/api/rooms') {
      links.volt = body.crewKey;
      return reply({ code: 'VOLT2', hostToken: 'volt-test' });
    }
    if (request.url === '/volt-rush/api/rooms/VOLT2/join') {
      assert.equal(body.hostToken, 'volt-test');
      return reply({ playerId: randomUUID(), token: 'rider-test' });
    }
    response.writeHead(404).end('{}');
  });
  await new Promise(resolve => worker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => worker.close(resolve)));
  const origin = 'http://127.0.0.1:' + worker.address().port;
  const charger = { ...line[0], placeId: 'charger-fixture', name: 'Charger fixture', category: 'CHARGER' };
  const app = createDemoServer({
    leaseMs: 60000, signMinPlayMs: 0, deadzoneOrigin: origin,
    chargeGames: { 'volt-rush': origin + '/volt-rush/' },
    placeReviewToken: 'review-sign-items',
    placesCatalog: { version: 'test', places: [charger] },
    routeRouter: async (origin, destination) => { calls.push([origin, destination]); return line; },
  });
  const address = await app.listen(0), clients = [];
  t.after(async () => { for (const c of clients) c.ws.terminate(); await app.close(); });
  const url = path => `http://127.0.0.1:${address.port}${path}`;
  const call = async (path, body, token) => {
    const r = await fetch(url(path), { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const api = async (path, body, token) => { const r = await call(path, body, token); assert.ok(r.status < 300, path + ' ' + r.status + ' ' + JSON.stringify(r.data)); return r.data; };
  const until = async fn => { for (let i = 0; i < 300; i++) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 10)); } throw Error('timeout'); };
  async function connect(token, roomId) {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`), c = { ws, messages: [] }; clients.push(c);
    ws.on('message', raw => { const m = JSON.parse(raw); c.messages.push(m); if (m.type === 'snapshot') c.room = m.room; });
    await new Promise(r => ws.once('open', r)); ws.send(JSON.stringify({ type: 'auth', token, roomId })); await until(() => c.room);
    c.send = async body => { const commandId = randomUUID(); ws.send(JSON.stringify({ ...body, commandId })); return until(() => c.messages.find(m => m.type === 'result' && m.commandId === commandId)); };
    return c;
  }
  const host = await api('/api/session', { role: 'CAR_HOST', nickname: 'Sign car' });
  const room = await api('/api/rooms', {}, host.token);
  const phone = await api('/api/session', { role: 'PHONE', nickname: 'Sign phone' });
  const teammate = await api('/api/session', { role: 'PHONE', nickname: 'Sign teammate' });
  const join = await api('/api/join', { joinCode: room.joinCode, seat: 'REAR_RIGHT' }, phone.token);
  const freshInvite = await api('/api/rooms', {}, host.token);
  const secondJoin = await api('/api/join', { joinCode: freshInvite.joinCode, seat: 'REAR_LEFT' }, teammate.token);
  const second = await connect(teammate.token, room.roomId);
  const p = await connect(phone.token, room.roomId), car = await connect(host.token, room.roomId);
  await api('/api/rooms/' + room.roomId + '/approve', { memberId: join.memberId, allowManualUnknown: true }, host.token);
  await api('/api/rooms/' + room.roomId + '/approve', { memberId: secondJoin.memberId, allowManualUnknown: true }, host.token);
  await car.send({ type: 'vehicle.report', reportSeq: 1, gear: 'D', ux: 'ALLOWED', foreground: true, speedMps: 14 });
  let seq = 0;
  const report = position => car.send({ type: 'navigation.report', reportSeq: ++seq, navigation: {
    source: 'PLEOS_NAVI_HELPER', sdkConnected: true, owned: false, routeRevision: 7, status: 'ROUTE_DRIVE', destination: '서울역',
    destinationLatitude: line.at(-1).latitude, destinationLongitude: line.at(-1).longitude,
    latitude: position.latitude, longitude: position.longitude, locationAgeMs: 0, positionSource: 'SIMULATED' } });

  const start = { latitude: line[0].latitude + 0.01, longitude: line[0].longitude };
  assert.equal((await report(start)).ok, true);
  const route = await until(() => p.room.journeyRoute?.status === 'READY' && p.room.journeyRoute);
  assert.equal(calls.length, 1, 'router called once per route');
  assert.equal(route.source, 'EXTERNAL_ROUTING_OSRM');
  assert.ok(route.geometry.length >= 2 && route.signs.length >= 2);
  assert.ok(car.room.journeyRoute, 'vehicle also sees the route');
  const signIndex = route.signs.findIndex(s => s.playable), sign = route.signs[signIndex];
  assert.ok(sign && SIGN_GAMES.includes(sign.gameId), 'a playable sign exists');
  const comingSoon = route.signs.find(s => !s.playable);
  assert.equal(comingSoon?.gameId, 'zombie', 'the map still shows the parked game');
  assert.equal(comingSoon.reward, undefined);
  assert.equal((await call('/api/world/route-sign', { signId: comingSoon.signId, gameId: 'zombie' }, phone.token)).data.error.code, 'SIGN_GAME_NOT_READY');

  const signPath = '/api/world/route-sign';
  const startBody = { signId: sign.signId, routeKey: route.key };
  assert.equal((await call(signPath, startBody, phone.token)).data.error.code, 'SIGN_NOT_NEAR');
  assert.equal((await call(signPath, { ...startBody, gameId: 'chess' }, phone.token)).data.error.code, 'INVALID_GAME');
  assert.equal((await call(signPath, startBody, host.token)).status, 403);

  const expected = { 'license-quiz': 'quiz-time-card', 'pole-jump': 'jump-grip', raindrop: 'wide-catcher' };
  const crewCrates = ['coil-launcher', 'voltage-coil', 'repair-kit'];
  for (const target of route.signs.filter(sign => sign.playable).slice(0, 3)) {
    const body = { signId: target.signId, routeKey: route.key };
    const itemId = expected[target.gameId];
    assert.equal(target.reward.id, itemId);
    assert.equal((await report({ latitude: target.latitude, longitude: target.longitude })).ok, true);
    await until(() => p.room.journeyRoute.signs.find(s => s.signId === target.signId)?.state === 'READY');
    const wrongGame = SIGN_GAMES.find(game => game !== target.gameId);
    assert.equal((await call(signPath, { ...body, gameId: wrongGame }, phone.token)).data.error.code, 'SIGN_GAME_MISMATCH');
    const challenge = await api(signPath, body, phone.token);
    assert.equal(challenge.gameId, target.gameId);
    assert.equal((await api(signPath, { ...body, gameId: target.gameId }, phone.token)).challengeId, challenge.challengeId);
    const completion = { challengeId: challenge.challengeId, result: { score: 12 } };
    assert.equal((await call(signPath, completion, teammate.token)).data.error.code, 'SIGN_CHALLENGE_INVALID');
    assert.equal((await call(signPath, { challengeId: challenge.challengeId, result: { score: 0 } }, phone.token)).data.error.code, 'SIGN_GOAL_NOT_MET');
    const receipts = await Promise.all([api(signPath, completion, phone.token), api(signPath, completion, phone.token)]);
    assert.equal(receipts.filter(receipt => receipt.replayed).length, 1);
    for (const receipt of receipts) {
      assert.equal(receipt.items[0].id, itemId);
      assert.equal(receipt.items.length, 2);
      assert.equal(receipt.items[1].id, crewCrates[0]);
      assert.equal(receipt.inventory[receipt.items[1].id], 1);
      assert.equal(receipt.inventory[itemId], 1);
      assert.equal(receipt.supplies, 0);
    }
    crewCrates.shift();
    await until(() => second.room.collection.inventory[itemId] === 1);
    await until(() => p.room.journeyRoute.signs.find(s => s.signId === target.signId)?.state === 'CLAIMED');
    assert.equal(second.room.journeyRoute.signs.find(s => s.signId === target.signId).state, 'READY');
    assert.equal(p.room.routeSignHistory[0].itemId, itemId);
    assert.equal((await call(signPath, body, phone.token)).data.error.code, 'ALREADY_CLAIMED');
  }
  assert.equal(calls.length, 1, 'no re-route along the same route');

  // 주행 중 목적지 변경 → 새 경로·새 표지판
  const firstKey = p.room.journeyRoute.key;
  await car.send({ type: 'navigation.report', reportSeq: ++seq, navigation: {
    source: 'PLEOS_NAVI_HELPER', sdkConnected: true, owned: false, routeRevision: 8, status: 'ROUTE_DRIVE', destination: '시청',
    destinationLatitude: 37.5663, destinationLongitude: 126.9779,
    latitude: sign.latitude, longitude: sign.longitude, locationAgeMs: 0, positionSource: 'SIMULATED' } });
  await until(() => p.room.journeyRoute?.key && p.room.journeyRoute.key !== firstKey);
  assert.equal(calls.length, 2, 'router called again for the new destination');
  assert.equal((await call(signPath, startBody, phone.token)).data.error.code, 'SIGN_UNAVAILABLE');
  assert.deepEqual(calls[1][0], { latitude: sign.latitude, longitude: sign.longitude }, 'new route starts at the current position');

  // 안내 종료 → 경로·표지판 해제
  await car.send({ type: 'navigation.report', reportSeq: ++seq, navigation: { source: 'PLEOS_NAVI_HELPER', sdkConnected: true, owned: false, routeRevision: 8, status: 'NAVIGATION_ENDED' } });
  await until(() => !p.room.journeyRoute);
  await car.send({ type: 'vehicle.report', reportSeq: 2, gear: 'P', ux: 'ALLOWED', foreground: true, speedMps: 0 });
  const reviewed = await call('/api/admin/places/review', {
    commandId: 'review', placeId: charger.placeId, expectedRevision: 0, accessStatus: 'VERIFIED', enabled: true,
    entrance: charger, playZone: { ...line[0], radiusM: 60 }, parkingAllowed: true, dwellAllowed: true, evidence: 'Test only',
  }, 'review-sign-items');
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
  await car.send({ type: 'navigation.report', reportSeq: ++seq, navigation: {
    ...line[0], source: 'PLEOS_NAVI_HELPER', sdkConnected: true, owned: false, event: 'ARRIVED', status: 'IDLE', routeRevision: 8, locationAgeMs: 0,
  }});
  await api('/api/rooms/' + room.roomId + '/deadzone', { create: true }, host.token);
  const deadzone = { game: 'deadzone', code: 'ABC234' };
  assert.equal((await call('/api/game-items', { ...deadzone, action: 'loadout' }, phone.token)).status, 403);
  assert.equal((await call('/api/game-items', { ...deadzone, code: 'OTHER1', action: 'loadout' }, links.deadzone)).status, 403);
  const loadout = await api('/api/game-items', { ...deadzone, action: 'loadout' }, links.deadzone);
  assert.deepEqual(loadout.loadout.startWeapons, ['launcher']);
  assert.deepEqual(loadout.items.map(item => [item.id, item.count]), [['repair-kit', 1]]);
  const repair = { ...deadzone, useId: randomUUID(), itemId: 'repair-kit' };
  assert.equal((await api('/api/game-items', { ...repair, action: 'use' }, links.deadzone)).remaining, 0);
  assert.equal((await api('/api/game-items', { ...repair, action: 'use' }, links.deadzone)).remaining, 0);
  assert.equal((await api('/api/game-items', { ...repair, action: 'refund' }, links.deadzone)).refunded, true);
  assert.equal((await api('/api/game-items', { ...repair, action: 'refund' }, links.deadzone)).refunded, true);
  await until(() => second.room.collection.inventory['repair-kit'] === 1);
  const opened = await api('/api/rooms/' + room.roomId + '/charge-game', { action: 'open', game: 'volt-rush' }, host.token);
  assert.equal(opened.hostUrl, origin + '/volt-rush/#host=VOLT2.volt-test');
  const volt = { game: 'volt-rush', code: 'VOLT2' };
  const stock = await api('/api/game-items', { ...volt, action: 'loadout' }, links.volt);
  assert.deepEqual(stock.items.map(item => [item.id, item.kind]), [['voltage-coil', 'CUT']]);
  const spent = await Promise.all([randomUUID(), randomUUID()].map(useId =>
    call('/api/game-items', { ...volt, action: 'use', itemId: 'voltage-coil', useId }, links.volt)));
  assert.deepEqual(spent.map(value => value.status).sort(), [200, 409]);
  await until(() => second.room.collection.inventory['voltage-coil'] === 0);
  await api('/api/rooms/' + room.roomId + '/charge-game', { action: 'close' }, host.token);
  assert.equal((await call('/api/game-items', { ...volt, action: 'loadout' }, links.volt)).status, 403);
});
