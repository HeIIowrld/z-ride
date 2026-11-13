const $ = id => document.getElementById(id);
const id = location.pathname.match(/\/vehicles\/([123])\/?$/)?.[1];
const panel = $('journey');
const route = $('route'), speed = $('speed'), rate = $('rate');
const start = $('route-start'), end = $('route-end'), seek = $('journey-progress');
const scenarios = {};
const stateNames = {
  IDLE: '대기', READY: '출발 준비', MOVING: '이동 중', PAUSED: '일시정지',
  PARKED: '주차', ARRIVED: '도착 · 주차', CANCELLED: '여정 종료', ERROR: '연결 오류'
};
const routeNames = { NONE: '미설정', PENDING: '적용 중', APPLIED: '적용됨' };
const errors = {
  REVISION_CONFLICT: '다른 조작이 먼저 반영됐습니다. 현재 상태를 확인해 주세요.',
  ROUTE_NOT_APPLIED: '경로를 적용하고 Pleos 앱이 응답할 때까지 기다려 주세요.',
  DESTINATION_REQUIRED: '경로를 먼저 적용해 주세요.',
  INVALID_PARAMETERS: '출발·도착의 위도와 경도를 확인해 주세요.',
  INVALID_ROUTE_LENGTH: '두 지점 사이는 1m 이상, 약 19km 이하여야 합니다.',
  ROUTE_FINISHED: '재생 위치를 앞으로 옮기거나 경로를 다시 적용해 주세요.',
  EMULATOR_UNAVAILABLE: 'Pleos 앱에서 여정을 시작했는지 확인해 주세요.',
  EMULATOR_LOCATION_REJECTED: '에뮬레이터에서 시험 위치를 받지 못했습니다.',
  REQUEST_FAILED: '요청에 실패했습니다. 차량 상태를 확인해 주세요.'
};
let state, revision = 0, busy = false, refreshing = false, editingSeek = false;

$('console-link').href = `/vehicles/console/${id}/`;

function coordinates(input) {
  const match = input.value.trim().match(/^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/);
  if (!match) throw Error('INVALID_PARAMETERS');
  const [, latitude, longitude] = match.map(Number);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw Error('INVALID_PARAMETERS');
  return { latitude, longitude };
}

const formatPoint = p => `${Number(p.latitude.toFixed(6))}, ${Number(p.longitude.toFixed(6))}`;

function selectedPoints() {
  if (route.value === 'custom') return [coordinates(start), coordinates(end)];
  return scenarios[route.value]?.geometry ?? [];
}

function distance(points) {
  return points.slice(1).reduce((total, b, i) => {
    const a = points[i], lat = (a.latitude + b.latitude) * Math.PI / 360;
    return total + 111195 * Math.hypot(b.latitude - a.latitude, (b.longitude - a.longitude) * Math.cos(lat));
  }, 0);
}

