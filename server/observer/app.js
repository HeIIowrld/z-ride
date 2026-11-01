'use strict';
const $ = id => document.getElementById(id);
const roleNames = { CAR_HOST: '운전자 · 공동 관제', DRIVER: '운전자 · 공동 관제', FRONT_PASSENGER: '앞 동승석 · 전방 사수', REAR_LEFT: '뒤 왼쪽 · 좌측 방어', REAR_RIGHT: '뒤 오른쪽 · 우측 방어' };
const stateNames = { LOBBY: '참가 대기', READY: '시작 준비', PLAYING: '전투 진행', PAUSED: '전투 일시중지', CLEARED: '거점 공략 완료' };
const gateNames = { CAR_DISCONNECTED: '차량 연결 끊김', APP_INACTIVE: '차량 앱 비활성', LEASE_EXPIRED: '차량 보고 만료', UX_RESTRICTED: '주행 중 UX 제한', UX_UNKNOWN: 'UX 상태 미상', GEAR_NOT_P: 'P 이외 기어', GEAR_UNKNOWN: '기어 미상', UNKNOWN_GATE: '차량 보고 대기' };
let socket = null, credentials = null, room = null, retry = 0, retryTimer = null, generation = 0, selected = 'all';
const clock = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function connection(label, kind = '') { $('connection').className = 'connection ' + kind; $('connection').replaceChildren(document.createElement('i'), document.createTextNode(label)); }
function close(clear = true) { generation++; clearTimeout(retryTimer); if (socket) { socket.onclose = null; socket.close(); socket = null; } if (clear) credentials = null; }
function connect() {
  const current = ++generation;
  clearTimeout(retryTimer);
  connection(retry ? '재연결 중…' : '인증 중…'); $('connect-button').disabled = true;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(scheme + '//' + location.host + '/observer/ws');
  socket.onopen = () => { if (current === generation && credentials) socket.send(JSON.stringify({ type: 'observer.auth', token: credentials.token, roomId: credentials.roomId })); };
  socket.onmessage = event => {
    if (current !== generation) return;
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'observer.auth.ok') {
      retry = 0; $('token-input').value = ''; $('form-error').textContent = ''; $('connect-button').disabled = false;
      document.body.classList.add('compact-login'); connection('실시간 연결', 'live');
    } else if (message.type === 'observer.snapshot') {
      if (room && room.roomId === message.room.roomId && message.room.stateVersion < room.stateVersion) return;
      room = message.room; render();
    } else if (message.type === 'observer.heartbeat') connection('실시간 연결', 'live');
    else if (message.type === 'observer.error') {
      $('form-error').textContent = '연결할 수 없습니다 · ' + (message.error?.code || 'UNKNOWN');
      document.body.classList.remove('compact-login'); connection('인증 실패', 'error'); credentials = null;
      $('room-picker-panel').hidden = true;
    }
  };
  socket.onerror = () => { if (current === generation) connection('연결 확인 중…', 'error'); };
  socket.onclose = event => {
    if (current !== generation) return;
    $('connect-button').disabled = false;
    if ([4401, 4403].includes(event.code)) { credentials = null; document.body.classList.remove('compact-login'); }
    if (!credentials) { connection('연결 종료'); return; }
    connection('연결 끊김 · 재시도 대기', 'error');
    const delay = Math.min(15000, 1000 * 2 ** retry++) + Math.random() * 400;
    retryTimer = setTimeout(connect, delay);
  };
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); close(); room = null; selected = 'all';
  credentials = { token: $('token-input').value.trim(), roomId: $('room-input').value.trim(), mode: $('auth-mode').value }; retry = 0;
  $('form-error').textContent = ''; $('live-content').hidden = true;
  if (credentials.mode === 'operator') await refreshRooms(true); else { $('room-picker-panel').hidden = true; connect(); }
});
$('auth-mode').addEventListener('change', () => {
  const host = $('auth-mode').value === 'host'; $('room-input-label').hidden = !host; $('room-input').required = host;
  $('token-label').textContent = host ? '차량 호스트 토큰' : '운영자 관찰키'; $('token-input').placeholder = host ? 'CAR_HOST session token' : 'read-only observer key';
  $('login-form').classList.toggle('host-login', host);
});
$('refresh-rooms').addEventListener('click', () => refreshRooms(false));
$('room-picker').addEventListener('change', () => {
  if (!credentials || !$('room-picker').value) return;
  close(false); credentials.roomId = $('room-picker').value; room = null; selected = 'all'; retry = 0;
  $('live-content').hidden = true; connect();
});
$('disconnect-button').addEventListener('click', () => { close(); document.body.classList.remove('compact-login'); $('live-content').hidden = true; $('room-picker-panel').hidden = true; $('empty-state').hidden = false; room = null; connection('연결 종료'); });
$('view-select').addEventListener('change', event => { selected = event.target.value; renderPlayers(); });
window.addEventListener('beforeunload', () => close());

