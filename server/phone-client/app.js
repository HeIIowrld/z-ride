'use strict';
const $ = id => document.getElementById(id);
const apiOrigin=window.ZRIDE_CONFIG?.apiOrigin||location.origin;
const assets = new URL('.', document.currentScript.src);
const driveAssets = new URL('drive/', assets);
const coopGames = {
  thief: { title: '전기도둑', objective: '목표 합계에 맞춰 충전하고 도둑을 찾아라.' },
  relay: { title: '충전 릴레이', objective: '그림과 답을 넘겨 처음 단어를 맞혀라.' },
  deadzone: { title: 'DEADZONE', objective: '각자 맡은 방향에서 차량을 지켜라.' },
};
const venuePhases = {
  LOBBY: '대기실', BRIEFING: '역할 확인', CHARGING: '충전 중', CASE: '카드 선택',
  RESULT: '사건 결과', TALK: '토론', VOTE: '투표', VERDICT: '투표 결과',
  PLAY: '릴레이 진행', REVEAL: '스케치북 공개', ROUND_END: '라운드 종료', END: '경기 결과',
};

function setGameArt(element, game) {
  const art = element.querySelector('.game-art-image');
  if (!game) {
    art?.remove();
    return;
  }
  const source = new URL(game + '.webp', assets).href;
  if (art?.src === source) return;
  const image = document.createElement('img');
  image.className = 'game-art-image';
  image.alt = '';
  image.src = source;
  if (art) art.replaceWith(image);
  else element.prepend(image);
}
const seats = { FRONT_PASSENGER: '앞 동승석 · 전방 사수', REAR_LEFT: '뒤 왼쪽 · 좌측 방어', REAR_RIGHT: '뒤 오른쪽 · 우측 방어', DRIVER: '운전자 · 지원 담당' };
const states = { LOBBY: '시작 대기', READY: '시작 준비', PLAYING: '전투 진행', PAUSED: '전투 중지', CLEARED: '거점 공략 완료', PENDING: '승인 대기' };
const gateNames = { CAR_DISCONNECTED: '차량 연결 끊김', APP_INACTIVE: '차량 앱 비활성', LEASE_EXPIRED: '차량 보고 만료', UX_RESTRICTED: '주행 중 전투 제한', UX_UNKNOWN: '차량 UX 확인 중', GEAR_NOT_P: '주차 후 전투 가능', GEAR_UNKNOWN: '차량 기어 확인 중', MEMBER_PENDING: '차량 승인 대기' };
const errors = { TEST_ACCESS_REQUIRED: '테스트 접근키를 확인해 주세요. 관찰키와는 다른 키임.', MEMBER_PENDING: '차량에서 참가자를 먼저 승인해 주세요.', AUTH_EXPIRED: '세션이 만료됨. 새 참가 코드로 다시 참가해 주세요.', INVALID_JOIN_CODE: '참가 코드가 잘못됐거나 만료됨. 차량에서 새 코드를 받아 주세요.', JOIN_CODE_EXPIRED: '참가 코드가 만료됨. 차량에서 새 코드를 받아 주세요.', GATE_CLOSED: '차량 전투 조건이 닫힘. 주차 후 차량에서 다시 시작해 주세요.', NOT_PLAYING: '차량에서 공동 전투를 시작해야 사격할 수 있음.', ALREADY_COLLECTED: '파티에서 획득한 상자임. 리스폰 후 다시 수집 가능.', SEAT_EMPTY: '차량에서 이 자리가 비어 있다고 보고됨.', STALE_EPOCH: '전투 상태가 바뀜. 최신 화면에서 다시 시도해 주세요.', SEAT_TAKEN: '이미 사용 중인 자리임. 다른 자리를 선택해 주세요.', INVITE_EXPIRED: 'QR이 만료됐거나 다 쓰였음. 차량 화면의 새 QR을 다시 찍어 주세요.' };
let credentials = null, room = null, socket = null, memberId = null, generation = 0, retry = 0, retryTimer = null, pending = null, receivedAt = 0, joining = false;
let counter = 0;
let waitingForApprovedTicket = false;
const id = () => 'web-' + Date.now().toString(36) + '-' + (++counter).toString(36) + '-' + Math.random().toString(36).slice(2, 12);
function status(message, kind = '') { $('connection').textContent = message; $('connection').className = 'connection ' + kind; }
function result(message) { $('action-result').textContent = message; }
function ownMember() { return room?.members?.find(member => member.memberId === memberId); }
function inside(angle, sector) { return !!sector && ((Math.abs(angle) === 180 && ownMember()?.seat?.startsWith('REAR_')) || (angle >= sector[0] && angle <= sector[1])); }
function online() { return socket?.readyState === WebSocket.OPEN && !!credentials && !!memberId; }
function gateOpen() { return room?.vehicle?.playAllowed === true && room.vehicle.reportAgeMs != null && room.vehicle.reportAgeMs + Date.now() - receivedAt <= 6000; }
function reset(clear = true) {
  closeDriveGame();
  generation++; clearTimeout(retryTimer); clearTimeout(pending?.timer); pending = null;
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
  if (clear) { credentials = null; room = null; memberId = null; forgetSession(); }
}
// 새로고침·탭 재로딩(아이폰 Safari가 자주 함)이나 QR을 다시 찍어 새 탭이 열려도 같은 자리로 다시 붙도록 세션을 기억한다.
// 카메라가 여는 새 탭은 sessionStorage를 이어받지 못해 대원이 하나 더 생기므로 localStorage를 쓴다.
// URL·로그에는 남지 않고, 탈퇴·해산·인증 만료 때 지운다(서버 세션도 8시간 뒤 만료).
const SESSION_KEY = 'zride.phone.session';
function saveSession() { try { localStorage.setItem(SESSION_KEY, JSON.stringify(credentials)); } catch {} }
function forgetSession() { try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); } catch {} }
function savedSession() { try { const v = JSON.parse(localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY) || 'null'); return v && typeof v.token === 'string' && typeof v.roomId === 'string' ? v : null; } catch { return null; } }
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
  // 아이폰 Safari는 연결이 열리지도 실패하지도 않은 채 멈출 때가 있다 → 8초 안에 auth.ok가 없으면 버리고 다시 연결한다
  setTimeout(() => {
    if (current !== generation || memberId || !socket) return;
    const stuck = socket; stuck.onopen = stuck.onmessage = stuck.onerror = stuck.onclose = null; try { stuck.close(); } catch {} socket = null;
    status('연결이 늦어 다시 시도 중…', 'error'); renderControls();
    retryTimer = setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++) + Math.random() * 300);
  }, 8000);
  socket.onopen =() => { if (current === generation && credentials) socket.send(JSON.stringify({ type: 'auth', token: credentials.token, roomId: credentials.roomId })); };
  socket.onmessage = event => {
    if (current !== generation) return;
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'auth.ok') {
      memberId = message.memberId;
      retry = 0;
      status('같은 방에 연결됨', 'live');
      if (['현재 파티에 연결 중…', '다시 연결하는 중…'].includes($('action-result').textContent)) result('');
      render();
    }
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
      if (['AUTH_EXPIRED', 'AUTH_REQUIRED', 'ROOM_NOT_FOUND', 'NOT_A_MEMBER', 'NOT_MEMBER', 'PARTY_CLOSED'].includes(message.error?.code)) { reset(); showLogin(inviteToken ? '이전 파티는 끝났음. 새 QR로 참가해 주세요.' : '인증이 끝남. 새 코드로 다시 참가해 주세요.'); }
    }
  };
  socket.onerror = () => { if (current === generation) status('연결 상태 확인 중…', 'error'); };
  socket.onclose = event => {
    if (current !== generation) return;
    memberId = null;
    closeDriveGame();
    if (pending) { clearTimeout(pending.timer); pending = null; result('연결이 끊김. 처리 결과는 재연결 후 보급품·좀비 HP로 확인해 주세요.'); }
    if ([4401, 4403, 4409, 4410, 4412, 4413].includes(event.code)) {
      const keepLegacySession = event.code === 4409 && !window.PHONE_ACCOUNT?.isAccountMode();
      reset(!keepLegacySession);
      if (keepLegacySession) { credentials = null; room = null; }
      showLogin(event.code === 4412 ? '다른 화면에서 파티를 연결했음. 이 화면으로 돌아오려면 현재 파티 화면 연결을 눌러 주세요.' : event.code === 4413 ? '계정에서 로그아웃했음.' : event.code === 4410 ? '파티 상태가 바뀜. 계정 상태를 확인하거나 새 QR로 참가해 주세요.' : event.code === 4409 ? '다른 화면으로 연결이 옮겨짐. 한 참가자는 한 화면에서 접속해 주세요.' : '세션을 확인할 수 없음. 다시 참가해 주세요.');
      if (event.code !== 4413) window.PHONE_ACCOUNT?.sync();
      return;
    }
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
  $('legacy-fields').hidden = false;
  $('crew-positions').hidden = false;
  $('join-description').textContent = '차량 QR로 연결됩니다. 닉네임과 좌석을 선택해 참가 요청을 보내 주세요.';
  if (credentials) result('이미 참가한 자리로 다시 연결함. 다른 파티에 들어가려면 먼저 탈퇴해 주세요.');
}
const restored = savedSession();
if (restored) { credentials = restored; $('login-panel').hidden = true; $('game').hidden = false; result('다시 연결하는 중…'); connect(); }
readInviteFragment();
window.addEventListener('hashchange', readInviteFragment);
function showLogin(message = '') { $('login-panel').before($('account-panel')); $('login-panel').hidden = false; $('game').hidden = true; $('form-error').textContent = message; $('join-button').disabled = false; status('방에 참가해 주세요'); }
function useTicket(joined) {
  reset(); credentials = {token:joined.token,roomId:joined.roomId}; room=joined.room; receivedAt=Date.now();
  const accountMode = window.PHONE_ACCOUNT?.isAccountMode();
  if (!accountMode) saveSession();
  waitingForApprovedTicket = Boolean(joined.pending && accountMode);
  nearbySpots = [];
  lastMapFetch = null;
  venueStatus = null;
  venueSignature = '';
  selectedSpot = null;
  mapSignature = '';
  mapAnchor = null;
  routeFeedback = '';
  activeRouteChallenge = null;
  routeRequestPending = false;
  routeButtons.replaceChildren();
  routeMessage.textContent = '';
  routeConfirmation.checked = false;
  showJourney('map');
  const me=room?.members?.find(m=>m.memberId===joined.memberId); if(me?.seat)$('seat').value=me.seat;
  $('login-panel').hidden=true; $('game').hidden=false;
  $('angle').value={REAR_LEFT:-100,REAR_RIGHT:140,FRONT_PASSENGER:60}[$('seat').value];
  result(joined.pending ? '차량에서 참가자 승인 후 시작할 수 있음.' : '현재 파티에 연결 중…'); render(); connect();
}
window.addEventListener('phone:ticket',event=>useTicket(event.detail));
window.addEventListener('phone:reset',()=>{reset();showLogin();});
$('join-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (joining) return;
  if (!$('seat').value) {
    $('form-error').textContent = '앉은 자리를 먼저 골라 주세요.';
    $('crew-positions').querySelector('[data-seat]:not(:disabled)')?.focus();
    return;
  }
  joining = true;
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
const deadzoneLink = document.createElement('a');
deadzoneLink.textContent = 'DEADZONE 협동 게임 열기';
deadzoneLink.target = '_blank';
deadzoneLink.rel = 'noopener noreferrer';
deadzoneLink.hidden = true;
$('journey-place').append(deadzoneLink);

const routeGame = document.createElement('section');
routeGame.className = 'panel ply-game-panel';
routeGame.hidden = true;
let activeRouteChallenge;
let routeRequestPending = false;
const routeStart = document.createElement('button');
routeStart.textContent = '도전 시작';
const routeTitle = document.createElement('h2');
routeTitle.className = 'item-inline';
routeTitle.append(document.createElement('ply-supply-icon'), '경로 보급품');
const routeMessage = document.createElement('p');
routeMessage.className = 'route-prompt';
routeMessage.setAttribute('role', 'status');
const routeSpeed = document.createElement('p');
const routeButtons = document.createElement('div');
routeButtons.className = 'journey-digits';
routeStart.className = 'primary';
const routeConfirmation = document.createElement('input');
routeConfirmation.type = 'checkbox';
const routePassenger = document.createElement('label');
routePassenger.className = 'check';
routePassenger.append(routeConfirmation, document.createTextNode('동승자입니다'));
routeGame.append(routeTitle, routeSpeed, routePassenger, routeStart, routeMessage, routeButtons);
$('journey-game').append(routeGame);

routeStart.onclick = async () => {
  const active = credentials;
  if (!active || !routeConfirmation.checked) {
    routeMessage.textContent = '동승자 확인을 먼저 선택해 주세요.';
    return;
  }
  routeStart.disabled = true;
  routeRequestPending = true;
  routeButtons.replaceChildren();
  try {
    const challenge = await post('/api/world/route-supply', {
      passengerConfirmed: true, placeId: selectedSpot?.activity === 'supply' ? selectedSpot.placeId : room?.routeSupplySpot?.placeId,
    }, active.token);
    if (active !== credentials || room?.vehicle?.gear !== 'D') return;
    activeRouteChallenge = challenge;
    routeMessage.textContent = '순서를 기억하세요 · ' + [...challenge.sequence].join(' ');
    routeMessage.dataset.stage = 'memorize';
    let sequence = '';
    setTimeout(() => {
      if (active !== credentials || activeRouteChallenge !== challenge) return;
      routeMessage.textContent = '숫자를 순서대로 누르세요.';
      routeMessage.dataset.stage = 'input';
      for (const digit of ['1', '2', '3']) {
        const button = document.createElement('button');
        button.textContent = digit;
        button.onclick = async () => {
          if (active !== credentials || activeRouteChallenge !== challenge) return;
          sequence += digit;
          routeMessage.textContent = '입력 ' + sequence.length + ' / ' + challenge.sequence.length;
          if (sequence.length !== challenge.sequence.length) return;
          routeButtons.replaceChildren();
          try {
            const receipt = await post('/api/world/route-supply', {
              passengerConfirmed: true, challengeId: challenge.challengeId, sequence
            }, active.token);
            if (active !== credentials) return;
            routeFeedback = receipt.outcome === 'MISSED'
              ? '이번 스팟은 놓쳤어요. 다음 스팟에서 도전하세요.'
              : '보급품 +1 · 파티 보급품 ' + receipt.supplies + '개';
          } catch {
            if (active === credentials) routeFeedback = '이번 도전이 종료됐어요. 다음 스팟에서 도전하세요.';
          } finally {
            if (active === credentials) {
              activeRouteChallenge = null;
              showJourney('map');
            }
          }
        };
        routeButtons.append(button);
      }
      setTimeout(() => {
        if (active !== credentials || activeRouteChallenge !== challenge || sequence.length === challenge.sequence.length) return;
        activeRouteChallenge = null;
        routeButtons.replaceChildren();
        routeFeedback = '시간이 끝났어요. 다음 스팟에서 도전하세요.';
        showJourney('map');
      }, 27000);
    }, 1500);
  } catch {
    if (active === credentials) routeMessage.textContent = '현재 경로에 수집할 수 있는 보급품이 없습니다.';
  } finally {
    if (active === credentials) {
      routeRequestPending = false;
      routeStart.disabled = Boolean(activeRouteChallenge) || !room?.routeSupplyAvailable;
    }
  }
};

const venuePanel = document.createElement('section');
venuePanel.id = 'journey-venue';
venuePanel.className = 'panel ply-game-panel';
venuePanel.hidden = true;
$('journey-game').append(venuePanel);
let venuePoll = null, venueSubmitting = false, venueSignature = '';
let venueStatus = null;
async function venueAction(action = 'status', fields = {}) {
  const active = credentials;
  if (!active || !ownMember()?.approved || venueSubmitting) return;
  if (action === 'status') {
    if (venuePoll) return;
    venuePoll = post('/api/rooms/' + active.roomId + '/venue-game', { action }, active.token);
    try {
      const value = await venuePoll;
      if (active === credentials) showVenue(value);
    } catch {} finally { venuePoll = null; }
    return;
  }
  venueSubmitting = true;
  try {
    if (venuePoll) await venuePoll.catch(() => {});
    if (active !== credentials) return;
    const value = await post('/api/rooms/' + active.roomId + '/venue-game', { action, ...fields }, active.token);
    if (active === credentials) showVenue(value);
  } catch (error) {
    if (active === credentials) result(describe(error.message));
  } finally { venueSubmitting = false; }
}
function venueButton(label, action, fields) {
  const button = document.createElement('button');
  button.textContent = label;
  button.onclick = () => venueAction(action, typeof fields === 'function' ? fields() : fields);
  venuePanel.append(button);
}
function sketch(existing) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 240;
  canvas.style.cssText = 'display:block;width:min(240px,100%);background:white;touch-action:none';
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 3;
  const strokes = [];
  let stroke = null;
  function draw(points) {
    ctx.beginPath();
    for(let i=0;i<points.length;i+=2) {
      const x=points[i]*.24,y=points[i+1]*.24;
      if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
    }
    ctx.stroke();
  }
  for(const item of existing?.strokes ?? []) draw(item.p);
  if (!existing) {
    const add = event => {
      const r = canvas.getBoundingClientRect();
      if (stroke.p.length >= 128) return;
      const scale = (n, start, size) => Math.max(0, Math.min(1000, Math.round((n-start)/size*1000)));
      stroke.p.push(scale(event.clientX,r.left,r.width),scale(event.clientY,r.top,r.height));
      draw(stroke.p);
    };
    canvas.onpointerdown = event => {
      if(strokes.length >= 8)return;
      canvas.setPointerCapture(event.pointerId);
      stroke={c:0,w:1,p:[]};strokes.push(stroke);add(event);
    };
    canvas.onpointermove = event => { if(stroke)add(event); };
    canvas.onpointerup = canvas.onpointercancel = () => { stroke=null; };
  }
  venuePanel.append(canvas);
  return {strokes};
}
const lobbySeats = [
  ['FRONT_PASSENGER', '조수석'],
  ['REAR_LEFT', '뒷좌석 왼쪽'],
  ['REAR_RIGHT', '뒷좌석 오른쪽'],
];

