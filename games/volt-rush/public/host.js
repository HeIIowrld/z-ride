'use strict';
// 큰 화면(차량 화면). 방을 열고 QR을 보여 주고, 판 위에 각자 깐 선과 충전기를 그린다.
(() => {
  const { h, COLOR, avatar, connect, post, store, secondsLeft, tip, sync, serverNow } = window.Volt;
  const KEY = 'volt.host';
  const $ = id => document.getElementById(id);
  const stage = $('stage');
  let session = null, net = null, state = null, viewKey = '', live = null;

  // Z-RIDE 차량 SDK. Pleos 허브 앱 안이면 실제 차 신호가 오고, ?mockcar면 가짜 차 패널이 뜬다
  const car = ZRide.car;
  const withCar = car.inCar || car.mocked;
  let signal = null, lastLight = '', sentSoc = null;
  car.on('signal', value => { signal = value; cover(); reportSoc(); });
  function cover() {
    const blocked = withCar && !signal?.parked;
    $('cover').hidden = !blocked;
    $('cover').firstElementChild.innerHTML = signal ? '주행 중에는 게임을 가려요.<br>P에 두면 다시 보여요.' : '차량 상태를 확인하는 중…';
  }
  /** 배터리 값이 바뀌면 서버에 알린다. 서버가 로비에서 ⚡ 예산을 정한다. */
  function reportSoc(target) {
    if (!signal || !Number.isFinite(signal.soc)) return;
    if (signal.soc === sentSoc && target == null) return;
    if (net?.send({ type: 'soc', soc: signal.soc, ...(target ? { target } : {}) })) sentSoc = signal.soc;
  }
  function cabin(light, air) {
    if (!withCar) return;
    const key = light + (air ?? '');
    if (key === lastLight && !air) return;
    lastLight = key;
    car.setCabin(air ? { light, air } : { light });
  }

  const button = (text, className, onClick) => { const b = h('button', className, text); b.type = 'button'; b.onclick = onClick; return b; };
  const send = message => net?.send(message);
  const byId = id => state.players.find(p => p.id === id);

  function lobby() {
    const wrap = h('section', 'lobby');
    const qrCard = h('div', 'card qr-card');
    qrCard.append(h('h2', '', '폰 카메라로 찍어서 참가'));
    const qr = h('div', 'qr'); qrCard.append(qr);
    qrCard.append(h('p', 'code', session.code), h('p', 'hint', '앱 설치 없이 이름만 쓰면 돼요'));
    try { window.ZRideQR.renderSvg(qr, session.joinUrl); } catch { qr.textContent = 'QR을 그리지 못했어요'; }

    const side = h('div', 'card lobby-side');
    side.append(h('p', 'lead', '각자 모서리에서 출발해 선을 깔며 가운데 충전기에 먼저 닿으면 이겨요. 지나간 길은 벽이 돼요. 3판!'));
    const list = h('ul', 'members');
    for (const p of state.players) {
      const li = h('li', p.connected ? '' : 'off');
      li.append(avatar(p), h('b', '', p.name), h('small', 'taps', COLOR[p.color].name), button('내보내기', 'ghost small', () => send({ type: 'kick', playerId: p.id })));
      list.append(li);
    }
    for (let i = state.players.length; i < 4; i++) list.append(h('li', 'empty', '빈자리'));
    side.append(list);

    const goal = h('div', 'goal');
    goal.append(h('span', 'hint', '목표 충전'));
    for (const t of [70, 80, 90]) goal.append(button(`${t}%`, t === state.target ? 'primary small' : 'ghost small', () => send({ type: 'soc', soc: signal?.soc ?? state.soc ?? 40, target: t })));
    side.append(goal);
    side.append(tip(state.soc != null
      ? `지금 배터리 ${state.soc}% → 목표 ${state.target}%. 충전할 양만큼 각자 ⚡${state.budget}로 시작해요.`
      : `배터리 정보가 없어 기본 ⚡${state.budget}로 시작해요.`));
    const start = button(state.players.length < 2 ? '2명부터 시작할 수 있어요' : '시작하기', 'primary big', () => send({ type: 'start' }));
    start.disabled = state.players.length < 2;
    side.append(start);
    wrap.append(qrCard, side);
    return wrap;
  }

  function arena() {
    const wrap = h('section', 'arena-v');
    const board = h('div', 'board');
    const canvas = h('canvas'); board.append(canvas);
    const banner = h('p', 'banner');
    const left = h('div', 'board-col'); left.append(board, banner);
    const side = h('aside', 'side');
    const head = h('div', 'side-head');
    const round = h('b', 'round'), timer = h('b', 'timer');
    head.append(round, timer);
    const rows = h('ul', 'roster');
    for (const p of state.players) {
      const li = h('li'); li.dataset.id = p.id;
      const top = h('div', 'r-top'); const energy = h('b', 'r-energy'); const note = h('small', 'r-note');
      top.append(avatar(p), h('span', 'r-name', p.name), energy);
      const bar = h('div', 'r-bar'); const fill = h('div', `r-fill c-${p.color.toLowerCase()}`); bar.append(fill);
      const pips = h('div', 'wins');
      for (let i = 0; i < state.rounds; i++) pips.append(h('span', `pip c-${p.color.toLowerCase()}` + (i < p.score ? ' on' : '')));
      li.append(top, bar, pips, note);
      li.live = { energy, fill, note };
      rows.append(li);
    }
    side.append(head, rows);
    if (state.phase === 'ROUND_END') side.append(button('바로 다음 판', 'ghost small', () => send({ type: 'next' })));
    wrap.append(left, side);
    live = { canvas, banner, round, timer, rows };
    paint();
    return wrap;
  }

  /** 판 그리기. 자주 바뀌는 값(위치·⚡·시간)은 이 함수만 다시 부른다. */
  function paint() {
    if (!live || !state) return;
    const { canvas } = live;
    const box = canvas.parentElement.getBoundingClientRect();
    const cell = Math.floor(Math.min(box.width / state.w, box.height / state.h));
    if (cell <= 0) return;
    const dpr = window.devicePixelRatio || 1, cw = cell * state.w, ch = cell * state.h;
    if (canvas.width !== cw * dpr) { canvas.width = cw * dpr; canvas.height = ch * dpr; canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px'; }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    g.fillStyle = '#0b0f18'; g.fillRect(0, 0, cw, ch);
    g.strokeStyle = '#1d2536'; g.lineWidth = 1;
    for (let x = 0; x <= state.w; x++) { g.beginPath(); g.moveTo(x * cell + .5, 0); g.lineTo(x * cell + .5, ch); g.stroke(); }
    for (let y = 0; y <= state.h; y++) { g.beginPath(); g.moveTo(0, y * cell + .5); g.lineTo(cw, y * cell + .5); g.stroke(); }
    const cx = i => (i % state.w) * cell + cell / 2, cy = i => Math.floor(i / state.w) * cell + cell / 2;

    // 공사 바리케이드
    for (const i of state.walls) {
      const x = (i % state.w) * cell + 3, y = Math.floor(i / state.w) * cell + 3, s = cell - 6;
      g.fillStyle = '#ff8a1f'; g.fillRect(x, y, s, s);
      g.save(); g.beginPath(); g.rect(x, y, s, s); g.clip();
      g.strokeStyle = '#fff'; g.lineWidth = s / 6;
      for (let k = -s; k < s * 2; k += s / 2.5) { g.beginPath(); g.moveTo(x + k, y); g.lineTo(x + k - s, y + s); g.stroke(); }
      g.restore();
    }
    // 번개 모양
    const bolt = (bx, by, k, color) => {
      g.fillStyle = color; g.beginPath();
      g.moveTo(bx + 2 * k, by - 8 * k); g.lineTo(bx - 5 * k, by + 1 * k); g.lineTo(bx - .5 * k, by + 1 * k); g.lineTo(bx - 2 * k, by + 8 * k); g.lineTo(bx + 5 * k, by - 1 * k); g.lineTo(bx + .5 * k, by - 1 * k); g.closePath(); g.fill();
    };
    g.textAlign = 'center'; g.textBaseline = 'middle';
    // ⚡ 셀
    for (const i of state.bolts) { g.fillStyle = 'rgba(255,210,63,.22)'; g.beginPath(); g.arc(cx(i), cy(i), cell * .34, 0, 7); g.fill(); bolt(cx(i), cy(i), cell / 30, '#ffd23f'); }
    // 충전기
    const ci = state.charger.y * state.w + state.charger.x, r = cell * .42;
    g.fillStyle = '#ffd23f'; g.shadowColor = '#ffd23f'; g.shadowBlur = 18;
    g.beginPath(); g.roundRect(cx(ci) - r, cy(ci) - r, r * 2, r * 2, r * .35); g.fill(); g.shadowBlur = 0;
    bolt(cx(ci), cy(ci), r / 10, '#1a1a1a');

    for (const p of state.players) {
      const hex = COLOR[p.color].hex;
      // 가장 짧은 길(신호 다트)
      if (p.scan) {
        g.strokeStyle = hex; g.lineWidth = 3; g.setLineDash([6, 6]); g.beginPath();
        p.scan.forEach((c, n) => (n ? g.lineTo(cx(c), cy(c)) : g.moveTo(cx(c), cy(c)))); g.stroke(); g.setLineDash([]);
      }
      // 선: 이웃한 두 칸끼리만 잇는다(끊긴 칸·점프 자리는 비워 둔다)
      g.strokeStyle = hex; g.lineWidth = cell * .34; g.lineCap = 'round'; g.lineJoin = 'round';
      g.shadowColor = hex; g.shadowBlur = 12;
      for (let n = 0; n < p.trail.length; n++) {
        const a = p.trail[n], b = p.trail[n + 1];
        if (a == null) continue;
        const near = b != null && Math.abs((a % state.w) - (b % state.w)) + Math.abs(Math.floor(a / state.w) - Math.floor(b / state.w)) === 1;
        g.beginPath(); g.moveTo(cx(a), cy(a)); g.lineTo(near ? cx(b) : cx(a), near ? cy(b) : cy(a)); g.stroke();
      }
      g.shadowBlur = 0;
      const hx = p.x * cell + cell / 2, hy = p.y * cell + cell / 2;
      g.fillStyle = p.stuck ? '#55607a' : hex; g.beginPath(); g.arc(hx, hy, cell * .32, 0, 7); g.fill();
      if (p.shield) { g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.arc(hx, hy, cell * .44, 0, 7); g.stroke(); }
      g.fillStyle = p.color === 'PINK' || p.color === 'BLUE' ? '#fff' : '#111';
      g.font = `800 ${Math.round(cell * .3)}px sans-serif`; g.fillText([...p.name][0] ?? '', hx, hy + 1);
    }

    const ev = state.event && state.event.until > serverNow() ? state.event : null;
    if (ev?.kind === 'BLACKOUT') {
      g.fillStyle = 'rgba(2,3,6,.93)'; g.fillRect(0, 0, cw, ch);
      g.fillStyle = '#ffd23f'; g.font = `800 ${Math.round(cell * .7)}px sans-serif`; g.fillText('정전! 판이 안 보여요', cw / 2, ch / 2);
    }

    // 옆 칸
    for (const li of live.rows.children) {
      const p = byId(li.dataset.id); if (!p) continue;
      li.live.energy.textContent = `⚡${p.energy}`;
      li.live.fill.style.width = Math.min(100, Math.round(p.energy / Math.max(1, state.budget) * 100)) + '%';
      li.live.note.textContent = p.stuck ? '막혔어요' : p.shield ? '방패 켜짐' : p.items ? `아이템 ${p.items}개` : '';
    }
    live.round.textContent = `${state.round}/${state.rounds}판`;
    const left = secondsLeft(state.deadline);
    live.timer.textContent = state.phase === 'PLAY' ? `${left}초` : '';
    live.timer.classList.toggle('warn', state.phase === 'PLAY' && left <= 10);
    live.banner.className = 'banner';
    if (state.phase === 'READY') live.banner.textContent = left > 0 ? `${left}… 폰의 방향 버튼을 준비하세요` : '출발!';
    else if (state.phase === 'ROUND_END') {
      const w = byId(state.roundWinner);
      live.banner.textContent = w ? `${w.name} 님이 충전기에 닿았어요! 다음 판 ${left}초 뒤` : `아무도 못 닿았어요. 다음 판 ${left}초 뒤`;
      live.banner.classList.add('win');
    } else if (ev) {
      live.banner.textContent = { SURGE: '⚡ 전력 서지! 모든 선이 사라졌어요', BOOST: `⚡ 무료 이동 ${secondsLeft(ev.until)}초!`, BLACKOUT: `⚡ 정전! ${secondsLeft(ev.until)}초` }[ev.kind];
      live.banner.classList.add('event');
    } else live.banner.textContent = '지나간 길은 벽이 돼요. 30초마다 전력 이벤트가 터져요!';
    lights(ev);
  }

  /** 실내등: 정전이면 끄고, 아니면 충전기에 가장 가까운 사람 색. */
  function lights(ev) {
    if (state.phase === 'ROUND_END') { const w = byId(state.roundWinner); if (w) cabin(COLOR[w.color].light, 'GUST'); return; }
    if (state.phase !== 'PLAY') return;
    if (ev?.kind === 'BLACKOUT') return cabin('OFF');
    const best = Math.min(...state.players.map(p => p.dist));
    const leaders = state.players.filter(p => p.dist === best);
    if (leaders.length === 1) cabin(COLOR[leaders[0].color].light);
  }

  function finished() {
    const wrap = h('section', 'card end');
    const winners = state.winners.map(byId).filter(Boolean);
    wrap.append(h('p', 'eyebrow', '3판 끝'), h('h2', 'huge', winners.length === 1 ? `${winners[0].name} 님 승리!` : '공동 승리!'));
    const ranking = h('ol', 'ranking');
    for (const p of [...state.players].sort((a, b) => b.score - a.score || b.energy - a.energy)) {
      const li = h('li'); li.append(avatar(p), h('b', '', p.name), h('span', '', `${p.score}승 · 남은 ⚡${p.energy}`)); ranking.append(li);
    }
    wrap.append(ranking, h('p', 'hint', '점수가 같으면 ⚡를 더 아낀 사람이 이겨요.'));
    const row = h('div', 'row');
    row.append(button('한 번 더', 'primary big', () => send({ type: 'start' })), button('대기실로', 'ghost', () => { cabin('NORMAL'); send({ type: 'lobby' }); }));
    wrap.append(row);
    if (winners[0]) cabin(COLOR[winners[0].color].light, 'GUST');
    return wrap;
  }

  function render() {
    if (!state) return;
    const key = state.phase + state.round + (state.phase === 'LOBBY' ? JSON.stringify([state.players.map(p => [p.id, p.connected]), state.target, state.soc, state.budget]) : '');
    if (key === viewKey) { paint(); return; }
    viewKey = key; live = null;
    if (state.phase === 'LOBBY') cabin('NORMAL');
    const view = state.phase === 'LOBBY' ? lobby() : state.phase === 'END' ? finished() : arena();
    stage.replaceChildren(view);
    if (live) requestAnimationFrame(paint);
  }
  setInterval(paint, 250);
  addEventListener('resize', () => { if (live) { live.canvas.width = 0; paint(); } });

  function link(value) { $('link').textContent = value === 'LIVE' ? '' : value === 'RETRYING' ? '다시 연결 중…' : '연결 중…'; }

  async function open(fresh) {
    session = fresh ? null : store.get(KEY);
    if (!session) {
      try { session = await post('/api/rooms'); store.set(KEY, session); }
      catch { stage.replaceChildren(h('p', 'hint', '서버에 연결할 수 없어요. 새로고침해 주세요.')); return; }
    }
    sentSoc = null;
    net = connect({
      code: session.code, token: session.hostToken,
      onLink: value => { link(value); if (value === 'LIVE') reportSoc(); },
      onState: value => { sync(value); state = value; render(); },
      onGone: code => { if (code === 4409) { stage.replaceChildren(h('p', 'hint', '다른 화면에서 이 방을 열었어요.')); return; } store.drop(KEY); viewKey = ''; open(true); },
    });
  }
  addEventListener('pagehide', () => { if (withCar) car.reset(); });
  cover();
  open(false);
})();
