import { createHash } from 'node:crypto';

// 경로선을 따라 랜덤 표지판을 배치하고, 차량 위치에 따라 표지판 상태를 판정한다.
// 경로선 출처: 1) 서버에 등록된 경로(DEMO_ROUTE·EXTERNAL_ROUTING) 2) Pleos 목적지 좌표 + 외부 길찾기(OSRM)
// Pleos NaviHelper는 도로 폴리라인을 주지 않으므로(native-navigation.md) 2)는 외부 길찾기 결과다.

export const SIGN_POLICY = Object.freeze({
  minGapM: 1200, maxGapM: 2000, edgeM: 400, maxSigns: 12,
  readyRadiusM: 500, graceMs: 30_000, challengeMs: 5 * 60_000, minPlayMs: 5_000,
  offRouteM: 150, offRouteMs: 8_000,
  maxGeometryPoints: 400,
});
// 표지판마다 게임 하나가 정해진다. SIGN_GAMES는 실제로 플레이할 수 있는 게임,
// SIGN_COMING_SOON은 지도에 표지판만 나오고 아직 게임이 연결되지 않은 게임이다.
// 좀비 게임을 연결할 때는 'zombie'를 SIGN_GAMES로 옮기고 폰 화면(app.js driveTitles)에 게임을 추가한다.
export const SIGN_GAMES = Object.freeze(['license-quiz', 'pole-jump', 'raindrop']);
export const SIGN_COMING_SOON = Object.freeze(['zombie']);
export const SIGN_ROTATION = Object.freeze([...SIGN_GAMES, ...SIGN_COMING_SOON]);

const EARTH_M = 6371008.8;
const rad = value => value * Math.PI / 180;
export function distanceM(a, b) {
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function bearingDeg(a, b) {
  const y = Math.sin(rad(b.longitude - a.longitude)) * Math.cos(rad(b.latitude));
  const x = Math.cos(rad(a.latitude)) * Math.sin(rad(b.latitude)) -
    Math.sin(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.cos(rad(b.longitude - a.longitude));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function cumulative(geometry) {
  const cum = [0];
  for (let i = 1; i < geometry.length; i++) cum.push(cum[i - 1] + distanceM(geometry[i - 1], geometry[i]));
  return cum;
}

export function pointAt(geometry, cum, alongM) {
  const target = Math.max(0, Math.min(alongM, cum.at(-1)));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const span = cum[i] - cum[i - 1] || 1, t = (target - cum[i - 1]) / span;
  const a = geometry[i - 1], b = geometry[i];
  return { latitude: a.latitude + (b.latitude - a.latitude) * t, longitude: a.longitude + (b.longitude - a.longitude) * t };
}

/** 위치를 경로선에 투영한다. hintM 근처(앞쪽 우선)를 먼저 찾아 되돌아가는 구간의 오판을 줄인다. */
export function projectOnRoute(geometry, cum, point, hintM = null) {
  let best = { alongM: 0, offsetM: Infinity };
  const kx = Math.cos(rad(point.latitude)) * EARTH_M * Math.PI / 180, ky = EARTH_M * Math.PI / 180;
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1], b = geometry[i];
    const ax = (a.longitude - point.longitude) * kx, ay = (a.latitude - point.latitude) * ky;
    const bx = (b.longitude - point.longitude) * kx, by = (b.latitude - point.latitude) * ky;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const offsetM = Math.hypot(ax + dx * t, ay + dy * t);
    const alongM = cum[i - 1] + (cum[i] - cum[i - 1]) * t;
    // 이전 진행 위치보다 크게 뒤로 가는 후보에는 벌점을 준다(교차·왕복 도로 대비).
    const penalty = hintM != null && alongM < hintM - 150 ? 80 : 0;
    if (offsetM + penalty < best.offsetM + (best.penalty ?? 0)) best = { alongM, offsetM, penalty };
  }
  return { alongM: best.alongM, offsetM: best.offsetM };
}

/** Douglas–Peucker로 점 개수를 줄인다(폰 전송용). */
export function simplify(geometry, maxPoints = SIGN_POLICY.maxGeometryPoints) {
  if (geometry.length <= maxPoints) return geometry.map(p => ({ ...p }));
  let tolerance = 4;
  let result = geometry;
  while (result.length > maxPoints && tolerance < 2000) {
    result = douglasPeucker(geometry, tolerance);
    tolerance *= 1.6;
  }
  return result.map(p => ({ ...p }));
}
function douglasPeucker(points, toleranceM) {
  const keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const ref = points[0], kx = Math.cos(rad(ref.latitude)) * 111320, ky = 110540;
  const xy = p => [(p.longitude - ref.longitude) * kx, (p.latitude - ref.latitude) * ky];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [sx, sy] = xy(points[s]), [ex, ey] = xy(points[e]);
    let maxD = -1, index = -1;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = xy(points[i]), dx = ex - sx, dy = ey - sy, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / len2)) : 0;
      const d = Math.hypot(px - (sx + dx * t), py - (sy + dy * t));
      if (d > maxD) { maxD = d; index = i; }
    }
    if (maxD > toleranceM) { keep[index] = 1; stack.push([s, index], [index, e]); }
  }
  return points.filter((_, i) => keep[i]);
}