function updateVenueRoster(roster, state) {
  const players = new Map(state.players.map(player => [player.id, player]));
  roster.replaceChildren(...lobbySeats.map(([seatId, label]) => {
    const member = room.members.find(member => member.seat === seatId);
    const player = players.get(member?.memberId);
    const connected = member?.connected && member.approved && member.seatEvidence !== 'EMPTY';
    const row = document.createElement('li');
    row.classList.toggle('own-seat', player?.id === state.me);
    const seat = document.createElement('small');
    seat.textContent = label;
    const name = document.createElement('strong');
    name.textContent = player ? player.name + (player.id === state.me ? ' (나)' : '') : '—';
    const status = document.createElement('span');
    status.dataset.state = !player || !connected ? 'waiting' : player.done ? 'ready' : 'online';
    status.textContent = !player ? '빈 자리' : !connected ? '연결 대기' : player.done ? '준비 완료' : '접속';
    row.append(seat, name, status);
    return row;
  }));
}

function showVenue(value) {
  venueStatus = value;
  renderJourneyMap();
  const state = value.game;
  const lobby = ['LOBBY', 'BRIEFING'].includes(state?.phase);
  const key = JSON.stringify([value.kind,state?.phase,state?.caseNo,state?.round,state?.step,
    state?.submitted,state?.players?.find(p=>p.id===state?.me)?.done,state?.reveal?.book,
    state?.reveal?.shown,state?.result?.saved,value.paused,value.stop?.placeId]);
  venuePanel.hidden = !state && !value.paused && !value.stop;
  venuePanel.dataset.game = value.kind || '';
  venuePanel.classList.toggle('venue-lobby', lobby);
  const supplyText = '파티 보급품 ' + value.supplies + '개';
  if (key === venueSignature) {
    const count = venuePanel.querySelector('.venue-supply-count');
    if (count) count.textContent = supplyText;
    const roster = venuePanel.querySelector('.venue-roster');
    if (roster) updateVenueRoster(roster, state);
    return;
  }
  venueSignature = key;
  venuePanel.replaceChildren();
  if (venuePanel.hidden) return;
  const game = coopGames[value.kind];
  const title = document.createElement('h2');
  title.textContent = game?.title ?? (value.paused ? '충전 게임 일시정지' : '충전소 대기실');
  const header = document.createElement('header');
  header.className = 'venue-header';
  if (state) {
    const phase = document.createElement('p');
    phase.className = 'venue-phase';
    phase.textContent = venuePhases[state.phase] ?? '진행 중';
    header.append(phase);
  }
  header.append(title);
  if (lobby) {
    const objective = document.createElement('p');
    objective.className = 'venue-objective';
    objective.textContent = game.objective;
    header.append(objective);
    setGameArt(header, value.kind);
  }
  venuePanel.append(header);
  const info = document.createElement('p');
  info.className = 'game-status';
  info.setAttribute('role', 'status');
  if (!state) {
    venuePanel.append(info);
    info.textContent = value.paused ? '같은 충전소에서 다시 연결하면 이어져요.'
      : '차량 화면에서 게임을 선택하면 여기에 표시돼요.';
    return;
  }
  const supplyCount = document.createElement('p');
  supplyCount.className = 'item-inline';
  const count = document.createElement('span');
  count.className = 'venue-supply-count';
  count.textContent = supplyText;
  supplyCount.append(document.createElement('ply-supply-icon'), count);
  header.append(supplyCount);
  const me = state.players?.find(player => player.id === state.me);
  if (lobby) {
    const roster = document.createElement('ul');
    roster.className = 'venue-roster';
    roster.setAttribute('aria-label', '같은 파티 참가자');
    updateVenueRoster(roster, state);
    venuePanel.append(roster);
  }
  venuePanel.append(info);
  if (!me) {
    info.textContent = '차량에서 참가 좌석을 확인하세요.';
    return;
  }
  if (state.phase === 'LOBBY') {
    info.textContent = '차량에서 시작을 기다리는 중';
    return;
  }
  if(value.kind === 'thief'){
    if(state.phase==='BRIEFING'){
      info.textContent = state.solo ? '차량이 숨은 값을 더해요.' : '내 역할 ' + (state.role==='THIEF'?'도둑':'가족');
      if (me.done) info.textContent += ' · 다른 좌석 준비 중';
      else venueButton('준비 완료','ready');
    } else if (state.phase === 'CHARGING') {
      info.textContent = '충전 중 · 배터리 ' + state.nextAt + '%에서 다음 사건이 열려요.';
    } else if(state.phase==='CASE'&&!me.done){
      info.textContent = '목표 합계 ' + state.range.lo + '~' + state.range.hi;
      const watch = document.createElement('select');
      watch.setAttribute('aria-label','살펴볼 동승자');
      watch.append(new Option('살펴보지 않기',''));
      if(!state.solo){
        state.players.filter(p=>p.id!==state.me).forEach(p=>watch.append(new Option(p.name,p.id)));
        venuePanel.append(watch);
      }
      const prank = document.createElement('select');
      prank.setAttribute('aria-label','도둑의 방해');
      prank.append(new Option('방해 없음','NONE'));
      if(state.role==='THIEF'){
        prank.append(new Option('조명 방해','LIGHT'),new Option('바람 방해','WIND'));
        venuePanel.append(prank);
      }
      state.hand.forEach((card,index)=>venueButton('카드 '+(card>0?'+':'')+card,'play',
        ()=>({card:index,watch:watch.value||null,prank:prank.value})));
    } else if (state.phase === 'CASE' && me.done) {
      info.textContent = '카드 제출 · 다른 좌석 대기 중';
    } else if(state.phase==='RESULT'){
      const round=state.result;
      info.textContent = '합계 '+round.sum+' / 목표 '+round.lo+'~'+round.hi+' · '+
        (round.saved?'보급품으로 복구':{LOW:'정전',HIGH:'과부하',OK:'충전 성공'}[round.outcome]);
    } else if(state.phase==='VOTE'&&!me.done){
      state.players.filter(p=>p.id!==state.me).forEach(p=>venueButton(p.name+'에게 투표','vote',{suspect:p.id}));
      venueButton('기권','vote',{suspect:'SKIP'});
    } else if(state.phase==='END')info.textContent = ({FAMILY:'가족 승리',THIEF:'도둑 승리',CAR:'차량 승리'}[state.winner]);
    else if(state.clue)info.textContent = state.clue;
  }else if(state.phase==='PLAY'&&state.task&&!state.submitted){
    const task=state.task;
    if(task.kind==='DRAW'){
      info.textContent = '그릴 단어 ' + task.prompt;
      const drawing=sketch();
      venueButton('그림 제출','submit',()=>({step:task.step,drawing}));
    }else{
      sketch(task.drawing);
      const input=document.createElement('input');
      input.placeholder='그림의 정답';
      input.maxLength=30;
      venuePanel.append(input);
      venueButton('정답 제출','submit',()=>({step:task.step,text:input.value}));
    }
  } else if (state.phase === 'PLAY' && state.submitted) {
    info.textContent = '제출 완료 · 다른 동승자를 기다리는 중';
  } else if(state.reveal){
    info.textContent = '공개 단어 ' + state.reveal.word;
    for(const entry of state.reveal.entries){
      if(entry.drawing)sketch(entry.drawing);
      if(entry.text){const line=document.createElement('p');line.textContent=entry.text;venuePanel.append(line);}
    }
  }else if(state.phase==='END')info.textContent = '전달 성공 ' + state.family.success + ' / ' + state.family.total;
}
setInterval(() => {
  if (room?.vehicle?.playAllowed || journeyView === 'charge') void venueAction();
}, 1500);

