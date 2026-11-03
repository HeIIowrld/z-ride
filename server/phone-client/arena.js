'use strict';
// Z-RIDE 1인칭 360° 전투 화면 — app.js의 세션·WS·command()를 그대로 사용한다.
// 판정은 서버가 한다(fire angleDeg, ±15°). 이 파일은 조준·연출·피드백만 맡는다.
(() => {
  const FOV = 64;               // 화면에 보이는 가로 시야(도)
  const HIT_TOLERANCE = 15;     // server.mjs fire 판정과 동일(표시용)
  // 상하 조준(pitchDeg). 서버가 부위별 판정을 지원하면 true로 바꿔 fire에 함께 보낸다.
  // 제안: 노션 "[제안] 부위별 사격 판정" / 지금 서버는 angleDeg만 판정한다.
  const SEND_PITCH = false;
  const PITCH_MIN = -30, PITCH_MAX = 30, PITCH_SPEED = 45; // 도, 도/초
  const PX_PER_PITCH = 39 / 19; // 좀비 크기 단위(s)당: 몸통 중심(0°)→머리 중심(약 19°)
  const SEAT_FRONT = { FRONT_PASSENGER: 20, REAR_LEFT: -100, REAR_RIGHT: 120 };
  const el = id => document.getElementById(id);
  const norm = a => { a = ((a + 180) % 360 + 360) % 360 - 180; return a === -180 ? 180 : a; };
  const diff = (a, b) => norm(a - b);

  const A = {
    open: false, aim: 0, target: 0, mode: 'stick', stick: 0, stickY: 0, pitch: 0, targetPitch: 0, headingOffset: null, rawHeading: null,
    drag: null, flash: 0, recoil: 0, shake: 0, popups: [], lastShotTime: 0, lastSupplies: null,
    zombieFx: new Map(), audio: null, raf: 0,
  };

  // ── 소리 (폰 스피커, Web Audio) ──────────────────────────
  function audio() {
    if (!A.audio) try { A.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
    if (A.audio.state === 'suspended') A.audio.resume();
    return A.audio;
  }
  function blip(freq, dur, type = 'square', vol = .12, slide = 0) {
    const ac = audio(); if (!ac) return;
    const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.001, t + dur);
    o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur + .02);
  }
  const sfx = {
    shot: () => { blip(220, .09, 'square', .14, -160); blip(90, .12, 'sawtooth', .08, -40); },
    hit: () => { blip(880, .08, 'triangle', .14); setTimeout(() => blip(1320, .1, 'triangle', .12), 60); },
    miss: () => blip(160, .1, 'sine', .08, -60),
    kill: () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => blip(f, .14, 'triangle', .12), i * 70)),
    item: () => [784, 988, 1319].forEach((f, i) => setTimeout(() => blip(f, .16, 'triangle', .13), i * 90)),
  };
  const buzz = p => { try { navigator.vibrate?.(p); } catch {} };

  // ── 화면 열기/닫기 ───────────────────────────────────────
  function openArena() {
    const me = typeof ownMember === 'function' ? ownMember() : null;
    if (!me?.approved) return;
    A.open = true; el('arena').hidden = false; document.body.classList.add('arena-active');
    // 확대된 채로 열리면 전투 화면(touch-action:none)에서는 손가락으로 되돌릴 수 없으므로 원래 비율로 되돌린다
    if ((window.visualViewport?.scale ?? 1) > 1.01) { const vp = document.querySelector('meta[name=viewport]'); if (vp) { const c = vp.content; vp.content = c + ', minimum-scale=1'; setTimeout(() => { vp.content = c; }, 300); } }
    if (A.headingOffset == null) { A.aim = A.target = clampSector(SEAT_FRONT[me.seat] ?? 0); }
    audio(); resize(); cancelAnimationFrame(A.raf); A.raf = requestAnimationFrame(frame);
  }
  function closeArena() { A.open = false; el('arena').hidden = true; document.body.classList.remove('arena-active'); cancelAnimationFrame(A.raf); }
  el('arena-open').addEventListener('click', openArena);
  el('arena-close').addEventListener('click', closeArena);

  // ── 조준: 폰을 돌려서(나침반) / 화면을 끌어서 ──────────────────
  function onOrientation(e) {
    let h = typeof e.webkitCompassHeading === 'number' ? e.webkitCompassHeading : (e.absolute || e.alpha != null) && e.alpha != null ? 360 - e.alpha : null;
    if (h == null) return;
    A.rawHeading = h;
    if (A.mode === 'gyro' && A.headingOffset != null) A.target = clampSector(norm(h - A.headingOffset));
  }
  el('arena-calibrate').addEventListener('click', async ev => {
    ev.stopPropagation();
    // iOS는 사용자 탭 안에서 권한을 요청해야 하고 HTTPS가 필요하다
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        if (await DeviceOrientationEvent.requestPermission() !== 'granted') throw new Error('denied');
      }
    } catch { note('방향 센서를 쓸 수 없어 조이스틱으로 조준해요.'); return; }
    window.addEventListener('deviceorientationabsolute', onOrientation);
    window.addEventListener('deviceorientation', onOrientation);
    setTimeout(() => {
      if (A.rawHeading == null) { note('이 브라우저는 방향 센서를 주지 않아요. 조이스틱으로 조준하세요.'); return; }
      // 지금 폰이 가리키는 방향 = 차량 정면(0°)
      A.headingOffset = A.rawHeading; A.mode = 'gyro'; A.target = clampSector(0);
      note('정면을 맞췄어요. 폰을 돌려 좀비를 찾으세요!');
    }, 250);
  });

  const stage = () => el('arena-canvas');
  // 화면을 짧게 톡 = 사격 (조준은 조이스틱/폰 돌리기)
  let tap = null;
  stage().addEventListener('pointerdown', e => { tap = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  stage().addEventListener('pointerup', e => {
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 12 && performance.now() - tap.t < 450) fire();
    tap = null;
  });

  // ── 조이스틱: 미는 만큼 빠르게 회전, 좀비 근처에선 느려짐(조준 보조) ──
  const MAX_TURN = 120; // 도/초
  const base = el('arena-stick'), knob = el('arena-knob');
  let stickId = null;
  function stickMove(e) {
    const r = base.getBoundingClientRect(), R = r.width / 2;
    let dx = e.clientX - (r.left + R), dy = e.clientY - (r.top + R);
    const len = Math.hypot(dx, dy);
    if (len > R) { dx *= R / len; dy *= R / len; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const x = dx / R;
    A.stick = Math.abs(x) < .12 ? 0 : Math.sign(x) * ((Math.abs(x) - .12) / .88) ** 1.6;
    const y = -dy / R; // 위로 밀면 +
    A.stickY = Math.abs(y) < .15 ? 0 : Math.sign(y) * ((Math.abs(y) - .15) / .85) ** 1.4;
  }
  base.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    stickId = e.pointerId; base.setPointerCapture(e.pointerId); base.classList.add('active');
    if (A.mode === 'gyro') { A.mode = 'stick'; note('조이스틱 조준으로 바꿨어요.'); }
    stickMove(e);
  });
  base.addEventListener('pointermove', e => { if (e.pointerId === stickId) stickMove(e); });
  const stickEnd = e => { if (e.pointerId !== stickId) return; stickId = null; A.stick = 0; A.stickY = 0; knob.style.transform = ''; base.classList.remove('active'); };
  base.addEventListener('pointerup', stickEnd);
  base.addEventListener('pointercancel', stickEnd);
  function turnSpeed() {
    if (!A.stick) return 0;
    const near = (room?.zombies || []).filter(z => z.hp > 0 && inSector(z.angleDeg))
      .map(z => Math.abs(diff(z.angleDeg, A.aim))).sort((a, b) => a - b)[0];
    const assist = near != null && near < 10 ? .4 : 1;
    return A.stick * MAX_TURN * assist;
  }

  el('arena-fire').addEventListener('click', ev => { ev.stopPropagation(); fire(); });

  // ── 내 구역 밖으로는 조준이 못 나가게 ─────────────────────
  // 구역 [s0, s1]의 중심·반폭으로 계산해 ±180° 경계를 넘어도 안전하다.
  function clampSector(a) {
    const s = sector(); if (!s) return norm(a);
    const center = (s[0] + s[1]) / 2, half = (s[1] - s[0]) / 2;
    const rel = diff(a, center);
    return Math.abs(rel) <= half ? norm(a) : norm(center + Math.sign(rel) * half);
  }
  let lastEdge = 0;
  function hitEdge() {
    const now = performance.now(); if (now - lastEdge < 900) return; lastEdge = now;
    A.shake = .15; buzz(12); note('여기까지가 내 방어 구역이에요');
  }

  // ── 사격: 판정은 서버 ────────────────────────────────────
  function sector() { return ownMember()?.sector || null; }
  function inSector(angle) { return typeof inside === 'function' && inside(angle, sector()); }
  function canFire() {
    return typeof online === 'function' && online() && !pending && room?.state === 'PLAYING' && gateOpen() && inSector(Math.round(A.aim));
  }
  function fire() {
    const angle = Math.round(norm(A.aim));
    if (!canFire()) {
      A.shake = .25; blip(110, .08, 'sine', .06);
      note(!inSector(angle) ? '여긴 다른 대원 구역이에요.' : room?.state !== 'PLAYING' ? '차량에서 전투를 시작해야 쏠 수 있어요.' : !gateOpen() ? '주차(P) 후에만 전투할 수 있어요.' : '연결을 기다리는 중…');
      return;
    }
    el('angle').value = angle; // app.js의 구역 검사와 같은 값 사용
    command('fire', SEND_PITCH ? { angleDeg: angle, pitchDeg: Math.round(A.pitch) } : { angleDeg: angle });
    A.flash = 1; A.recoil = 1; sfx.shot(); buzz(15);
  }

  // 결과 피드백: 서버 snapshot의 lastShot(내 것, 새 것)
  function watchShots() {
    const shot = room?.stats?.lastShot;
    if (!shot || shot.memberId !== memberId || shot.time <= A.lastShotTime) return;
    A.lastShotTime = shot.time;
    if (!shot.accepted) return;
    if (shot.hit) {
      const z = room.zombies?.find(x => x.id === shot.targetId);
      const fx = A.zombieFx.get(shot.targetId) || {}; fx.hitAt = performance.now(); A.zombieFx.set(shot.targetId, fx);
      popup(z && z.hp <= 0 ? '처치!' : `명중 -${shot.damage}`, z && z.hp <= 0 ? '#ffd166' : '#ff6b4a');
      if (z && z.hp <= 0) { sfx.kill(); buzz([40, 30, 120]); } else { sfx.hit(); buzz(35); }
    } else { popup('빗나감', '#9fb3c4'); sfx.miss(); }
  }

  // 아이템 알림: 공동 보급품이 늘면 동승자 폰에만 알림 (차량은 소리만 — 차량 앱 담당)
  function watchItems() {
    const n = room?.collection?.inventory?.supplies;
    if (typeof n !== 'number') return;
    if (A.lastSupplies != null && n > A.lastSupplies) {
      toast('📦', `보급품 +${n - A.lastSupplies}`, '주차 후 전투에서 차량 지원 사격에 쓰여요.');
      sfx.item(); buzz([60, 40, 120]);
    }
    A.lastSupplies = n;
  }
  function toast(icon, title, text) {
    const t = el('item-toast');
    el('item-toast-icon').textContent = icon; el('item-toast-title').textContent = title; el('item-toast-text').textContent = text;
    t.hidden = false; t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
  }
  function popup(text, color) { A.popups.push({ text, color, life: 1 }); }
  function note(text) { el('arena-note').textContent = text; clearTimeout(note.t); note.t = setTimeout(() => { el('arena-note').textContent = ''; }, 2600); }

  // 전투가 시작되면 자동으로 전투 화면을 연다
  let lastState = null;
  setInterval(() => {
    if (!room) return;
    watchItems(); watchShots();
    if (room.state === 'PLAYING' && lastState !== 'PLAYING' && ownMember()?.approved) openArena();
    lastState = room.state;
    el('arena-open').hidden = !ownMember()?.approved;
  }, 150);

  // ── 렌더링 ─────────────────────────────────────────────
  let W = 0, H = 0, ctx = null;
  function resize() {
    const c = stage(), dpr = Math.min(2, devicePixelRatio || 1);
    W = c.clientWidth; H = c.clientHeight; c.width = W * dpr; c.height = H * dpr;
    ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', () => A.open && resize());

  const xOf = rel => W / 2 + rel / (FOV / 2) * (W / 2);

  function drawWorld(t) {
    const horizon = H * .46 + A.recoil * 6;
    // 하늘·땅
    let g = ctx.createLinearGradient(0, 0, 0, horizon);
    g.addColorStop(0, '#0b1622'); g.addColorStop(1, '#294155');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, horizon);
    g = ctx.createLinearGradient(0, horizon, 0, H);
    g.addColorStop(0, '#1d2b24'); g.addColorStop(1, '#0d1511');
    ctx.fillStyle = g; ctx.fillRect(0, horizon, W, H - horizon);
    // 먼 건물 실루엣 (각도에 고정 → 돌리면 흘러감)
    ctx.fillStyle = '#16232f';
    for (let a = -180; a < 180; a += 9) {
      const rel = diff(a, A.aim); if (Math.abs(rel) > FOV / 2 + 10) continue;
      const h = 18 + (Math.sin(a * 12.9898) * 43758.5 % 1 + 1) % 1 * 70;
      ctx.fillRect(xOf(rel) - 16, horizon - h, 30, h);
    }
    // 바닥 방사선 (원근감)
    ctx.strokeStyle = 'rgba(124,224,211,.09)'; ctx.lineWidth = 1;
    for (let a = -180; a < 180; a += 15) {
      const rel = diff(a, A.aim); if (Math.abs(rel) > FOV) continue;
      ctx.beginPath(); ctx.moveTo(xOf(rel), horizon); ctx.lineTo(W / 2 + (xOf(rel) - W / 2) * 4, H); ctx.stroke();
    }
    for (let k = 1; k <= 5; k++) { const y = horizon + (H - horizon) * (k / 5) ** 1.8; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    // 다른 대원 구역은 어둡게
    const sec = sector();
    if (sec) {
      ctx.fillStyle = 'rgba(5,10,15,.55)';
      for (let px = 0; px < W; px += 4) {
        const a = Math.round(norm(A.aim + (px - W / 2) / (W / 2) * (FOV / 2)));
        if (!inSector(a)) ctx.fillRect(px, 0, 4, H);
      }
    }
    return horizon;
  }

  function drawZombie(z, horizon, t) {
    const rel = diff(z.angleDeg, A.aim);
    if (Math.abs(rel) > FOV / 2 + 12) return false;
    const fx = A.zombieFx.get(z.id) || {};
    const dead = z.hp <= 0;
    const s = Math.min(W, H) * .0042 * (dead ? .9 : 1);
    const sway = dead ? 0 : Math.sin(t / 380 + z.angleDeg) * 6;
    const x = xOf(rel) + sway, foot = horizon + H * .3;
    const hitAgo = fx.hitAt ? (performance.now() - fx.hitAt) / 1000 : 9;
    ctx.save(); ctx.translate(x, foot);
    if (dead) { ctx.rotate(Math.PI / 2 * .9); ctx.globalAlpha = .5; }
    const body = hitAgo < .15 ? '#ffffff' : inSector(z.angleDeg) ? '#7fa36b' : '#5b6f55';
    // 그림자
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(0, 0, 26 * s, 7 * s, 0, 0, 7); ctx.fill();
    // 다리
    const step = dead ? 0 : Math.sin(t / 260 + z.angleDeg) * 6 * s;
    ctx.fillStyle = '#3c4a5c';
    ctx.fillRect(-11 * s, -46 * s, 9 * s, 46 * s + step); ctx.fillRect(2 * s, -46 * s, 9 * s, 46 * s - step);
    // 몸통(찢어진 옷)
    ctx.fillStyle = '#6e5a49'; ctx.fillRect(-16 * s, -92 * s, 32 * s, 50 * s);
    // 팔 (앞으로 뻗음)
    ctx.fillStyle = body;
    const reach = dead ? 0 : Math.sin(t / 300 + z.angleDeg) * 4 * s;
    ctx.fillRect(-26 * s, -88 * s + reach, 10 * s, 34 * s); ctx.fillRect(16 * s, -88 * s - reach, 10 * s, 34 * s);
    // 머리
    ctx.beginPath(); ctx.arc(0, -106 * s, 15 * s, 0, 7); ctx.fill();
    ctx.fillStyle = '#ff4d3d'; ctx.fillRect(-7 * s, -110 * s, 4 * s, 4 * s); ctx.fillRect(3 * s, -110 * s, 4 * s, 4 * s);
    ctx.restore();
    if (!dead) {
      // HP 바
      const bw = 56 * s, by = foot - 132 * s;
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(x - bw / 2, by, bw, 7 * s);
      ctx.fillStyle = z.hp / z.maxHp > .4 ? '#52f1d0' : '#ff6b4a'; ctx.fillRect(x - bw / 2, by, bw * z.hp / z.maxHp, 7 * s);
    }
    return true;
  }

  function drawCompass() {
    const y = 0, h = 44;
    ctx.fillStyle = 'rgba(6,12,18,.7)'; ctx.fillRect(0, y, W, h);
    ctx.textAlign = 'center'; ctx.font = '700 12px -apple-system,sans-serif';
    for (let a = -180; a < 180; a += 5) {
      const rel = diff(a, A.aim); if (Math.abs(rel) > FOV / 2) continue;
      const x = xOf(rel), major = a % 45 === 0;
      ctx.strokeStyle = inSector(a) ? '#52f1d0' : '#4b6070'; ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x, h - (major ? 14 : 7)); ctx.stroke();
      if (major) {
        const name = { 0: '전방', 90: '우측', 180: '후방', '-180': '후방', '-90': '좌측' }[a] || a + '°';
        ctx.fillStyle = a === 0 ? '#ffd166' : '#c8d6e2'; ctx.fillText(name, x, 18);
      }
    }
    ctx.fillStyle = '#ffd166'; ctx.beginPath(); ctx.moveTo(W / 2 - 6, h); ctx.lineTo(W / 2 + 6, h); ctx.lineTo(W / 2, h - 8); ctx.fill();
  }

  function drawEdgeArrows(horizon) {
    const count = { left: 0, right: 0 };
    for (const z of room?.zombies || []) {
      if (z.hp <= 0 || !inSector(z.angleDeg)) continue;
      const rel = diff(z.angleDeg, A.aim); if (Math.abs(rel) <= FOV / 2) continue;
      const right = rel > 0, x = right ? W - 22 : 22, y = horizon + 30 + 52 * count[right ? 'right' : 'left']++;
      ctx.fillStyle = '#ff6b4a'; ctx.beginPath();
      ctx.moveTo(x + (right ? 12 : -12), y); ctx.lineTo(x - (right ? 6 : -6), y - 12); ctx.lineTo(x - (right ? 6 : -6), y + 12); ctx.fill();
      ctx.font = '700 11px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(Math.round(Math.abs(rel)) + '°', x, y + 28);
    }
  }

  function drawCrosshair() {
    const target = (room?.zombies || []).filter(z => z.hp > 0).map(z => Math.abs(diff(z.angleDeg, A.aim))).sort((a, b) => a - b)[0];
    const locked = target != null && target <= HIT_TOLERANCE && inSector(Math.round(A.aim));
    // 판정은 좌우 각도만 쓰므로, 조준점은 좀비 몸통 높이에 둔다(drawZombie의 foot·크기와 같은 식)
    const zs = Math.min(W, H) * .0042;
    const cx = W / 2, cy = H * .46 + H * .3 - 67 * zs - A.pitch * PX_PER_PITCH * zs + A.recoil * 6, r = 18 + A.recoil * 8;
    ctx.strokeStyle = locked ? '#ff6b4a' : '#e8f6ff'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.beginPath(); ctx.moveTo(cx + dx * (r - 8), cy + dy * (r - 8)); ctx.lineTo(cx + dx * (r + 10), cy + dy * (r + 10)); ctx.stroke(); }
    if (locked) { ctx.fillStyle = '#ff6b4a'; ctx.beginPath(); ctx.arc(cx, cy, 3, 0, 7); ctx.fill(); }
    // 총구 섬광
    if (A.flash > 0) { ctx.globalAlpha = A.flash; ctx.fillStyle = '#ffe9a8'; ctx.beginPath(); ctx.arc(cx, H - 40, 46 * A.flash, 0, 7); ctx.fill(); ctx.globalAlpha = 1; }
    // 팝업
    for (const p of A.popups) {
      ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.color; ctx.font = '900 26px -apple-system,sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(p.text, cx, cy - 34 - (1 - p.life) * 40);
    }
    ctx.globalAlpha = 1;
    return locked;
  }

  function hud(locked) {
    const me = ownMember();
    const live = (room?.zombies || []).filter(z => z.hp > 0 && inSector(z.angleDeg)).length;
    const p = Math.round(A.pitch);
    el('arena-angle').textContent = Math.round(norm(A.aim)) + '°' + (p ? (p > 0 ? ' ↑' : ' ↓') + Math.abs(p) + '°' : '');
    el('arena-supplies').textContent = room?.collection?.inventory?.supplies ?? 0;
    el('arena-left').textContent = live;
    const support = room?.stats?.supportUntil > Date.now();
    el('arena-buff').hidden = !support;
    const ready = room?.state === 'PLAYING' && gateOpen();
    const others = (room?.zombies || []).filter(z => z.hp > 0 && !inSector(z.angleDeg)).length;
    const myDone = ready && live === 0 && others > 0;
    el('arena-lock').hidden = ready && !myDone;
    el('arena-lock-text').textContent = !gateOpen() ? '주행 중 — 주차(P) 후 차량에서 전투를 시작해요'
      : myDone ? `내 구역 정리 완료! 다른 대원 구역에 ${others}마리 남았어요`
      : room?.state === 'CLEARED' ? '거점 공략 완료! 🎉 차량에서 다음 웨이브를 시작할 수 있어요'
      : '차량에서 전투 시작을 기다리는 중';
    el('arena-fire').classList.toggle('locked', locked);
    el('arena-fire').disabled = !ready;
    el('arena-mode').textContent = A.mode === 'gyro' ? '폰을 돌려 조준 중' : '스틱으로 상하좌우 조준 · 화면 톡 = 사격';
    el('arena-seat').textContent = (typeof seats !== 'undefined' && seats[me?.seat]) || '';
  }

  let last = performance.now();
  function frame(t) {
    if (!A.open) return;
    const dt = Math.min(.05, (t - last) / 1000); last = t;
    if (A.mode === 'stick') {
      const want = norm(A.target + turnSpeed() * dt), got = clampSector(want);
      if (got !== want) hitEdge();
      A.target = got;
    }
    A.targetPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, A.targetPitch + A.stickY * PITCH_SPEED * dt));
    A.pitch += (A.targetPitch - A.pitch) * Math.min(1, dt * 18);
    A.aim = norm(A.aim + diff(A.target, A.aim) * Math.min(1, dt * (A.mode === 'gyro' ? 12 : 18)));
    A.flash = Math.max(0, A.flash - dt * 6); A.recoil = Math.max(0, A.recoil - dt * 7); A.shake = Math.max(0, A.shake - dt);
    for (const p of A.popups) p.life -= dt * 1.2; A.popups = A.popups.filter(p => p.life > 0);
    if (!ctx) resize();
    ctx.save();
    if (A.shake) ctx.translate(Math.sin(t / 20) * 6 * A.shake, 0);
    const horizon = drawWorld(t);
    const zs = [...(room?.zombies || [])].sort((a, b) => Math.abs(diff(b.angleDeg, A.aim)) - Math.abs(diff(a.angleDeg, A.aim)));
    for (const z of zs) drawZombie(z, horizon, t);
    drawEdgeArrows(horizon);
    const locked = drawCrosshair();
    drawCompass();
    ctx.restore();
    hud(locked);
    A.raf = requestAnimationFrame(frame);
  }

  // 테스트·관제용 최소 노출 (값 변경 아님)
  window.ZRIDE_ARENA = Object.freeze({ state: () => ({ open: A.open, aim: A.aim, pitch: A.pitch, mode: A.mode }), setAim: a => { A.target = clampSector(norm(a)); }, setPitch: p => { A.targetPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, p)); } });
})();