function seededRandom(seed) {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0) || 1;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 셔플 백: 모든 게임이 한 번씩 나온 뒤에 다음 순서를 다시 섞는다.
 * 묶음이 바뀌는 경계에서도 같은 게임이 연속으로 나오지 않는다.
 */
export function gameSequence(random, games = SIGN_ROTATION) {
  let bag = [], last = null;
  return () => {
    if (!bag.length) {
      bag = [...games];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      if (bag.length > 1 && bag[0] === last) [bag[0], bag[1]] = [bag[1], bag[0]];
    }
    last = bag.shift();
    return last;
  };
}

/** 같은 seed와 경로면 크루 모두에게 같은 위치·같은 게임이 나온다. */
export function placeSigns(seed, geometry, cum = cumulative(geometry), policy = SIGN_POLICY, games = SIGN_ROTATION) {
  const lengthM = cum.at(-1), random = seededRandom(seed), signs = [];
  const nextGame = gameSequence(seededRandom(seed + ':games'), games);
  if (lengthM < 300) return signs;
  const end = lengthM - policy.edgeM;
  let along = Math.min(policy.edgeM + random() * policy.minGapM, lengthM / 2);
  while (along <= Math.max(end, lengthM / 2) && signs.length < policy.maxSigns) {
    const point = pointAt(geometry, cum, along);
    signs.push({ signId: 's' + (signs.length + 1), alongM: Math.round(along), gameId: nextGame(), ...point });
    along += policy.minGapM + random() * (policy.maxGapM - policy.minGapM);
  }
  return signs;
}