let journeyView = 'map';
let selectedSpot = null;
let nearbySpots = [];
let lastMapFetch = null;
let mapSignature = '';
let mapAnchor = null;
let routeFeedback = '';
const spotTypes = { CHARGER: '충전소', PARKING: '주차장', FUEL_STATION: '주유소', ATTRACTION: '명소' };

function journeySpotName(spot) {
  if (spot.name && !spot.name.startsWith('이름 미등록')) return spot.name;
  return spotTypes[spot.category] ?? (spot.activity === 'supply' ? '경로 보급 지점' : '주변 장소');
}

function showJourney(view) {
  journeyView = view;
  $('journey-map').hidden = view !== 'map';
  $('journey-game').hidden = view === 'map';
  $('journey-game').dataset.view = view;
  $('journey-party').hidden = view !== 'map';
  $('journey-bag-view').hidden = view !== 'bag';
  if (view !== 'bag') $('journey-bag-view').replaceChildren();
  routeGame.hidden = view !== 'supply';
  if (view !== 'drive') closeDriveGame();
  if (view === 'map') {
    renderJourneyMap();
    void refreshJourneyMap();
  }
}
$('journey-back').onclick = () => {
  showJourney('map');
  $('journey-map').scrollIntoView({ block: 'start' });
};

$('journey-bag').onclick = () => {
  const frame = document.createElement('iframe');
  frame.title = '아이템 가방';
  frame.src = new URL('bag.html?journey=1', driveAssets).href;
  $('journey-bag-view').replaceChildren(frame);
  showJourney('bag');
  $('journey-game').scrollIntoView({ block: 'start' });
};