async function refreshRooms(autoConnect) {
  if (!credentials || credentials.mode !== 'operator') return;
  const attempt = credentials;
  $('connect-button').disabled = true;
  try {
    const response = await fetch('/api/observer/rooms', { headers: { Authorization: 'Bearer ' + attempt.token }, cache: 'no-store' });
    const data = await response.json();
    if (credentials !== attempt) return;
    if (!response.ok) throw new Error(data.error?.code || 'OBSERVER_UNAVAILABLE');
    $('token-input').value = ''; $('room-picker-panel').hidden = false;
    const list = data.rooms ?? [];
    const options = list.map(item => Object.assign(document.createElement('option'), { value: item.roomId, textContent: item.roomId + ' · ' + (stateNames[item.state] || item.state) + ' · ' + item.connectedCount + '/' + item.memberCount + '명' }));
    if (!options.length) options.push(Object.assign(document.createElement('option'), { value: '', textContent: '현재 생성된 방이 없습니다.' }));
    $('room-picker').replaceChildren(...options);
    if (list.some(item => item.roomId === credentials.roomId)) $('room-picker').value = credentials.roomId;
    $('room-list-status').textContent = list.length + '개 방 · 읽기 전용 운영자';
    if ((autoConnect || !socket) && list.length) { credentials.roomId = $('room-picker').value; connect(); }
    else if (autoConnect) connection('운영자 인증됨 · 방 생성 대기', 'live');
  } catch (error) {
    if (credentials !== attempt) return;
    $('form-error').textContent = '방 목록을 가져올 수 없습니다 · ' + error.message;
    connection('관제 인증 확인 필요', 'error');
    if (autoConnect) credentials = null;
  } finally { $('connect-button').disabled = false; }
}

