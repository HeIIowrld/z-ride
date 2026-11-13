'use strict';
// PLY 웹 차량 화면(CAR_HOST 시험판).
// 방 만들기 → QR 초대(party/invite) → 동승자 승인 → 차량 신호 보고 → 전투 시작/지원.
// 토큰·초대 링크는 메모리에만 둔다(URL·저장소·로그에 남기지 않음).
(() => {
  const $ = id => document.getElementById(id);
  const apiOrigin = window.ZRIDE_CONFIG?.apiOrigin || location.origin;
  const SEAT_NAME = { FRONT_PASSENGER: '앞 동승석', REAR_LEFT: '뒤 왼쪽', REAR_RIGHT: '뒤 오른쪽', DRIVER: '운전석' };
  const STATE_NAME = { LOBBY: '대기', READY: '시작 가능', PLAYING: '전투 중', PAUSED: '일시정지', CLEARED: '공략 완료', PENDING: '대기' };
  const GATE_NAME = { CAR_DISCONNECTED: '차량 연결 끊김', APP_INACTIVE: '앱 비활성', LEASE_EXPIRED: '차량 보고 만료', UX_RESTRICTED: '주행 중', UX_UNKNOWN: 'UX 확인 중', GEAR_NOT_P: 'P단 아님', GEAR_UNKNOWN: '기어 확인 중' };
  const ERR = {
    TEST_ACCESS_REQUIRED: '이 서버는 테스트 접근키가 필요해요. 아래 접근키 칸을 열어 입력하세요.',
    PUBLIC_ORIGIN_REQUIRED: 'QR 주소를 만들 수 없어요. 서버를 ZRIDE_PUBLIC_ORIGIN=http://<맥 IP>:8000 과 함께 다시 켜 주세요.',
    SUPPLY_REQUIRED: '보급품이 없어요. 동승자가 이동 중에 보급품을 모아야 해요.',
    GATE_CLOSED: '주차(P) 상태에서만 전투를 시작할 수 있어요.',
    OPERATOR_REQUIRED: '승인되고 접속 중인 동승자가 1명 이상 있어야 해요.',
    ALREADY_PLAYING: '이미 전투 중이에요.', NOT_PLAYING: '전투 중이 아니에요.',
    SEAT_TAKEN: '그 자리는 이미 접속 중인 다른 대원이 쓰고 있어요.', INVITE_EXPIRED: 'QR이 만료됐어요. 새 QR을 받아 주세요.', STALE_EPOCH: '상태가 바뀌었어요. 다시 눌러 주세요.',
  };
  const say = code => ERR[code] || ('처리하지 못했어요 · ' + code);

  let token = null, roomId = null, room = null, ws = null, gen = 0, retry = 0, reportSeq = 0, gear = 'P';
  let invite = null, qrHidden = false, reportTimer = null, tickTimer = null, counter = 0;
  const waiting = new Map();
  const cid = p => p + '-' + Date.now().toString(36) + '-' + (++counter).toString(36) + Math.random().toString(36).slice(2, 8);

  function status(text, kind = '') { $('status').textContent = text; $('status').className = 'status ' + kind; }
  function msg(text) { $('action-msg').textContent = text; }

  async function api(path, body = {}) {
    const res = await fetch(new URL(path, apiOrigin), { method: 'POST', cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
    const value = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(value.error?.code || 'HTTP_' + res.status);
    return value;
  }

  // ── 소리: 차량 스피커로만 알림 ──────────────────────────
  let ac = null;
  function tone(freqs, gap = .11, type = 'triangle') {
    try { ac ??= new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); } catch { return; }
    const t0 = ac.currentTime;
    freqs.forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + i * gap); g.gain.linearRampToValueAtTime(.2, t0 + i * gap + .02);
      g.gain.exponentialRampToValueAtTime(.001, t0 + i * gap + .35);
      o.connect(g).connect(ac.destination); o.start(t0 + i * gap); o.stop(t0 + i * gap + .4);
    });
  }
  const SFX = { join: () => tone([660, 880]), approved: () => tone([784, 988]), item: () => tone([784, 988, 1319]), clear: () => tone([523, 659, 784, 1047, 784, 1047], .13) };

  // ── 시작 ───────────────────────────────────────────────
  $('start-btn').addEventListener('click', async () => {
    $('start-btn').disabled = true; $('start-error').textContent = ''; tone([440], .1, 'sine');
    try {
      const body = { role: 'CAR_HOST', nickname: $('nickname').value.trim() || '우리 차' };
      if ($('access-key').value) body.accessKey = $('access-key').value;
      const s = await api('/api/session', body); token = s.token; $('access-key').value = '';
      const r = await api('/api/rooms'); roomId = r.roomId; room = r.room;
      $('start').hidden = true; $('party').hidden = false;
      connect(); await newInvite(); render();
      tickTimer = setInterval(tick, 500);
    } catch (e) {
      if (e.message === 'TEST_ACCESS_REQUIRED') $('key-box').open = true;
      $('start-error').textContent = say(e.message); token = null;
    } finally { $('start-btn').disabled = false; }
  });

  // ── 실시간 연결 + 차량 신호 보고 ────────────────────────
  function connect() {
    const my = ++gen; clearInterval(reportTimer); reportSeq = 0;
    status(retry ? '재연결 중…' : '연결 중…');
    ws = new WebSocket(apiOrigin.replace(/^http/, 'ws') + '/ws');
    ws.onopen = () => my === gen && ws.send(JSON.stringify({ type: 'auth', token, roomId }));
    ws.onmessage = ev => {
      if (my !== gen) return;
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'auth.ok') { retry = 0; status('실시간 연결됨', 'live'); report(); reportTimer = setInterval(report, 2000); }
      else if (m.type === 'snapshot') { if (!room || m.room.stateVersion >= room.stateVersion || m.room.roomId !== room.roomId) onSnapshot(m.room); }
      else if (m.type === 'result') { const w = waiting.get(m.commandId); if (w) { waiting.delete(m.commandId); m.ok ? w.ok(m.data) : w.fail(new Error(m.error?.code || 'ERROR')); } }
      else if (m.type === 'error') msg(say(m.error?.code || 'ERROR'));
    };
    ws.onclose = ev => {
      if (my !== gen) return; clearInterval(reportTimer);
      if ([4401, 4410].includes(ev.code)) { status('파티가 닫혔어요', 'error'); return; }
      status('연결 끊김 · 재연결 대기', 'error');
      setTimeout(connect, Math.min(10000, 1000 * 2 ** retry++));
    };
  }
  function send(message) {
    return new Promise((ok, fail) => {
      if (ws?.readyState !== WebSocket.OPEN) return fail(new Error('WS_DISCONNECTED'));
      waiting.set(message.commandId, { ok, fail });
      setTimeout(() => { if (waiting.delete(message.commandId)) fail(new Error('TIMEOUT')); }, 8000);
      ws.send(JSON.stringify(message));
    });
  }
  function report() {
    // 시험판: P면 UX 허용, D면 주행 중 제한. 실제 Pleos 앱은 Vehicle SDK 값을 그대로 보낸다.
    send({ type: 'vehicle.report', commandId: cid('report'), reportSeq: ++reportSeq,
      ux: gear === 'P' ? 'ALLOWED' : 'RESTRICTED', gear, foreground: !document.hidden,
      source: 'WEB_CAR_SIMULATED', charge: { state: 'UNKNOWN', portConnection: 'UNKNOWN', source: 'NONE' } }).catch(() => {});
  }
  document.addEventListener('visibilitychange', () => { if (ws?.readyState === WebSocket.OPEN) report(); });

  async function command(action, extra = {}) {
    if (!room) return;
    try { return await send({ type: 'command', commandId: cid(action), roomEpoch: room.roomEpoch, action, ...extra }); }
    catch (e) { msg(say(e.message)); throw e; }
  }

  // ── QR 초대 ─────────────────────────────────────────────
  async function newInvite() {
    $('qr-error').textContent = '';
    try {
      const d = await api('/api/rooms/' + roomId + '/party/invite');
      invite = { url: d.joinUrl, expiresAt: d.expiresAt };
      drawQr();
    } catch (e) { invite = null; $('qr').replaceChildren(); $('qr-error').textContent = say(e.message); }
  }
  function drawQr() {
    // 세 자리가 다 차면 다 쓴 QR을 치운다(옛 QR이 화면에 남아 있지 않도록)
    if (!invite || qrHidden || (room && freeSeats() <= 0)) { $('qr').replaceChildren(); return; }
    try { window.ZRideQR.renderSvg($('qr'), invite.url); } catch { $('qr-error').textContent = 'QR을 그리지 못했어요.'; }
  }
  $('qr-refresh').addEventListener('click', newInvite);
  $('qr-toggle').addEventListener('click', () => { qrHidden = !qrHidden; $('qr-toggle').textContent = qrHidden ? 'QR 보이기' : 'QR 숨기기'; drawQr(); });

  function freeSeats() { return 3 - (room?.members || []).filter(m => m.role !== 'CAR_HOST').length; }
  function tick() {
    if (!invite) { $('qr-timer').textContent = ''; return; }
    const left = Math.max(0, Math.ceil((invite.expiresAt - Date.now()) / 1000));
    $('qr-timer').textContent = left > 0 ? `${left}초 남음` : '만료됨';
    $('qr-timer').classList.toggle('warn', left <= 20);
    // 만료되면 빈자리가 있을 때만 새 QR (서버 기준 120초·최대 3명)
    if (left === 0 && freeSeats() > 0 && !tick.busy) { tick.busy = true; newInvite().finally(() => { tick.busy = false; }); }
  }

  // ── 상태 반영 ───────────────────────────────────────────
  let prev = null;
  function onSnapshot(next) {
    const before = prev; room = next; prev = next;
    const phones = m => (m?.members || []).filter(x => x.role !== 'CAR_HOST');
    if (before) {
      // QR 하나는 참가 3번까지만 받으므로(재시도 포함) 누가 들어올 때마다 새 QR로 바꿔 둔다
      if (phones(next).length > phones(before).length) { SFX.join(); if (3 - phones(next).length > 0) newInvite(); }
      if (phones(next).filter(m => m.approved).length > phones(before).filter(m => m.approved).length) SFX.approved();
      if ((next.collection?.inventory?.supplies ?? 0) > (before.collection?.inventory?.supplies ?? 0)) SFX.item();
      if (next.state === 'CLEARED' && before.state !== 'CLEARED') SFX.clear();
    }
    if (next.party?.status === 'DISBANDED') { status('파티를 해산했어요', 'error'); invite = null; drawQr(); }
    autoApprove(); render();
  }
  async function approve(member) {
    try {
      // 폰이 QR을 다시 찍어 새로 들어오면, 같은 자리에 오프라인으로 남은 옛 대원이 SEAT_TAKEN을 낸다 → 그 자리를 비워 준다
      const ghost = room?.members.find(m => m.role !== 'CAR_HOST' && m.memberId !== member.memberId && m.approved && !m.connected && m.seat === member.seat);
      if (ghost) { await api('/api/rooms/' + roomId + '/party/remove', { memberId: ghost.memberId }); newInvite(); }
      await api('/api/rooms/' + roomId + '/approve', { memberId: member.memberId, seat: member.seat, allowManualUnknown: true }); msg(`${member.nickname} 님을 ${SEAT_NAME[member.seat]}에 승인했어요.`);
    } catch (e) { msg(say(e.message)); }
  }
  async function removeMember(member) {
    if (!confirm(`${member.nickname} 님을 파티에서 내보낼까요?`)) return;
    // 내보내면 서버가 이 방의 초대를 모두 지우므로 새 QR을 받는다
    try { await api('/api/rooms/' + roomId + '/party/remove', { memberId: member.memberId }); newInvite(); } catch (e) { msg(say(e.message)); }
  }
  const approving = new Set();
  function autoApprove() {
    if (!$('auto-approve').checked || !room) return;
    for (const m of room.members.filter(x => x.role !== 'CAR_HOST' && !x.approved && !approving.has(x.memberId))) {
      approving.add(m.memberId); approve(m).finally(() => approving.delete(m.memberId));
    }
  }
  $('auto-approve').addEventListener('change', autoApprove);

  function render() {
    if (!room) return;
    const crew = room.members.filter(m => m.role !== 'CAR_HOST');
    $('crew-count').textContent = `${crew.length} / 3`;
    $('crew').replaceChildren(...(crew.length ? crew.map(m => {
      const li = document.createElement('li'); li.className = m.approved ? 'ok' : 'pending';
      const name = document.createElement('b'); name.textContent = m.nickname;
      const meta = document.createElement('span'); meta.textContent = `${SEAT_NAME[m.seat] || m.seat} · ${m.approved ? (m.connected ? '접속 중' : '오프라인') : '승인 대기'}`;
      li.append(name, meta);
      if (!m.approved) { const b = document.createElement('button'); b.type = 'button'; b.className = 'primary small'; b.textContent = '승인'; b.onclick = () => approve(m); li.append(b); }
      const x = document.createElement('button'); x.type = 'button'; x.className = 'quiet small'; x.textContent = '내보내기'; x.onclick = () => removeMember(m); li.append(x);
      return li;
    }) : [Object.assign(document.createElement('li'), { className: 'empty', textContent: '아직 합류한 대원이 없어요.' })]));

    const full = freeSeats() <= 0;
    $('qr-hint').textContent = full ? '세 자리가 모두 찼어요. 누가 나가면 새 QR이 떠요.' : '동승자는 휴대폰 카메라로 찍어 합류하세요.';
    if (full !== render.full) {
      render.full = full;
      // 자리가 다시 비면 옛 QR(사용 횟수 소진 가능) 대신 새 QR을 받는다
      if (!full && render.wasFull) newInvite(); else drawQr();
      render.wasFull = render.wasFull || full;
    }

    for (const b of document.querySelectorAll('.gear-btn')) b.classList.toggle('on', b.dataset.gear === gear);
    const v = room.vehicle || {}, allowed = v.playAllowed === true;
    $('gate').textContent = allowed ? '전투 가능' : (v.gateReasons || []).map(r => GATE_NAME[r] || r).join(' · ') || '확인 중';
    $('gate').className = 'pill ' + (allowed ? 'good' : 'warn');

    const driving = gear !== 'P';
    $('driving-cover').hidden = !driving; $('battle-info').hidden = driving;
    $('battle-state').textContent = STATE_NAME[room.state] || room.state;
    const alive = (room.zombies || []).filter(z => z.hp > 0).length;
    $('zombies-left').textContent = room.zombies?.length ? `${alive} / ${room.zombies.length}` : '-';
    $('supplies').textContent = room.collection?.inventory?.supplies ?? 0;
    $('kills').textContent = room.stats?.kills ?? 0;
    const connectedCrew = crew.some(m => m.approved && m.connected);
    $('round-start').disabled = !allowed || room.state === 'PLAYING' || !connectedCrew;
    // 왜 못 누르는지 버튼 아래에 알려 준다
    const why = room.state === 'PLAYING' ? '' : !allowed ? '주차(P) 상태에서만 시작할 수 있어요.'
      : !connectedCrew ? (crew.some(m => m.approved) ? '승인된 대원의 폰이 오프라인이에요. 폰에서 PLY 화면을 다시 열어 주세요.' : '승인된 대원이 1명 이상 있어야 시작할 수 있어요.') : '';
    if (why || render.why) { $('action-msg').textContent = why; render.why = why; }
    $('round-start').textContent = room.state === 'CLEARED' ? '다음 웨이브 시작' : room.state === 'PAUSED' ? '전투 재개' : '전투 시작';
    $('round-pause').disabled = room.state !== 'PLAYING';
    $('support').disabled = room.state !== 'PLAYING' || !allowed || !(room.collection?.inventory?.supplies > 0);
    $('support').classList.toggle('active', room.stats?.supportActive === true);
  }

  document.querySelectorAll('.gear-btn').forEach(b => b.addEventListener('click', () => {
    gear = b.dataset.gear; report(); render();
    msg(gear === 'P' ? '주차했어요. 차량에서 전투를 시작할 수 있어요.' : '주행 중이에요. 동승자 폰의 전투가 잠겨요.');
  }));
  $('round-start').addEventListener('click', () => command('round.start').then(() => msg('전투 시작! 동승자 폰에 전투 화면이 열려요.')).catch(() => {}));
  $('round-pause').addEventListener('click', () => command('round.pause').then(() => msg('일시정지했어요.')).catch(() => {}));
  $('support').addEventListener('click', () => command('support.pulse').then(() => { msg('차량 지원 사격! 5초 동안 동승자 사격 피해가 커져요.'); tone([392, 523, 659], .08, 'square'); }).catch(() => {}));
  $('disband').addEventListener('click', async () => {
    if (!roomId || !confirm('파티를 해산할까요? 모든 대원이 나가고 지금 QR은 더 이상 쓸 수 없어요.')) return;
    try { await api('/api/rooms/' + roomId + '/party/disband'); invite = null; drawQr(); clearInterval(tickTimer); msg('파티를 해산했어요. 새로고침하면 새 파티를 열 수 있어요.'); }
    catch (e) { msg(say(e.message)); }
  });
  window.addEventListener('pagehide', () => { if (ws) ws.close(); });
})();