const driveTitles = {
  'license-quiz': '운전면허 퀴즈',
  'pole-jump': '폴짝 전봇대',
  raindrop: '빗방울 캐치',
};
const drivePanel = $('drive-games');
const drivePlay = $('drive-play');
let driveFrame = null;

function driveAvailable() {
  const vehicle = room?.vehicle;
  const me = ownMember();
  return room?.driveGamesAvailable === true && online() && !waitingForApprovedTicket && me?.approved
    && ['FRONT_PASSENGER', 'REAR_LEFT', 'REAR_RIGHT'].includes(me.seat) && me.seatEvidence !== 'EMPTY'
    && vehicle?.gear === 'D' && Number.isFinite(vehicle.speedMps)
    && Number.isFinite(vehicle.reportAgeMs) && vehicle.reportAgeMs + Date.now() - receivedAt <= 6000;
}

function closeDriveGame() {
  if (!driveFrame) return;
  driveFrame.remove();
  driveFrame = null;
  drivePlay.hidden = true;
  if (journeyView === 'drive') showJourney('map');
}

function sendDriveState() {
  if (!driveAvailable() || !driveFrame) return;
  driveFrame.contentWindow?.postMessage({
    type: 'zride:drive-state',
    speedKmh: room.vehicle.speedMps * 3.6,
    seat: ownMember().seat,
    speedLimitKmh: room.navigation?.available ? room.navigation.speedLimitKmh : null,
    nextTurn: room.navigation?.available && room.navigation.nextTurnDistanceM <= 250 ? room.navigation.nextTurn : null,
  }, location.origin);
}