function render() {
  $('empty-state').hidden = true; $('live-content').hidden = false;
  $('room-title').textContent = room.roomId;
  $('room-meta').textContent = 'STATE v' + room.stateVersion + ' · BATTLE #' + room.roomEpoch + ' · 서버 상태 관찰';
  $('battle-state').textContent = stateNames[room.state] || room.state;
  $('battle-state').className = room.state === 'PLAYING' ? 'good' : 'warn';
  $('battle-reason').textContent = room.pauseReason ? room.pauseReason.split(',').map(value => gateNames[value] || value).join(' · ') : '현재 서버 전투 상태';
  $('supplies').replaceChildren(document.createTextNode(String(room.inventory.supplies)), Object.assign(document.createElement('span'), { textContent: '개' }));
  $('shots').textContent = room.stats.hits + ' / ' + room.stats.shots;
  $('kills').textContent = '처치 ' + room.stats.kills + ' · 남은 적 ' + room.zombies.filter(zombie => zombie.hp > 0).length;
  $('vehicle-gate').textContent = room.vehicle.playAllowed ? '주차 허용' : '잠김';
  $('vehicle-gate').className = room.vehicle.playAllowed ? 'good' : 'warn';
  $('vehicle-state').textContent = 'UX ' + room.vehicle.ux + ' · 기어 ' + room.vehicle.gear + ' · ' + (room.vehicle.foreground ? '앱 활성' : '앱 비활성');
  $('participant-count').textContent = room.members.filter(member => member.connected).length + ' / ' + room.members.length + ' 연결';
  $('updated-at').textContent = clock.format(room.serverTime) + ' KST 갱신';
  const options = [Object.assign(document.createElement('option'), { value: 'all', textContent: '모든 참가자' }), ...room.members.map(member => Object.assign(document.createElement('option'), { value: member.memberId, textContent: member.nickname + ' · ' + (roleNames[member.role] || member.role) }))];
  if (selected !== 'all' && !room.members.some(member => member.memberId === selected)) selected = 'all';
  $('view-select').replaceChildren(...options); $('view-select').value = selected;
  const shot = room.stats.lastShot;
  const member = shot && room.members.find(value => value.memberId === shot.memberId);
  $('last-action').textContent = shot ? (member?.nickname || '참가자') + ' · ' + shot.angleDeg + '° · ' + (shot.accepted ? shot.hit ? '명중 / 피해 ' + shot.damage : '빗나감' : '허용 범위 밖 사격 거절') : '아직 사격 기록이 없습니다.';
  $('support-state').textContent = room.stats.supportActive ? '지원 효과 ×' + room.stats.supportDamage : '지원 대기';
  renderEffects();
  renderPlayers();
}
function renderEffects() {
  const effects = room.effects;
  const channels = { AIRFLOW: '바람', AMBIENT: '실내 조명', AUDIO: '음향' };
  const cues = { DRIVE_WIND: '가상 주행', DANGER: '위험', HIT: '피격', ESCAPE: '탈출' };
  const statuses = { ISSUED: '의도 발행 · SDK 미확인', RECEIVED: '차량 수신 · SDK 미확인', DISPATCHED: '설정 호출 · SDK 미확인', APPLIED_CONFIRMED: '차량 보고: SDK 값 확인', UNSUPPORTED: '미지원', REJECTED_GATE: '차량 조건 거절', USER_OVERRIDDEN: '사용자 조작 우선', FAILED: '실행 실패', STOPPED: '중지' };
  const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
  const observed = value => value === null || value === undefined ? '관측값 없음' : '관측값 ' + String(value).slice(0, 80);
  $('effects-enabled').textContent = effects?.enabled ? '활성화' : '꺼짐';
  $('effects-enabled').classList.toggle('enabled', effects?.enabled === true);
  $('effects-scene').textContent = effects?.sceneId ? 'SCENE ' + effects.sceneId : '장면 없음';
  $('effects-speed').textContent = finite(effects?.virtualSpeedMps).toFixed(1) + ' m/s';
  $('effects-channels').textContent = effects?.channels?.length ? effects.channels.map(channel => channels[channel] || channel).join(' · ') + ' / ' + Math.round(finite(effects.maxIntensity01) * 100) + '%' : '활성 채널 없음';
  const report = effects?.lastReport;
  $('effects-report').textContent = report ? (statuses[report.status] || report.status) + ' · ' + observed(report.observedValue) : 'SDK 미확인';
  $('effects-stop').textContent = effects?.lastStopReason || '—';
  const active = effects?.active || [];
  const items = active.map(effect => {
    const item = document.createElement('li');
    const name = document.createElement('b'); name.textContent = (channels[effect.channel] || effect.channel) + ' · ' + (cues[effect.cue] || effect.cue);
    const intensity = document.createElement('span'); intensity.textContent = '강도 ' + Math.round(finite(effect.intensity01) * 100) + '%';
    const state = document.createElement('span'); state.textContent = statuses[effect.status] || effect.status;
    const value = document.createElement('small'); value.textContent = observed(effect.observedValue);
    item.append(name, intensity, state, value); return item;
  });
  if (!items.length) { const item = document.createElement('li'); item.className = 'effects-empty'; item.textContent = '현재 유효한 효과 의도 없음'; items.push(item); }
  $('effects-active').replaceChildren(...items);
}
function renderPlayers() {
  if (!room) return;
  const members = room.members.filter(member => selected === 'all' || member.memberId === selected);
  $('players').className = 'players' + (selected === 'all' ? '' : ' single');
  $('players').replaceChildren(...members.map(member => {
    const card = document.createElement('article'); card.className = 'player-card' + (member.connected ? '' : ' offline');
    const header = document.createElement('div'); header.className = 'player-head';
    const name = document.createElement('div'); name.className = 'player-name'; name.textContent = member.nickname;
    const role = document.createElement('span'); role.className = 'player-role'; role.textContent = roleNames[member.role] || member.role; name.append(role);
    const badge = document.createElement('span'); badge.className = 'player-badge' + (!member.approved ? ' pending' : !member.connected ? ' offline' : ''); badge.textContent = !member.approved ? '승인 대기' : member.connected ? 'CONNECTED' : 'OFFLINE'; header.append(name, badge);
    const wrap = document.createElement('div'); wrap.className = 'radar-wrap'; const canvas = document.createElement('canvas'); canvas.setAttribute('aria-label', member.nickname + '의 서버 상태 기반 시야'); wrap.append(canvas);
    const foot = document.createElement('div'); foot.className = 'player-foot';
    const sector = document.createElement('span'); sector.textContent = member.sector ? member.sector[0] + '° ~ ' + member.sector[1] + '° 사격' : '관제 · 지원 역할';
    const evidence = document.createElement('span'); evidence.textContent = ({ SENSOR: '착석 신호', EMPTY: '빈 좌석 잠금', MANUAL_UNKNOWN: '좌석 수동 매칭' })[member.seatEvidence] || '착석 미상'; foot.append(sector, evidence);
    card.append(header, wrap, foot); requestAnimationFrame(() => drawRadar(canvas, member)); return card;
  }));
}
function drawRadar(canvas, member) {
  if (!room || !canvas.isConnected) return;
  const ratio = window.devicePixelRatio || 1; const width = canvas.clientWidth, height = canvas.clientHeight;
  canvas.width = width * ratio; canvas.height = height * ratio;
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
  const cx = width / 2, cy = height / 2 + 4, radius = Math.min(width * .34, height * .37);
  const point = (angle, distance) => [cx + Math.sin(angle * Math.PI / 180) * distance, cy - Math.cos(angle * Math.PI / 180) * distance];
  ctx.lineWidth = 1;
  for (const factor of [.32, .65, 1]) { ctx.beginPath(); ctx.arc(cx, cy, radius * factor, 0, Math.PI * 2); ctx.strokeStyle = '#29404c'; ctx.stroke(); }
  for (const angle of [0, 90, 180, -90]) { const [x, y] = point(angle, radius + 10); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.strokeStyle = '#233641'; ctx.stroke(); }
  if (member.sector && member.approved) {
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, radius, (member.sector[0] - 90) * Math.PI / 180, (member.sector[1] - 90) * Math.PI / 180); ctx.closePath();
    ctx.fillStyle = member.seatEvidence === 'EMPTY' ? '#d1906020' : '#8be5c21d'; ctx.fill(); ctx.strokeStyle = '#8be5c265'; ctx.stroke();
  }
  ctx.textAlign = 'center'; ctx.font = '9px sans-serif'; ctx.fillStyle = '#8195a9'; ctx.fillText('FRONT 0°', cx, cy - radius - 17); ctx.fillText('REAR 180°', cx, cy + radius + 23);
  for (const zombie of room.zombies) {
    const [x, y] = point(zombie.angleDeg, radius * .78); const inSector = !member.sector || (zombie.angleDeg >= member.sector[0] && zombie.angleDeg <= member.sector[1]);
    ctx.globalAlpha = zombie.hp <= 0 ? .2 : !member.approved || !inSector ? .33 : 1;
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fillStyle = '#eaa07c'; ctx.fill(); ctx.strokeStyle = '#ffd3ba'; ctx.stroke();
    ctx.fillStyle = '#354755'; ctx.fillRect(x - 15, y + 14, 30, 3); ctx.fillStyle = '#eaa07c'; ctx.fillRect(x - 15, y + 14, 30 * (zombie.maxHp ? zombie.hp / zombie.maxHp : 0), 3);
    ctx.font = '9px sans-serif'; ctx.fillStyle = '#c7d1dc'; ctx.fillText(zombie.hp + '/' + zombie.maxHp, x, y + 30);
  }
  ctx.globalAlpha = 1;
  const last = room.stats.lastShot;
  if (last && last.memberId === member.memberId && Date.now() - last.time < 15000) {
    const [x, y] = point(last.angleDeg, radius * .9); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.strokeStyle = last.accepted ? '#b8ffe2' : '#f2a69b'; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.save(); ctx.translate(cx, cy); ctx.fillStyle = member.role === 'CAR_HOST' ? '#8be5c2' : '#b5d9f2'; ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath(); ctx.fill(); ctx.restore();
  if (!member.approved || member.seatEvidence === 'EMPTY') { ctx.fillStyle = '#07121cc9'; ctx.fillRect(0, 0, width, height); ctx.fillStyle = '#c5d2df'; ctx.font = '13px sans-serif'; ctx.fillText(!member.approved ? '차량 호스트의 승인을 기다리는 중' : '빈 좌석 · 전투 입력 잠금', cx, cy); }
}
window.addEventListener('resize', () => renderPlayers());