function describeSelection() {
  const custom = route.value === 'custom';
  start.readOnly = end.readOnly = !custom;
  if (!custom) {
    const points = selectedPoints();
    start.value = points.length ? formatPoint(points[0]) : '';
    end.value = points.length ? formatPoint(points.at(-1)) : '';
  }
  let points;
  try { points = selectedPoints(); }
  catch { $('journey-estimate').textContent = '출발과 도착을 위도, 경도 순으로 입력하세요.'; return; }
  if (!points.length) return;
  const length = distance(points);
  const seconds = Math.max(1, Math.round(length / (Number(speed.value) / 3.6 * Number(rate.value))));
  const duration = seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초` : `${seconds}초`;
  $('journey-estimate').textContent = `약 ${length >= 1000 ? (length / 1000).toFixed(2) + 'km' : Math.round(length) + 'm'} · ${rate.value}배속에서 약 ${duration}${custom ? ' · 두 지점 사이 직선' : ''}`;
  if (!state?.geometry.length) draw(points, points[0]);
}

function restoreLink() {
  const params = new URLSearchParams(location.search);
  if (!params.has('scenario')) return;
  panel.open = true;
  const selected = params.get('scenario');
  if (Array.from(route.options).some(option => option.value === selected)) route.value = selected;
  for (const field of [speed, rate]) {
    const value = params.get(field.id);
    if (Array.from(field.options).some(option => option.value === value)) field.value = value;
  }
  if (route.value === 'custom') {
    start.value = params.get('start') ?? '';
    end.value = params.get('end') ?? '';
  }
  $('journey-result').textContent = '공유 설정을 불러왔습니다. 경로 적용을 눌러 사용하세요.';
}

function draw(points, position) {
  const svg = $('journey-map');
  svg.replaceChildren();
  if (!points.length || !position) return;
  const xs = points.map(p => p.longitude), ys = points.map(p => p.latitude);
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const scale = Math.min(540 / Math.max(0.00004, xmax - xmin), 120 / Math.max(0.00004, ymax - ymin));
  const xy = p => [300 + (p.longitude - (xmin + xmax) / 2) * scale, 80 - (p.latitude - (ymin + ymax) / 2) * scale];
  const line = document.createElementNS(svg.namespaceURI, 'polyline');
  line.setAttribute('points', points.map(p => xy(p).join(',')).join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', '#69e4cf');
  line.setAttribute('stroke-width', '3');
  svg.append(line);
  for (const [p, radius, color] of [[points[0], 4, '#69e4cf'], [points.at(-1), 4, '#e7f2fa'], [position, 6, '#ffb86b']]) {
    const dot = document.createElementNS(svg.namespaceURI, 'circle'), [x, y] = xy(p);
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
    dot.setAttribute('r', radius);
    dot.setAttribute('fill', color);
    svg.append(dot);
  }
}

function render(value) {
  state = value;
  revision = value.revision;
  const { geometry, position, progressM, distanceM, routeStatus } = value;
  $('journey-status').textContent = `${stateNames[value.state] || value.state} · 경로 ${routeNames[routeStatus] || routeStatus} · ${value.speedKph}km/h · ${value.rate}배속 · ${progressM}/${distanceM}m${value.error ? ' · ' + (errors[value.error] || value.error) : ''}`;
  const hasRoute = geometry.length > 1 && routeStatus === 'APPLIED';
  if (!editingSeek) seek.value = distanceM ? Math.round(progressM / distanceM * 100) : 0;
  $('journey-progress-value').value = seek.value + '%';
  seek.disabled = !hasRoute;
  for (const button of panel.querySelectorAll('button[data-action]')) {
    const action = button.dataset.action;
    button.disabled = busy || (['start', 'seek'].includes(action) && !hasRoute)
      || (action === 'pause' && value.state !== 'MOVING');
  }
  if (geometry.length) draw(geometry, position);
  else describeSelection();
}

async function refresh() {
  if (refreshing || busy) return;
  refreshing = true;
  try {
    const response = await fetch(`/vehicles/simulation/${id}`, { cache: 'no-store' });
    if (!response.ok) throw Error();
    const value = await response.json();
    if (!busy && value.revision >= revision) render(value);
  } catch {
    $('journey-status').textContent = '이동 시뮬레이터에 연결 중…';
  } finally { refreshing = false; }
}

panel.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button || busy) return;
  const action = button.dataset.action;
  const body = { action, route: route.value, speedKph: Number(speed.value), rate: Number(rate.value), expectedRevision: revision };
  try {
    if (route.value === 'custom' && ['destination', 'reroute'].includes(action)) [body.start, body.end] = selectedPoints();
    if (action === 'seek') body.progress = Number(seek.value) / 100;
    busy = true;
    if (state) render(state);
    const response = await fetch(`/vehicles/simulation/${id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || 'REQUEST_FAILED');
    editingSeek = false;
    render(value);
    $('journey-result').textContent = action === 'seek' ? '이동했습니다. 이어서 재생하려면 시작을 누르세요.' : '반영됐습니다.';
  } catch (error) {
    $('journey-result').textContent = errors[error.message] || errors.REQUEST_FAILED;
  } finally {
    busy = false;
    if (state) render(state);
    void refresh();
  }
});

$('share-journey').addEventListener('click', async () => {
  const url = new URL(location.pathname, location.origin);
  url.search = new URLSearchParams({ scenario: route.value, speed: speed.value, rate: rate.value });
  try {
    if (route.value === 'custom') {
      const points = selectedPoints();
      url.searchParams.set('start', formatPoint(points[0]));
      url.searchParams.set('end', formatPoint(points[1]));
    }
  } catch {
    $('journey-result').textContent = errors.INVALID_PARAMETERS;
    return;
  }
  try {
    await navigator.clipboard.writeText(url.href);
    $('share-fallback').hidden = true;
    $('journey-result').textContent = '시나리오 링크를 복사했습니다.';
  } catch {
    $('share-fallback').hidden = false;
    $('share-link').value = url.href;
    $('share-link').select();
  }
});

$('join-android').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch('/vehicles/phone/invite', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vehicle: Number(id) })
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error);
    $('journey-result').textContent = 'Android에 초대를 열었습니다. 동승자 화면에서 좌석을 신청하세요.';
  } catch (error) {
    $('journey-result').textContent = error.message === 'INVITE_NOT_VISIBLE'
      ? 'Pleos 앱에서 주차 상태로 새 QR을 띄워 주세요.'
      : 'Android 동승자 화면 연결을 확인해 주세요.';
  } finally { button.disabled = false; }
});

seek.addEventListener('input', () => {
  editingSeek = true;
  $('journey-progress-value').value = seek.value + '%';
});
for (const field of [route, speed, rate, start, end]) field.addEventListener('input', describeSelection);
restoreLink();
void fetch('/vehicles/scenarios.json').then(response => response.json()).then(value => {
  Object.assign(scenarios, value);
  describeSelection();
}).catch(() => {});
void refresh();
setInterval(refresh, 1500);