function renderDriveGames() {
  const available = driveAvailable();
  drivePanel.hidden = !available;
  if (!available) {
    closeDriveGame();
    return;
  }
  const recommendation = driveTitles[room.driveGame];
  const note = $('drive-recommendation');
  note.hidden = !recommendation;
  const text = recommendation ? '차량에서 추천한 게임 · ' + recommendation : '';
  if (note.textContent !== text) note.textContent = text;
  for (const button of drivePanel.querySelectorAll('[data-drive-game]')) {
    button.classList.toggle('recommended', button.dataset.driveGame === room.driveGame);
  }
  sendDriveState();
}

drivePanel.addEventListener('click', event => {
  const game = event.target.closest('[data-drive-game]')?.dataset.driveGame;
  if (!Object.hasOwn(driveTitles, game) || !driveAvailable()) return;
  closeDriveGame();
  driveFrame = document.createElement('iframe');
  driveFrame.title = driveTitles[game];
  driveFrame.src = new URL('games/' + game + '/index.html', driveAssets).href;
  driveFrame.addEventListener('load', sendDriveState);
  drivePlay.replaceChildren(driveFrame);
  drivePlay.hidden = false;
  showJourney('drive');
  $('journey-game').scrollIntoView({ block: 'start' });
});
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== driveFrame?.contentWindow) return;
  if (event.data?.type === 'zride:drive-ready') sendDriveState();
  if (event.data?.type === 'zride:drive-back') closeDriveGame();
});
setInterval(renderDriveGames, 1000);

