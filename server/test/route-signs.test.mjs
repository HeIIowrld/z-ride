import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { placeSigns, projectOnRoute, simplify, distanceM, pickReward, osrmRouter, createRoutePlanner } from '../route-signs.mjs';
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
  assert.ok(a.length >= 3 && a.length <= 5, '11km → 3~5 signs, got ' + a.length);
  for (const [i, sign] of a.entries()) {
    assert.ok(sign.alongM >= 400 && sign.alongM <= total - 400);
    if (i) assert.ok(sign.alongM - a[i - 1].alongM >= 2000);
    const { offsetM } = projectOnRoute(line, cumulative(line), sign);
    assert.ok(offsetM < 1, 'sign sits on the route line');
  }
  assert.deepEqual(placeSigns('x', line.slice(0, 2)), [], 'routes under 300m get no signs');
});

test('projection, simplification, reward pick and OSRM parsing', async () => {
  const cum = cumulative(line);
  const near = { latitude: 37.556, longitude: 126.9781 };
  const projected = projectOnRoute(line, cum, near);
  assert.ok(Math.abs(projected.alongM - distanceM(line[0], { latitude: 37.556, longitude: 126.978 })) < 2);
  assert.ok(projected.offsetM < 15);
  const dense = Array.from({ length: 1000 }, (_, i) => ({ latitude: 37.5 + i * 1e-5, longitude: 127 + Math.sin(i / 50) * 1e-4 }));
  assert.ok(simplify(dense, 100).length <= 100);
  const catalog = { items: [{ id: 'part', name: '부품', category: 'part' }, { id: 'coolant', name: '냉각수', category: 'consumable' }],
    tables: { common: [{ itemId: 'part', weight: 1 }, { itemId: 'coolant', weight: 1 }] } };
  assert.equal(pickReward(catalog, 'pole-jump', () => 0).id, 'part');
  assert.equal(pickReward(catalog, 'raindrop', () => 0.99).id, 'coolant');
  assert.equal(pickReward(null, 'raindrop'), null);
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
  const returning = signs.find(sign => sign.alongM > 4300);
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
  const app = createDemoServer({
    leaseMs: 60000, signMinPlayMs: 0,
    routeRouter: async (origin, destination) => { calls.push([origin, destination]); return line; },
    rewardCatalog: { items: [{ id: 'part', name: '정비 부품', category: 'part' }], tables: { common: [{ itemId: 'part', weight: 1 }] } },
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
  const join = await api('/api/join', { joinCode: room.joinCode, seat: 'REAR_RIGHT' }, phone.token);
  const p = await connect(phone.token, room.roomId), car = await connect(host.token, room.roomId);
  await api('/api/rooms/' + room.roomId + '/approve', { memberId: join.memberId, allowManualUnknown: true }, host.token);
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
  const sign = route.signs[0];

  // 멀리 있을 때는 시작 불가
  const far = await call('/api/world/route-sign', { signId: sign.signId, gameId: 'pole-jump' }, phone.token);
  assert.equal(far.data.error.code, 'SIGN_NOT_NEAR');
  assert.equal((await call('/api/world/route-sign', { signId: sign.signId, gameId: 'chess' }, phone.token)).data.error.code, 'INVALID_GAME');
  // 운전자(차량)는 사용할 수 없다
  assert.equal((await call('/api/world/route-sign', { signId: sign.signId, gameId: 'pole-jump' }, host.token)).status, 403);

  await report({ latitude: sign.latitude, longitude: sign.longitude });
  await until(() => p.room.journeyRoute.signs[0].state === 'READY');
  assert.ok(p.room.journeyRoute.progressM > 0);
  assert.equal(calls.length, 1, 'moving along the same route does not re-route');

  const challenge = await api('/api/world/route-sign', { signId: sign.signId, gameId: 'pole-jump' }, phone.token);
  assert.equal(challenge.gameId, 'pole-jump');
  const receipt = await api('/api/world/route-sign', { challengeId: challenge.challengeId, result: { score: 1200 } }, phone.token);
  assert.deepEqual(receipt.items.map(item => item.id), ['part']);
  assert.equal(receipt.inventory.part, 1);
  await until(() => p.room.collection.inventory.part === 1);
  await until(() => p.room.journeyRoute.signs[0].state === 'CLAIMED');
  assert.equal(p.room.routeSignHistory[0].itemId, 'part');

  // 같은 표지판 재도전·같은 challenge 재사용 거절
  assert.equal((await call('/api/world/route-sign', { signId: sign.signId, gameId: 'raindrop' }, phone.token)).data.error.code, 'ALREADY_CLAIMED');
  assert.equal((await call('/api/world/route-sign', { challengeId: challenge.challengeId }, phone.token)).data.error.code, 'SIGN_CHALLENGE_INVALID');

  // 주행 중 목적지 변경 → 새 경로·새 표지판
  const firstKey = p.room.journeyRoute.key;
  await car.send({ type: 'navigation.report', reportSeq: ++seq, navigation: {
    source: 'PLEOS_NAVI_HELPER', sdkConnected: true, owned: false, routeRevision: 8, status: 'ROUTE_DRIVE', destination: '시청',
    destinationLatitude: 37.5663, destinationLongitude: 126.9779,
    latitude: sign.latitude, longitude: sign.longitude, locationAgeMs: 0, positionSource: 'SIMULATED' } });
  await until(() => p.room.journeyRoute?.key && p.room.journeyRoute.key !== firstKey);
  assert.equal(calls.length, 2, 'router called again for the new destination');
  assert.deepEqual(calls[1][0], { latitude: sign.latitude, longitude: sign.longitude }, 'new route starts at the current position');

  // 안내 종료 → 경로·표지판 해제
  await car.send({ type: 'navigation.report', reportSeq: ++seq, navigation: { source: 'PLEOS_NAVI_HELPER', sdkConnected: true, owned: false, routeRevision: 8, status: 'NAVIGATION_ENDED' } });
  await until(() => !p.room.journeyRoute);
});
