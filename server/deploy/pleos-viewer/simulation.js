const $ = id => document.getElementById(id);
const id = location.pathname.match(/\/vehicles\/([123])\/?$/)?.[1];
const panel = $('journey'), route = $('route'), speed = $('speed'), rate = $('rate');
const start = $('route-start'), waypoint = $('route-waypoint'), end = $('route-end');
const seek = $('journey-progress'), result = $('journey-result'), map = $('journey-map');
const stateNames = {
  IDLE: '대기', READY: '출발 준비', MOVING: '이동 중', PAUSED: '일시정지',
  PARKED: '주차', ARRIVED: '도착 · 주차', CANCELLED: '여정 종료', ERROR: '연결 오류'
};
const routeNames = { NONE: '미설정', PENDING: '적용 중', APPLIED: '적용됨' };
const errors = {
  REVISION_CONFLICT: '다른 조작이 먼저 반영됐습니다. 현재 상태를 확인해 주세요.',
  ROUTE_NOT_APPLIED: '경로를 적용하고 Pleos 앱이 응답할 때까지 기다려 주세요.',
  DESTINATION_REQUIRED: '경로를 먼저 적용해 주세요.',
  INVALID_PARAMETERS: '각 지점을 위도, 경도 순서로 입력하세요.',
  INVALID_ROUTE_LENGTH: '경로는 총 1m 이상, 한 구간은 약 19km 이하여야 합니다.',
  ROUTE_FINISHED: '재생 위치를 앞으로 옮기거나 경로를 다시 적용해 주세요.',
  VEHICLE_ROOM_NOT_CONNECTED: 'Pleos에서 PLY 앱을 열고 크루 파티에 연결한 뒤 경로를 적용해 주세요.',
  VEHICLE_ROUTE_BRIDGE_TIMEOUT: '차량 앱이 경로를 받았다는 응답을 보내지 않았습니다. 파티 연결을 확인해 주세요.',
  ROUTE_SUBMIT_FAILED: '차량 앱에서 경로를 서버에 적용하지 못했습니다.',
  EMULATOR_OR_ROUTE_UNAVAILABLE: '차량 실행 상태와 크루 파티 연결을 확인해 주세요.',
  EMULATOR_UNAVAILABLE: 'Pleos 에뮬레이터 연결을 확인해 주세요.',
  EMULATOR_LOCATION_REJECTED: '에뮬레이터에서 시험 위치를 받지 못했습니다.',
  REQUEST_FAILED: '요청에 실패했습니다. 차량 상태를 확인해 주세요.'
};
let scenarios = {}, state, busy = false, refreshing = false, editingSeek = false;

$('console-link').href = `/vehicles/console/${id}/`;