function selectJourneySpot(spot) {
  selectedSpot = spot;
  renderJourneyMap();
}

function enterJourneyActivity(spot) {
  if (spot.activity === 'deadzone') {
    if (room?.deadzoneJoinUrl) deadzoneLink.click();
    return;
  }
  if (spot.activity === 'supply') selectedSpot = spot;
  showJourney(spot.activity);
  if (spot.activity === 'charge') void venueAction();
  $('journey-game').scrollIntoView({ block: 'start' });
}

function journeyActivityCopy(activity) {
  if (activity === 'supply') return ['경로 보급품', '성공 보상 · 파티 보급품 +1', '도전 열기'];
  if (activity === 'deadzone') return ['정차 게임', coopGames.deadzone.objective, 'DEADZONE 입장'];
  const gameName = coopGames[venueStatus.kind]?.title;
  if (venueStatus.game?.phase === 'END') return ['충전소', gameName + '이 끝났어요.', '결과 보기'];
  return venueStatus.game
    ? ['충전소', coopGames[venueStatus.kind]?.objective ?? '', gameName + ' 입장']
    : ['충전소', '차량에서 게임 선택 대기 중', '대기실 열기'];
}

function renderJourneyMap() {
  if (journeyView !== 'map' || !ownMember()?.approved) return;
  renderJourneyGuidance(room.navigation);
  const position = room.navigation?.position;
  const offset = (spot, origin) => [
    (spot.longitude - origin.longitude) * 111000 * Math.cos(origin.latitude * Math.PI / 180),
    (spot.latitude - origin.latitude) * 111000,
  ];
  if (!position) mapAnchor = null;
  else if (!mapAnchor || Math.hypot(...offset(position, mapAnchor)) > 360) mapAnchor = position;
  const supply = room.routeSupplySpot;
  const stop = room.vehicle?.playAllowed && venueStatus?.stop;
  const deadzone = room.deadzoneJoinUrl;
  const points = new Map((position ? nearbySpots : []).map(spot => [spot.placeId, spot]));
  if (supply) points.set(supply.placeId, { ...points.get(supply.placeId), ...supply, activity: 'supply' });
  if (stop) points.set(stop.placeId, { ...position, ...points.get(stop.placeId), ...stop, activity: 'charge' });
  if (deadzone) points.set('deadzone', { ...(mapAnchor ?? position), placeId: 'deadzone', name: 'DEADZONE 집결지', activity: 'deadzone' });
  const spots = [...points.values()].sort((a, b) => Number(Boolean(b.activity)) - Number(Boolean(a.activity))).slice(0, 10);
  const next = spots.find(spot => spot.activity);
  $('journey-next').hidden = !next;
  if (next) {
    const [label, description, action] = journeyActivityCopy(next.activity);
    const game = next.activity === 'charge' ? venueStatus?.kind : next.activity === 'deadzone' ? 'deadzone' : null;
    setGameArt($('journey-next'), game);
    $('journey-next-icon').hidden = next.activity !== 'supply';
    $('journey-next-label').textContent = label;
    $('journey-next-name').textContent = coopGames[game]?.title ?? journeySpotName(next);
    const status = $('journey-next-status');
    if (status.textContent !== description) status.textContent = description;
    const enter = $('journey-next-enter');
    enter.textContent = action;
    enter.onclick = () => enterJourneyActivity(next);
  }
  const plot = $('journey-plot');
  const list = $('journey-spots');
  $('journey-bag').hidden = room.driveGamesAvailable !== true;
  $('journey-supplies').textContent = room.collection?.inventory?.supplies ?? 0;
  const mapStatus = $('journey-map-status');
  const mapMessage = routeFeedback || (!position ? '차량 위치 대기 중' : '');
  if (mapStatus.textContent !== mapMessage) mapStatus.textContent = mapMessage;
  mapStatus.hidden = !mapMessage;
  let car = plot.querySelector('.journey-car');
  if (position && !car) {
    car = document.createElement('span');
    car.className = 'journey-car';
    car.textContent = '내 차량';
    plot.append(car);
  }
  if (!position) car?.remove();
  const plotted = spots.filter(spot => Number.isFinite(spot.latitude) && Number.isFinite(spot.longitude));
  const scale = position ? Math.max(600, ...plotted.flatMap(spot => offset(spot, mapAnchor).map(Math.abs))) : 600;
  const [carEast, carNorth] = position ? offset(position, mapAnchor) : [0, 0];
  const carX = 50 + carEast / scale * 40, carY = 50 - carNorth / scale * 40;
  if (position) {
    car.style.left = carX + '%';
    car.style.top = carY + '%';
  }
  const signature = JSON.stringify([mapAnchor, spots, selectedSpot?.placeId]);
  if (signature !== mapSignature) {
    mapSignature = signature;
    plot.querySelectorAll('.journey-pin').forEach(pin => pin.remove());
    list.replaceChildren();
    const plotWidth = Math.max(1, plot.clientWidth);
    const plotHeight = Math.max(1, plot.clientHeight);
    const clusters = [];
    for (const [index, spot] of spots.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      const label = spot.activity === 'supply' ? journeySpotName(spot) : (index + 1) + ' · ' + journeySpotName(spot);
      button.textContent = label;
      if (spot.activity === 'supply') {
        button.classList.add('item-inline');
        button.prepend(document.createElement('ply-supply-icon'));
      }
      button.classList.toggle('spot-active', Boolean(spot.activity));
      button.setAttribute('aria-pressed', String(selectedSpot?.placeId === spot.placeId));
      button.onclick = () => selectJourneySpot(spot);
      list.append(button);
      if (!position || !plotted.includes(spot)) continue;
      const [east, north] = offset(spot, mapAnchor);
      const x = 50 + east / scale * 40;
      let y = 50 - north / scale * 40;
      if (Math.abs(x - carX) * plotWidth / 100 < 38 && Math.abs(y - carY) * plotHeight / 100 < 46) {
        y = carY - 46 * 100 / plotHeight;
      }
      const marker = { spot, index, button };
      const cluster = clusters.find(group =>
        Math.hypot((x - group.x) * plotWidth / 100, (y - group.y) * plotHeight / 100) < 40);
      if (cluster) cluster.markers.push(marker);
      else clusters.push({ x, y, markers: [marker] });
    }
    for (const { x, y, markers } of clusters) {
      const selected = markers.findIndex(({spot}) => selectedSpot?.placeId === spot.placeId);
      const marker = markers[selected < 0 ? 0 : (selected + 1) % markers.length];
      const hasSupply = markers.some(({ spot }) => spot.activity === 'supply');
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'journey-pin' + (markers.some(({spot}) => spot.activity) ? ' spot-active' : '');
      pin.style.left = x + '%';
      pin.style.top = y + '%';
      if (hasSupply) {
        pin.classList.add('supply-pin');
        pin.append(document.createElement('ply-supply-icon'));
        if (markers.length > 1) {
          const count = document.createElement('span');
          count.className = 'cluster-count';
          count.textContent = markers.length;
          count.setAttribute('aria-hidden', 'true');
          pin.append(count);
        }
      } else pin.textContent = markers.length > 1 ? '+' + markers.length : String(marker.index + 1);
      pin.setAttribute('aria-label', markers.length > 1
        ? markers.length + '개 장소 · 다음 장소 ' + marker.button.textContent : marker.button.textContent);
      pin.setAttribute('aria-pressed', String(selected >= 0));
      pin.onclick = marker.button.onclick;
      plot.append(pin);
    }
  }
  const current = selectedSpot && (points.get(selectedSpot.placeId) ?? { ...selectedSpot, activity: null });
  $('journey-place').hidden = !current || current.placeId === next?.placeId;
  deadzoneLink.hidden = current?.activity !== 'deadzone';
  if (!current) return;
  $('journey-place-icon').hidden = current.activity !== 'supply';
  $('journey-place-name').textContent = journeySpotName(current);
  const status = $('journey-place-status');
  const enter = $('journey-enter');
  enter.hidden = !current.activity || current.activity === 'deadzone';
  if (current.activity) {
    const [, description, action] = journeyActivityCopy(current.activity);
    status.textContent = description;
    enter.textContent = action;
    enter.onclick = () => enterJourneyActivity(current);
  } else {
    status.textContent = [spotTypes[current.category], Number.isFinite(current.distanceM) ? current.distanceM + 'm' : '', '대기 중'].filter(Boolean).join(' · ');
  }
}

