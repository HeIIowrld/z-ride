'use strict';
const $ = id => document.getElementById(id);
const apiOrigin=window.ZRIDE_CONFIG?.apiOrigin||location.origin;
const seats = { FRONT_PASSENGER: '앞 동승석 · 전방 사수', REAR_LEFT: '뒤 왼쪽 · 좌측 방어', REAR_RIGHT: '뒤 오른쪽 · 우측 방어', DRIVER: '운전자 · 지원 담당' };
const states = { LOBBY: '시작 대기', READY: '시작 준비', PLAYING: '전투 진행', PAUSED: '전투 중지', CLEARED: '거점 공략 완료', PENDING: '승인 대기' };
const gateNames = { CAR_DISCONNECTED: '차량 연결 끊김', APP_INACTIVE: '차량 앱 비활성', LEASE_EXPIRED: '차량 보고 만료', UX_RESTRICTED: '주행 중 전투 제한', UX_UNKNOWN: '차량 UX 확인 중', GEAR_NOT_P: '주차 후 전투 가능', GEAR_UNKNOWN: '차량 기어 확인 중', MEMBER_PENDING: '차량 승인 대기' };
const errors = { TEST_ACCESS_REQUIRED: '테스트 접근키를 확인해 주세요. 관찰키와는 다른 키임.', MEMBER_PENDING: '차량에서 참가자를 먼저 승인해 주세요.', AUTH_EXPIRED: '세션이 만료됨. 새 참가 코드로 다시 참가해 주세요.', INVALID_JOIN_CODE: '참가 코드가 잘못됐거나 만료됨. 차량에서 새 코드를 받아 주세요.', JOIN_CODE_EXPIRED: '참가 코드가 만료됨. 차량에서 새 코드를 받아 주세요.', GATE_CLOSED: '차량 전투 조건이 닫힘. 주차 후 차량에서 다시 시작해 주세요.', NOT_PLAYING: '차량에서 공동 전투를 시작해야 사격할 수 있음.', ALREADY_COLLECTED: '파티에서 획득한 상자임. 리스폰 후 다시 수집 가능.', SEAT_EMPTY: '차량에서 이 자리가 비어 있다고 보고됨.', STALE_EPOCH: '전투 상태가 바뀜. 최신 화면에서 다시 시도해 주세요.', SEAT_TAKEN: '이미 사용 중인 자리임. 다른 자리를 선택해 주세요.' };
let credentials = null, room = null, socket = null, memberId = null, generation = 0, retry = 0, retryTimer = null, pending = null, receivedAt = 0, joining = false;
let counter = 0;
const id = () => 'web-' + Date.now().toString(36) + '-' + (++counter).toString(36) + '-' + Math.random().toString(36).slice(2, 12);
function status(message, kind = '') { $('connection').textContent = message; $('connection').className = 'connection ' + kind; }
function result(message) { $('action-result').textContent = message; }
function ownMember() { return room?.members?.find(member => member.memberId === memberId); }
function inside(angle, sector) { return !!sector && ((Math.abs(angle) === 180 && ownMember()?.seat?.startsWith('REAR_')) || (angle >= sector[0] && angle <= sector[1])); }
function online() { return socket?.readyState === WebSocket.OPEN && !!credentials && !!memberId; }
function gateOpen() { return room?.vehicle?.playAllowed === true && room.vehicle.reportAgeMs != null && room.vehicle.reportAgeMs + Date.now() - receivedAt <= 6000; }
function reset(clear = true) {
  generation++; clearTimeout(retryTimer); clearTimeout(pending?.timer); pending = null;
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
  if (clear) { credentials = null; room = null; memberId = null; }
}
async function post(path, body, token) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(new URL(path,apiOrigin), { method: 'POST', cache: 'no-store', signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.code || 'HTTP_' + response.status);
    return value;
  } finally { clearTimeout(timer); }
}
function describe(error) {
  const code = error?.message || error;
  if(code==='VEHICLE_QR_REQUIRED')return '먼저 차량 화면의 QR을 찍어 주세요.';
  if(code==='ACCOUNT_AUTH_REQUIRED')return '위에서 Google 로그인 또는 게스트 시작을 해 주세요.';
  if(code==='PARTY_SWITCH_CONFIRMATION_REQUIRED')return '차량 변경 안내를 확인하고 동의 체크를 해 주세요.';
  if(code==='ALREADY_IN_PARTY')return '이미 이 파티에 참가했음. 위의 현재 파티 화면 연결을 눌러 주세요.';
  if(code==='PENDING_JOIN_EXISTS')return '이미 차량 승인을 기다리고 있음. 위에서 대기 상태를 확인하거나 취소해 주세요.';
  if (['PAIRING_EXPIRED', 'PAIRING_USED', 'ROOM_NOT_FOUND'].includes(code)) return '참가 코드를 사용할 수 없음. 차량에서 새 코드를 받아 주세요.';
  if (code === 'ROOM_FULL') return '방이 가득 참. 최대 차량 1대 + 동승자 3명까지 참가할 수 있음.';
  return errors[code] || '처리하지 못함 · ' + (/^[A-Z0-9_]+$/.test(code) ? code : '연결 상태를 확인해 주세요');
}
function connect() {
  if (!credentials) return;
  const current = ++generation; clearTimeout(retryTimer); memberId = null;
  status(retry ? '재연결 중…' : '방 연결 중…');
  socket = new WebSocket(apiOrigin.replace(/^http/,'ws') + '/ws');
  socket.onopen = () => { if (current === generation && credentials) socket.send(JSON.stringify({ type: 'auth', token: credentials.token, roomId: credentials.roomId })); };
  socket.onmessage = event => {
    if (current !== generation) return;
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'auth.ok') { memberId = message.memberId; retry = 0; status('같은 방에 연결됨', 'live'); render(); }
    else if (message.type === 'snapshot') {
      if (room && message.room.roomId === room.roomId && message.room.stateVersion < room.stateVersion) return;
      room = message.room; receivedAt = Date.now(); render();
    } else if (message.type === 'result') {
      if (!message.commandId) { result(describe(message.error?.code || 'UNKNOWN_ERROR')); return; }
      if (message.commandId !== pending?.commandId) return;
      clearTimeout(pending.timer); const action = pending.action; pending = null;
      if (!message.ok) result(describe(message.error?.code || 'UNKNOWN_ERROR'));
      else if (action === 'fire') result(message.data?.hit ? '명중! 피해 ' + message.data.damage : '빗나감. 각도를 다시 맞춰 주세요.');
      else result('보급 수집 완료 · 공동 보급품 +1');
      renderControls();
    } else if (message.type === 'error') {
      result(describe(message.error?.code || 'UNKNOWN_ERROR'));
      if (['AUTH_EXPIRED', 'AUTH_REQUIRED', 'ROOM_NOT_FOUND', 'NOT_A_MEMBER'].includes(message.error?.code)) { reset(); showLogin('인증이 끝남. 새 코드로 다시 참가해 주세요.'); }
    }
  };
  socket.onerror = () => { if (current === generation) status('연결 상태 확인 중…', 'error'); };
  socket.onclose = event => {
    if (current !== generation) return;
    memberId = null;
    if (pending) { clearTimeout(pending.timer); pending = null; result('연결이 끊김. 처리 결과는 재연결 후 보급품·좀비 HP로 확인해 주세요.'); }
    if ([4401, 4403, 4409, 4410, 4412, 4413].includes(event.code)) { reset(); showLogin(event.code === 4412 ? '다른 화면에서 파티를 연결했음. 이 화면으로 돌아오려면 현재 파티 화면 연결을 눌러 주세요.' : event.code === 4413 ? '계정에서 로그아웃했음.' : event.code === 4410 ? '파티 상태가 바뀜. 계정 상태를 확인하거나 새 QR로 참가해 주세요.' : event.code === 4409 ? '다른 화면으로 연결이 옮겨짐. 한 참가자는 한 화면에서 접속해 주세요.' : '세션을 확인할 수 없음. 다시 참가해 주세요.'); if(event.code!==4413)window.PHONE_ACCOUNT?.sync(); return; }
    status('연결 끊김 · 자동 재연결 대기', 'error'); renderControls();
    if (credentials) retryTimer = setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++) + Math.random() * 300);
  };
}
let inviteToken = null;
function readInviteFragment() {
  if (window.PHONE_ACCOUNT) return;
  const incoming = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (!incoming) return;
  inviteToken = incoming;
  history.replaceState(null,'',location.pathname);
  $('join-code').required = false; $('join-code').closest('label').hidden = true;
  $('access-key').closest('label').hidden = true;
  $('invite-notice').hidden = false;
  $('join-description').textContent = '차량 QR로 연결됩니다. 닉네임과 좌석을 선택해 참가 요청을 보내 주세요.';
  if (credentials) result('새 QR을 받았음. 현재 파티에서 탈퇴한 뒤 새 파티에 참가해 주세요.');
}
readInviteFragment();
window.addEventListener('hashchange', readInviteFragment);
function showLogin(message = '') { $('login-panel').hidden = false; $('game').hidden = true; $('form-error').textContent = message; $('join-button').disabled = false; status('방에 참가해 주세요'); }
function useTicket(joined) {
  reset(); credentials = {token:joined.token,roomId:joined.roomId}; room=joined.room; receivedAt=Date.now();
  const me=room?.members?.find(m=>m.memberId===joined.memberId); if(me?.seat)$('seat').value=me.seat;
  $('login-panel').hidden=true; $('game').hidden=false;
  $('angle').value={REAR_LEFT:-100,REAR_RIGHT:140,FRONT_PASSENGER:60}[$('seat').value];
  result(joined.pending ? '차량에서 참가자 승인 후 시작할 수 있음.' : '현재 파티에 연결 중…'); render(); connect();
}
window.addEventListener('phone:ticket',event=>useTicket(event.detail));
window.addEventListener('phone:reset',()=>{reset();showLogin();});
$('join-form').addEventListener('submit', async event => {
  event.preventDefault(); if (joining) return; joining = true;
  $('join-button').disabled = true; $('form-error').textContent = ''; status('참가 요청 중…');
  try {
    let session, joined;
    if (window.PHONE_ACCOUNT?.isAccountMode()) {
      joined=await window.PHONE_ACCOUNT.join($('seat').value,$('passenger-confirm').checked); session=joined;
    } else if (inviteToken) {
      joined = await post('/api/invites/redeem', {inviteToken,nickname:$('nickname').value.trim(),seat:$('seat').value,passengerConfirmed:$('passenger-confirm').checked}); session = joined;
    } else {
      session = await post('/api/session', { role: 'PHONE', nickname: $('nickname').value.trim(), accessKey: $('access-key').value });
      joined = await post('/api/join', { joinCode: $('join-code').value.trim().toUpperCase(), seat: $('seat').value }, session.token);
    }
    $('access-key').value = '';
    $('join-code').value = ''; useTicket({...joined,token:session.token});
  } catch (error) { showLogin(describe(error)); window.PHONE_ACCOUNT?.sync(); }
  finally { joining = false; $('join-button').disabled = false; }
});
$('leave-button').addEventListener('click', async () => {
  if (!credentials) return;
  $('leave-button').disabled = true;
  try { if(window.PHONE_ACCOUNT?.isAccountMode()&&window.PHONE_ACCOUNT.hasSession())await window.PHONE_ACCOUNT.leave(room?.members?.find(m=>m.seat===$('seat').value)?.approved!==true);else await post('/api/rooms/'+credentials.roomId+'/party/leave',{},credentials.token);reset();showLogin('현재 참가를 종료했음. 다시 참가하려면 차량의 새 QR을 사용해 주세요.');result(''); }
  catch(error) { result(describe(error)); }
  finally { $('leave-button').disabled=false; }
});
$('angle').addEventListener('input', () => { renderControls(); drawRadar(); });
$('fire-button').addEventListener('click', () => command('fire', { angleDeg: Number($('angle').value) }));
function command(action, fields = {}) {
  if (!online() || pending || !ownMember()?.approved) return;
  if (action === 'fire' && (room.state !== 'PLAYING' || !gateOpen() || !inside(Number($('angle').value), ownMember().sector))) return;
  const commandId = id(); pending = { commandId, action, timer: setTimeout(() => { if (pending?.commandId !== commandId) return; pending = null; result('응답 확인이 늦어짐. 현재 보급품·HP를 확인한 뒤 다시 시도해 주세요.'); renderControls(); }, 10000) };
  socket.send(JSON.stringify({ type: 'command', commandId, roomEpoch: room.roomEpoch, action, ...fields }));
  result('처리 중…'); renderControls();
}
function render() {
  if (!room) return;
  const me = ownMember() || room.members?.find(member => member.seat === $('seat').value);
  $('my-name').textContent = me?.nickname || $('nickname').value;
  $('my-seat').textContent = seats[me?.seat] || '자리 확인 중';
  const approved = me?.approved === true;
  $('leave-button').textContent=approved?'파티 탈퇴':'참가 요청 취소';
  $('pending-panel').hidden = approved; $('approved-content').hidden = !approved;
  if (!approved) return;
  $('places-refresh').disabled=!room.navigation?.available||!room.navigation.position;
  $('battle-state').textContent = states[room.state] || room.state;
  $('battle-reason').textContent = room.pauseReason ? room.pauseReason.split(',').map(reason => gateNames[reason] || reason).join(' · ') : room.state === 'PLAYING' ? '차량 주차 조건 유지 중' : '차량에서 시작 / 재개';
  $('supplies').textContent = room.collection?.inventory?.supplies ?? 0;
  const support = room.stats.supportUntil > Date.now(); $('support-state').textContent = support ? '차량 지원 · 사격 피해 ×' + room.stats.supportDamage : '차량에서 보급품으로 지원 가능';
  $('sector-label').textContent = me.sector ? me.sector[0] + '° ~ ' + me.sector[1] + '°' : '자리 확인 중';
  $('targets').replaceChildren(...(room.zombies || []).map(zombie => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'target' + (inside(zombie.angleDeg, me.sector) ? '' : ' outside') + (zombie.hp <= 0 ? ' dead' : '');
    const angle = document.createElement('strong'); angle.textContent = zombie.angleDeg + '°';
    button.append(angle, document.createTextNode(zombie.hp <= 0 ? '처치 완료' : 'HP ' + zombie.hp + ' / ' + zombie.maxHp));
    button.addEventListener('click', () => { $('angle').value = zombie.angleDeg; renderControls(); drawRadar(); }); return button;
  }));
  $('pickups').replaceChildren(...(room.collection?.fixtures || []).map(pickup => {
    const collected = room.collection.collectedPickupIds.includes(pickup.pickupId), button = document.createElement('button');
    button.type = 'button'; button.className = 'pickup'; button.dataset.collected = String(collected);
    const title = document.createElement('b'); title.textContent = pickup.title; const label = document.createElement('span'); label.textContent = collected ? '수집 완료 ✓' : '보급품 +' + pickup.amount;
    button.append(title, label); button.addEventListener('click', () => command('mobile.collect', { pickupId: pickup.pickupId, passengerConfirmed: $('passenger-confirm').checked })); return button;
  }));
  $('participant-count').textContent = room.members.filter(member => member.connected).length + ' / ' + room.members.length + ' 연결';
  $('members').replaceChildren(...room.members.map(member => { const li = document.createElement('li'); const label = document.createElement('b'); label.textContent = member.nickname + (member.memberId === memberId ? ' (나)' : ''); const detail = document.createElement('span'); detail.textContent = (seats[member.seat] || member.seat) + ' · ' + (member.connected ? '접속' : '오프라인'); li.append(label, detail); return li; }));
  $('room-meta').textContent = room.roomId + ' · 전투 #' + room.roomEpoch + ' · 서버 상태 v' + room.stateVersion;
  const nav=room.navigation;
  $('navigation-summary').textContent=nav?.available?`${nav.destination||'목적지 미설정'} · ${nav.status} · SDK 경로 #${nav.nativeRouteRevision} · 서버 #${nav.revision}${nav.error?' · '+nav.error:''}`:'차량 내비 신호 대기/만료';
  $('navigation-progress').textContent=nav?.available?`남은 거리 ${nav.remainingDistanceM??'—'}m · 시간 ${nav.remainingTimeSec??'—'}초 · ${nav.position?'차량 위치 갱신됨 ('+nav.positionSource+')':'차량 위치 확인 중'} · 도로 경로 형상 미제공`:'';
  renderControls(); drawRadar();
}