function coordinates(input) {
  const match = input.value.trim().match(/^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/);
  if (!match) throw Error('INVALID_PARAMETERS');
  const latitude = Number(match[1]), longitude = Number(match[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw Error('INVALID_PARAMETERS');
  return { latitude, longitude };
}

const formatPoint = p => `${Number(p.latitude.toFixed(6))}, ${Number(p.longitude.toFixed(6))}`;

function selectedPoints() {
  if (route.value !== 'custom') return scenarios[route.value]?.geometry ?? [];
  const points = [coordinates(start)];
  if (waypoint.value.trim()) points.push(coordinates(waypoint));
  points.push(coordinates(end));
  return points;
}

function distance(points) {
  return points.slice(1).reduce((total, b, i) => {
    const a = points[i], latitude = (a.latitude + b.latitude) * Math.PI / 360;
    return total + 111195 * Math.hypot(b.latitude - a.latitude, (b.longitude - a.longitude) * Math.cos(latitude));
  }, 0);
}

function mapElement(tag, attrs) {
  const element = document.createElementNS(map.namespaceURI, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

function draw(points, position) {
  map.replaceChildren();
  if (!points.length) return;
  const latitudes = points.map(p => p.latitude), longitudes = points.map(p => p.longitude);
  const ymin = Math.min(...latitudes), ymax = Math.max(...latitudes);
  const xmin = Math.min(...longitudes), xmax = Math.max(...longitudes);
  const scale = Math.min(300 / Math.max(0.00004, xmax - xmin), 104 / Math.max(0.00004, ymax - ymin));
  const xy = p => [180 + (p.longitude - (xmin + xmax) / 2) * scale, 72 - (p.latitude - (ymin + ymax) / 2) * scale];
  const marker = (p, kind, radius) => {
    const [cx, cy] = xy(p);
    return mapElement('circle', { cx, cy, r: radius, class: `journey-marker journey-${kind}` });
  };

  map.append(mapElement('polyline', { points: points.map(p => xy(p).join(',')).join(' '), class: 'journey-line' }));
  for (const point of points.slice(1, -1)) map.append(marker(point, 'via', 6));
  map.append(marker(points[0], 'start', 8), marker(points.at(-1), 'end', 8));
  if (position) map.append(marker(position, 'position', 4));
}

function describeSelection() {
  const custom = route.value === 'custom';
  $('custom-points').hidden = !custom;

  let points = [], estimate = '시나리오를 불러오는 중…';
  try { points = selectedPoints(); }
  catch { estimate = errors.INVALID_PARAMETERS; }

  if (points.length) {
    const length = distance(points);
    const seconds = Math.max(1, Math.round(length / (Number(speed.value) / 3.6 * Number(rate.value))));
    const duration = seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초` : `${seconds}초`;
    const lengthLabel = length >= 1000 ? `${(length / 1000).toFixed(2)} km` : `${Math.round(length)} m`;
    estimate = `약 ${lengthLabel} · ${rate.value}배속에서 ${duration}`;
  }
  $('journey-estimate').textContent = estimate;
  map.toggleAttribute('hidden', !points.length);

  const stops = points.map((point, index) => {
    const row = document.createElement('li');
    const label = document.createElement('span');
    const value = document.createElement('span');
    if (index === 0) {
      row.className = 'journey-start';
      label.textContent = '출발지';
    } else if (index === points.length - 1) {
      row.className = 'journey-end';
      label.textContent = '도착지';
    } else {
      row.className = 'journey-via';
      label.textContent = points.length === 3 ? '경유지' : `경유지 ${index}`;
    }
    value.textContent = formatPoint(point);
    row.append(label, value);
    return row;
  });
  $('journey-stops').replaceChildren(...stops);
  drawPreview(points);
}

function drawPreview(points) {
  const active = state?.geometry;
  const matches = active?.length === points.length && points.every((point, i) =>
    point.latitude === active[i].latitude && point.longitude === active[i].longitude
  );
  draw(points, matches ? state.position : null);
}

function restoreLink() {
  const params = new URLSearchParams(location.search);
  if (!params.has('scenario')) return;
  const selected = params.get('scenario');
  if (!Array.from(route.options).some(option => option.value === selected)) return;
  route.value = selected;
  panel.open = true;
  for (const field of [speed, rate]) {
    const value = params.get(field.id);
    if (Array.from(field.options).some(option => option.value === value)) field.value = value;
  }
  if (route.value === 'custom') {
    start.value = params.get('start') ?? '';
    waypoint.value = params.get('via') ?? '';
    end.value = params.get('end') ?? '';
  }
  result.textContent = '공유 설정을 불러왔습니다. 경로 적용을 누르면 반영됩니다.';
}

function render(value) {
  state = value;
  const { geometry, progressM, distanceM, routeStatus } = value;
  const label = stateNames[value.state] || value.state;
  const error = value.error ? ' · ' + (errors[value.error] || value.error) : '';
  $('journey-status').textContent = geometry.length
    ? `재생 ${label} · 경로 ${routeNames[routeStatus] || routeStatus} · ${value.speedKph} km/h · ${progressM}/${distanceM} m${error}`
    : `재생 ${label}${error}`;
  const hasRoute = geometry.length > 1 && routeStatus === 'APPLIED';
  if (!editingSeek) seek.value = distanceM ? Math.round(progressM / distanceM * 100) : 0;
  $('journey-progress-value').value = seek.value + '%';
  seek.disabled = !hasRoute;
  for (const button of panel.querySelectorAll('button[data-action]')) {
    const action = button.dataset.action;
    button.disabled = busy || (['start', 'seek'].includes(action) && !hasRoute)
      || (action === 'pause' && value.state !== 'MOVING');
  }
  try { drawPreview(selectedPoints()); }
  catch { map.replaceChildren(); }
}

async function refresh() {
  if (refreshing || busy) return;
  refreshing = true;
  const previous = state;
  try {
    const response = await fetch(`/vehicles/simulation/${id}`, { cache: 'no-store' });
    if (!response.ok) throw Error();
    const value = await response.json();
    if (!busy && state === previous) render(value);
  } catch {
    $('journey-status').textContent = '이동 시뮬레이터에 연결 중…';
  } finally { refreshing = false; }
}

panel.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button || busy) return;
  const action = button.dataset.action;
  const body = {
    action, route: route.value, speedKph: Number(speed.value), rate: Number(rate.value),
    expectedRevision: state?.revision ?? 0
  };
  try {
    if (route.value === 'custom' && ['destination', 'reroute'].includes(action)) {
      const points = selectedPoints();
      body.start = points[0];
      body.end = points.at(-1);
      if (points.length === 3) body.waypoint = points[1];
    }
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
    result.textContent = action === 'seek' ? '이동했습니다. 시작을 누르면 이어서 재생합니다.' : '반영됐습니다.';
  } catch (error) {
    result.textContent = errors[error.message] || errors.REQUEST_FAILED;
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
      if (points.length === 3) url.searchParams.set('via', formatPoint(points[1]));
      url.searchParams.set('end', formatPoint(points.at(-1)));
    }
  } catch {
    result.textContent = errors.INVALID_PARAMETERS;
    return;
  }
  try {
    await navigator.clipboard.writeText(url.href);
    $('share-fallback').hidden = true;
    result.textContent = '여정 링크를 복사했습니다.';
  } catch {
    $('share-fallback').hidden = false;
    $('share-link').value = url.href;
    $('share-link').focus();
    $('share-link').select();
  }
});

$('join-android').addEventListener('click', async event => {
  const button = event.currentTarget, androidResult = $('android-result');
  button.disabled = true;
  try {
    const response = await fetch('/vehicles/phone/invite', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vehicle: Number(id) })
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error);
    androidResult.textContent = 'Android에 초대를 열었습니다. 동승자 화면에서 앉은 자리를 고르세요.';
  } catch (error) {
    androidResult.textContent = error.message === 'INVITE_NOT_VISIBLE'
      ? '주차 중 Pleos 크루 로비의 빈자리에서 초대를 열어 주세요.'
      : 'Android 동승자 화면 연결을 확인해 주세요.';
  } finally { button.disabled = false; }
});

seek.addEventListener('input', () => {
  editingSeek = true;
  $('journey-progress-value').value = seek.value + '%';
});
route.addEventListener('change', () => { if (route.value === 'custom') panel.open = true; });
for (const field of [route, speed, rate, start, waypoint, end]) {
  field.addEventListener('input', () => {
    $('share-fallback').hidden = true;
    result.textContent = '';
    describeSelection();
  });
}
restoreLink();
describeSelection();
void fetch('/vehicles/scenarios.json').then(response => {
  if (!response.ok) throw Error();
  return response.json();
}).then(value => {
  scenarios = value;
  describeSelection();
}).catch(() => {
  if (route.value !== 'custom') $('journey-estimate').textContent = '시나리오를 불러오지 못했습니다.';
});
void refresh();
setInterval(refresh, 1500);