function renderJourneyGuidance(nav) {
  const panel = $('journey-guidance');
  const active = nav?.available && ['ROUTE_READY', 'ROUTE_DRIVE', 'ARRIVED'].includes(nav.status);
  panel.hidden = !active;
  if (!active) return;

  const destination = $('journey-guidance-destination');
  const title = nav.destination || 'Pleos 내비 안내';
  if (destination.textContent !== title) destination.textContent = title;
  const details = [nav.status === 'ARRIVED' ? '도착' : nav.status === 'ROUTE_READY' ? '경로 준비 완료' : 'Pleos 안내 중'];
  if (nav.status !== 'ARRIVED' && Number.isFinite(nav.remainingDistanceM)) {
    const distance = nav.remainingDistanceM;
    details.push(distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(1)} km`);
  }
  if (nav.status !== 'ARRIVED' && Number.isFinite(nav.remainingTimeSec)) {
    details.push(`${Math.ceil(nav.remainingTimeSec / 60)}분`);
  }
  const progress = $('journey-guidance-progress');
  const message = details.join(' · ');
  if (progress.textContent !== message) progress.textContent = message;
}

async function refreshJourneyMap() {
  const active = credentials;
  const position = room?.navigation?.position;
  if (journeyView !== 'map' || !active || !position || !ownMember()?.approved) return;
  if (lastMapFetch && Date.now() - lastMapFetch < 12000) return;
  lastMapFetch = Date.now();
  try {
    const value = await post('/api/places/nearby', { ...position, radiusM: 2500, limit: 12, eligibleOnly: false }, active.token);
    if (active !== credentials || !ownMember()?.approved) return;
    nearbySpots = value.places;
    renderJourneyMap();
  } catch {
    if (active === credentials) $('journey-map-status').textContent = '주변 스팟을 불러오지 못했어요. 연결되면 다시 조회합니다.';
  }
}

function render() {
  renderDriveGames();
  if (!ownMember()?.approved) {
    venuePanel.hidden = true;
    venueSignature = '';
  }
  const hasRoute = Boolean(room?.party?.route?.active || room?.navigation?.owned);
  document.querySelector('.collection-panel').hidden = hasRoute;
  const supplyAvailable = ownMember()?.approved && room?.vehicle?.gear === 'D' && room?.routeSupplyAvailable;
  routeGame.hidden = journeyView !== 'supply';
  const speed = room?.vehicle?.speedMps;
  routeSpeed.textContent = Number.isFinite(speed) ? '차량 속도 ' + Math.round(speed * 3.6) + ' km/h' : '';
  if (!supplyAvailable && room?.vehicle?.gear !== 'D' && activeRouteChallenge) {
    activeRouteChallenge = null;
    routeButtons.replaceChildren();
    routeMessage.textContent = '차량이 정차해 수집을 마쳤습니다.';
  }
  if (!activeRouteChallenge && !routeRequestPending) routeStart.disabled = !supplyAvailable;
  const joinUrl = memberId && room?.deadzoneJoinUrl;
  if (!joinUrl) deadzoneLink.hidden = true;
  if (joinUrl) deadzoneLink.href = joinUrl;
  else deadzoneLink.removeAttribute('href');
  if (!room) return;
  const me = ownMember() || room.members?.find(member => member.seat === $('seat').value);
  $('my-name').textContent = me?.nickname || $('nickname').value;
  $('my-seat').textContent = seats[me?.seat] || '자리 확인 중';
  const approved = me?.approved === true && !waitingForApprovedTicket;
  $('leave-button').textContent=approved?'파티 탈퇴':'참가 요청 취소';
  $('pending-panel').hidden = approved; $('approved-content').hidden = !approved;
  if (!approved) return;
  if ($('account-panel').parentElement !== $('journey-party')) {
    $('journey-party').append($('account-panel'));
    $('journey-map').scrollIntoView({ block: 'start' });
  }
  renderJourneyMap();
  void refreshJourneyMap();
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
    const item = document.createElement('span');
    item.className = 'item-inline';
    item.append(document.createElement('ply-supply-icon'), title);
    button.append(item, label); button.addEventListener('click', () => command('mobile.collect', { pickupId: pickup.pickupId, passengerConfirmed: $('passenger-confirm').checked })); return button;
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
// 화면으로 돌아오면 열려 있지 않은 연결(멈춘 연결 포함)은 바로 다시 붙인다
const notLive = () => credentials && (!socket || socket.readyState !== WebSocket.OPEN);
document.addEventListener('visibilitychange', () => { if (!document.hidden && notLive()) { clearTimeout(retryTimer); connect(); } });
window.addEventListener('online', () => { if (notLive()) connect(); });
window.addEventListener('pageshow', () => { if (notLive()) connect(); });
window.addEventListener('pagehide', () => { if (socket) socket.close(); });
setInterval(() => { if (room) renderControls(); }, 1000);