/** OSRM 호환 길찾기. baseUrl 예: https://router.project-osrm.org */
export function osrmRouter(baseUrl, { timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
  const base = new URL(baseUrl);
  return async (origin, destination, waypoints = []) => {
    const pair = p => p.longitude.toFixed(6) + ',' + p.latitude.toFixed(6);
    const coordinatesPath = [origin, ...waypoints, destination].map(pair).join(';');
    const url = new URL(base.pathname.replace(/\/$/, '') + '/route/v1/driving/' + coordinatesPath, base);
    url.searchParams.set('overview', 'full');
    url.searchParams.set('geometries', 'geojson');
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('ROUTER_HTTP_' + response.status);
    const data = await response.json();
    const coordinates = data?.routes?.[0]?.geometry?.coordinates;
    if (data?.code !== 'Ok' || !Array.isArray(coordinates) || coordinates.length < 2) throw new Error('ROUTER_NO_ROUTE');
    return coordinates.slice(0, 20000).map(([longitude, latitude]) => ({ latitude, longitude }));
  };
}

function validGeometry(geometry) {
  return Array.isArray(geometry) && geometry.length >= 2 && geometry.every(p =>
    Number.isFinite(p?.latitude) && Math.abs(p.latitude) <= 90 && Number.isFinite(p?.longitude) && Math.abs(p.longitude) <= 180);
}

/**
 * 방별 경로 계획. context는 server.mjs가 만든다.
 *  - { key, source, geometry }                         등록된 경로
 *  - { key, source, origin, waypoints?, destination, native }  외부 길찾기 필요(Pleos 경유지·목적지)
 * 새 경로를 받아오는 동안(재탐색)에는 기존 경로·표지판을 그대로 보여준다.
 */
export function createRoutePlanner({ router = null, clock = Date.now, onReady = () => {}, policy = SIGN_POLICY } = {}) {
  const rooms = new Map(); // roomId → { ready, pending }

  function build(roomId, context, geometry, source) {
    const cum = cumulative(geometry);
    return {
      key: context.key, status: 'READY', source, geometry, cum, lengthM: Math.round(cum.at(-1)),
      signs: placeSigns(roomId + ':' + context.key, geometry, cum, policy),
      progressM: 0, offsetM: null, offSince: null, native: Boolean(context.native), nearAt: new Map(),
      destination: context.destination ?? geometry.at(-1),
      displayGeometry: simplify(geometry, policy.maxGeometryPoints),
    };
  }
  const entry = roomId => rooms.get(roomId) ?? rooms.set(roomId, { ready: null, pending: null }).get(roomId);
  const ready = roomId => rooms.get(roomId)?.ready ?? null;

  function sync(roomId, context) {
    if (!context) { rooms.delete(roomId); return false; }
    const state = entry(roomId);
    if (state.pending?.key === context.key || (!state.pending && state.ready?.key === context.key)) return false;
    if (context.geometry) {
      state.pending = null;
      state.ready = validGeometry(context.geometry) ? build(roomId, context, context.geometry, context.source) : null;
      return true;
    }
    if (!context.origin || !context.destination) return false;
    const pending = { key: context.key };
    state.pending = pending;
    const { origin, waypoints = [], destination } = context;
    const request = router ? router(origin, destination, waypoints) : Promise.reject(new Error('ROUTER_DISABLED'));
    Promise.resolve(request).then(geometry => {
      if (!validGeometry(geometry)) throw new Error('ROUTER_INVALID');
      return { geometry, source: context.source };
    }).catch(error => ({ geometry: [origin, ...waypoints, destination], source: 'STRAIGHT_LINE_FALLBACK',
      error: String(error?.message ?? error) }))
      .then(({ geometry, source, error }) => {
        const current = rooms.get(roomId);
        if (current?.pending !== pending) return;
        const plan = build(roomId, context, geometry, source);
        if (error) plan.routerError = error.slice(0, 64);
        current.ready = plan;
        current.pending = null;
        onReady(roomId);
      });
    return true;
  }

  function observe(roomId, position) {
    const plan = ready(roomId);
    if (!plan || !position) return;
    const projected = projectOnRoute(plan.geometry, plan.cum, position, plan.progressM);
    plan.offsetM = Math.round(projected.offsetM);
    const now = clock();
    // 경로에서 300m 넘게 벗어나면 진행 거리를 갱신하지 않는다(재탐색 대기).
    if (projected.offsetM <= 300) plan.progressM = projected.alongM;
    plan.offSince = projected.offsetM > policy.offRouteM ? plan.offSince ?? now : null;
    for (const sign of plan.signs) if (isNear(plan, sign, position)) plan.nearAt.set(sign.signId, now);
  }

  /** 외부 길찾기 경로에서 일정 시간 이상 벗어나 있으면 재탐색이 필요하다. */
  function offRoute(roomId) {
    const state = rooms.get(roomId), plan = state?.ready;
    return Boolean(plan?.native && !state.pending && plan.offSince != null && clock() - plan.offSince >= policy.offRouteMs);
  }

  // 직선거리뿐 아니라 경로상 거리도 가까워야 한다(U턴·교차로에서 반대편 표지판이 열리는 것 방지).
  function isNear(plan, sign, position) {
    return Boolean(position) && distanceM(position, sign) <= policy.readyRadiusM &&
      Math.abs(sign.alongM - plan.progressM) <= policy.readyRadiusM * 2;
  }
  function signState(plan, sign, position, claimedByMe) {
    if (claimedByMe) return 'CLAIMED';
    // 지나친 뒤에는 경로상 readyRadiusM(500m) 이내·30초 이내까지만 게임을 열어 둔다.
    const nearAt = plan.nearAt.get(sign.signId);
    const passedM = plan.progressM - sign.alongM;
    if (position && nearAt != null && clock() - nearAt <= policy.graceMs && passedM >= 0 && passedM <= policy.readyRadiusM) return 'READY';
    if (isNear(plan, sign, position)) return 'READY';
    return passedM > 0 ? 'MISSED' : 'AHEAD';
  }

  function view(roomId, position, claims = {}, memberId = null) {
    const state = rooms.get(roomId);
    if (!state) return null;
    const plan = state.ready;
    if (!plan) return state.pending ? { status: 'PENDING', signs: [] } : null;
    return {
      status: 'READY', key: plan.key, source: plan.source, lengthM: plan.lengthM,
      progressM: Math.round(plan.progressM), offRouteM: plan.offsetM, rerouting: Boolean(state.pending),
      geometry: plan.displayGeometry, destination: plan.destination,
      readyRadiusM: policy.readyRadiusM,
      signs: plan.signs.map(sign => {
        const claimers = claims[plan.key + ':' + sign.signId] ?? [];
        return {
          signId: sign.signId, gameId: sign.gameId, playable: SIGN_GAMES.includes(sign.gameId),
          latitude: sign.latitude, longitude: sign.longitude, alongM: sign.alongM,
          aheadM: Math.round(sign.alongM - plan.progressM),
          distanceM: position ? Math.round(distanceM(position, sign)) : null,
          state: signState(plan, sign, position, memberId != null && claimers.includes(memberId)),
          crewClaims: claimers.length,
        };
      }),
    };
  }

  function sign(roomId, signId, position) {
    const plan = ready(roomId);
    if (!plan) return null;
    const found = plan.signs.find(s => s.signId === signId);
    return found ? { plan, sign: found, state: signState(plan, found, position, false) } : null;
  }

  return {
    sync, observe, offRoute, view, sign, drop: roomId => rooms.delete(roomId),
    plan: ready,
    /** 현재 진행 중인 경로 key(받아오는 중이면 그 key) */
    key: roomId => rooms.get(roomId)?.pending?.key ?? rooms.get(roomId)?.ready?.key ?? null,
  };
}