$('places-refresh').addEventListener('click',async()=>{
 const active=credentials,position=room?.navigation?.position;
 if(!active||!ownMember()?.approved||!room.navigation.available||!position||Date.now()-receivedAt>10000){$('places-status').textContent='승인된 파티와 최신 차량 위치가 필요함';return;}
 $('places-refresh').disabled=true;$('places-status').textContent='장소 조회 중…';
 try{
  const response=await fetch(apiOrigin+'/api/places/nearby',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+active.token},body:JSON.stringify({...position,radiusM:10000,limit:50,eligibleOnly:false,...($('place-category').value?{category:$('place-category').value}:{})})});
  if(!response.ok)throw new Error('HTTP '+response.status);const value=await response.json();
  if(credentials!==active||!ownMember()?.approved)return;
  $('places-status').textContent=value.version+' · 전체 '+value.count+'건 중 주변 '+value.places.length+'건'+(value.truncated?' (가까운 50건)':'');
  $('place-list').replaceChildren(...value.places.map(p=>{const li=document.createElement('li'),name=document.createElement('strong'),detail=document.createElement('p');name.textContent=p.name;detail.textContent=p.category+' · '+p.distanceM+'m · '+(p.isDemo?'가상 시연 장소':p.drivingAssessment?.networkRoundTrip?'도로망 진입·복귀 근거 있음 / 현장 미검증':'도로망 근거 미확인')+' · '+(p.enabled?'게임 활성':'게임 비활성');li.append(name,detail);return li;}));
 }catch{$('places-status').textContent='장소 조회 실패 · 연결 상태를 확인해 주세요';}finally{if(credentials===active)$('places-refresh').disabled=false;}
});
function renderControls() {
  const me = ownMember(), angle = Number($('angle').value), allowedAngle = inside(angle, me?.sector);
  $('angle-value').textContent = angle + '°';
  const allowed = online() && me?.approved === true && !pending;
  $('fire-button').disabled = !allowed || room?.state !== 'PLAYING' || !gateOpen() || !allowedAngle;
  $('aim-message').textContent = !online() ? '연결을 기다리는 중' : !allowedAngle ? '이 각도는 다른 자리의 방어 구역임.' : room?.state !== 'PLAYING' || !gateOpen() ? '수집은 가능함. 전투는 주차 후 차량에서 시작해 주세요.' : '내 구역 조준 중 · 사격 가능';
  for (const button of $('pickups').children) button.disabled = !allowed || button.dataset.collected === 'true';
}
function drawRadar() {
  const canvas = $('radar'), ctx = canvas.getContext('2d'); if (!ctx || !room) return;
  const size = canvas.width, c = size / 2, radius = size * .39, sector = ownMember()?.sector;
  const rad = angle => (angle - 90) * Math.PI / 180;
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = '#254253'; ctx.lineWidth = 1;
  for (const ratio of [.35, .65, 1]) { ctx.beginPath(); ctx.arc(c, c, radius * ratio, 0, Math.PI * 2); ctx.stroke(); }
  for (const angle of [0, 90]) { ctx.beginPath(); ctx.moveTo(c + Math.cos(rad(angle)) * radius, c + Math.sin(rad(angle)) * radius); ctx.lineTo(c - Math.cos(rad(angle)) * radius, c - Math.sin(rad(angle)) * radius); ctx.stroke(); }
  if (sector) { ctx.beginPath(); ctx.moveTo(c, c); ctx.arc(c, c, radius, rad(sector[0]), rad(sector[1])); ctx.closePath(); ctx.fillStyle = '#52f1d020'; ctx.fill(); ctx.strokeStyle = '#52f1d080'; ctx.stroke(); }
  const aim = rad(Number($('angle').value)); ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + Math.cos(aim) * radius, c + Math.sin(aim) * radius); ctx.strokeStyle = '#dcf9ef'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#1c4351'; ctx.strokeStyle = '#7ce0d3'; ctx.lineWidth = 2; ctx.fillRect(c - 17, c - 30, 34, 60); ctx.strokeRect(c - 17, c - 30, 34, 60);
  ctx.fillStyle = '#a0b9c8'; ctx.font = '19px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('FRONT', c, 40);
  for (const zombie of room.zombies || []) {
    const angle = rad(zombie.angleDeg), x = c + Math.cos(angle) * radius * .83, y = c + Math.sin(angle) * radius * .83;
    ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.fillStyle = zombie.hp <= 0 ? '#37515c' : inside(zombie.angleDeg, sector) ? '#ffbd80' : '#997762'; ctx.fill();
    ctx.fillStyle = '#e2eff6'; ctx.font = '18px sans-serif'; ctx.fillText(zombie.hp <= 0 ? '✓' : zombie.hp + ' HP', x, y + 36);
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && credentials && (!socket || socket.readyState > WebSocket.OPEN)) { clearTimeout(retryTimer); connect(); } });
window.addEventListener('online', () => { if (credentials && (!socket || socket.readyState > WebSocket.OPEN)) connect(); });
window.addEventListener('pageshow', () => { if (credentials && (!socket || socket.readyState > WebSocket.OPEN)) connect(); });
window.addEventListener('pagehide', () => { if (socket) socket.close(); });
setInterval(() => { if (room) renderControls(); }, 1000);
