'use strict';
// 큰 화면(차량 화면). 방을 열고, 시작 전에 규칙을 보여 주고, 성 4개와 발전소·번개를 그린다.
(() => {
  const { h, COLOR, connect, post, store, secondsLeft, sync, serverNow, ICONS, icon } = window.Castle;
  const KEY = 'castle.host';
  const NS = 'http://www.w3.org/2000/svg';
  const $ = id => document.getElementById(id);
  const stage = $('stage');
  let session = null, net = null, state = null, viewKey = '', live = null, sentSoc = null;

  // Z-RIDE 차량 SDK. Pleos 허브 앱 안이면 실제 차 신호가 오고, ?mockcar면 가짜 차 패널이 뜬다
  const car = ZRide.car;
  const withCar = car.inCar || car.mocked;
  let signal = null, lastLight = '';
  car.on('signal', value => { signal = value; cover(); reportSoc(); });
  function cover() {
    const blocked = withCar && !signal?.parked;
    $('cover').hidden = !blocked;
    $('cover').firstElementChild.innerHTML = signal ? '주행 중에는 게임을 가려요.<br>P에 두면 다시 보여요.' : '차량 상태를 확인하는 중…';
  }
  function reportSoc() {
    if (!signal || !Number.isFinite(signal.soc) || signal.soc === sentSoc) return;
    if (net?.send({ type: 'soc', soc: signal.soc })) sentSoc = signal.soc;
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
  const label = text => h('p', 'label', text);

  // ── SVG 도구 ──
  function s(tag, attrs = {}, parent) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    parent?.append(el);
    return el;
  }
  const CASTLE = 'M-40 28 V-18 h12 v-12 h10 v12 h8 v-26 h20 v26 h8 v-12 h10 v12 h12 V28 Z';
  const SPOTS = [{ x: 160, y: 120 }, { x: 740, y: 120 }, { x: 160, y: 370 }, { x: 740, y: 370 }];
  const CORE = { x: 450, y: 245 };

  // ── 로비 ──
  function lobby() {
    const wrap = h('section', 'lobby');
    const qrCard = h('div', 'panel qr-card');
    qrCard.append(label('JOIN'), h('h2', '', '폰 카메라로 찍어서 참가'));
    const qr = h('div', 'qr'); qrCard.append(qr);
    qrCard.append(h('p', 'code', session.code), h('p', 'hint', '앱 설치 없이 이름만 쓰면 돼요'));
    try { window.ZRideQR.renderSvg(qr, session.joinUrl); } catch { qr.textContent = 'QR을 그리지 못했어요'; }

    const side = h('div', 'panel lobby-side');
    side.append(label('CASTLES'));
    const list = h('ul', 'roster');
    for (const p of state.players) {
      const li = h('li', p.connected ? '' : 'off');
      const dot = h('span', 'dot'); dot.style.background = COLOR[p.color].hex;
      li.append(dot, h('b', '', p.name), button('내보내기', 'ghost small', () => send({ type: 'kick', playerId: p.id })));
      list.append(li);
    }
    for (let i = state.players.length; i < 4; i++) list.append(h('li', 'empty', '빈 성'));
    side.append(list);
    side.append(h('p', 'hint', state.soc != null
      ? `배터리 ${state.soc}% → 목표 ${state.target}%. ${state.goal === 150 ? '오래 충전하는 날이라 전기 150을 채우는 긴 판이에요.' : '전기 100을 채우는 기본 판이에요.'}`
      : `전기 ${state.goal}을 먼저 채우는 성이 이겨요.`));
    const start = button(state.players.length < 2 ? '2명부터 시작할 수 있어요' : '규칙 보고 시작하기', 'primary big', () => send({ type: 'start' }));
    start.disabled = state.players.length < 2;
    side.append(start);
    wrap.append(qrCard, side);
    return wrap;
  }

  // ── 시작 전 규칙 화면 ──
  function rules() {
    const wrap = h('section', 'rules');
    const head = h('div', 'rules-head');
    head.append(label('HOW TO PLAY'), h('h2', '', `내 성에 전기 ${state.goal}을 먼저 채우면 이겨요`), h('p', 'hint', `3판 중 2판을 먼저 이기면 최종 승리. 한 판은 최대 3분이에요.`));
    const steps = h('ol', 'steps');
    const rows = [
      ['plug', '#3ef2ff', '케이블', String(state.cost.cable), '발전소에서 받는 전기가 늘어나요. 최대 3가닥. 일찍 늘릴수록 유리해요.'],
      ['bolt', '#ff3d9a', '끌어오기', String(state.cost.drain), '다른 성을 골라 전기 15를 빼 와요. 번개가 3초 동안 날아가요.'],
      ['shield', '#3ef2ff', '방패', String(state.cost.shield), '5초 동안 끌어오기를 막아요. 내 폰이 울리면 그때 눌러요!'],
      ['batt', '#a66bff', '과충전', String(state.cost.over), '10초 동안 받는 전기가 2배. 대신 그동안 방패를 못 써요.'],
    ];
    for (const [name, color, title, cost, text] of rows) {
      const li = h('li');
      const t = h('div', 'step-title'); t.append(h('b', '', title), h('span', 'cost', cost));
      li.append(icon(name, color, 44), t, h('p', '', text));
      steps.append(li);
    }
    const foot = h('div', 'rules-foot');
    const timer = h('p', 'hint');
    foot.append(h('p', 'tip', '1분 30초가 지나면 발전소 폭주! 10초 동안 전기가 3배로 나와요. 1등 성에는 왕관이 떠요.'), timer, button('바로 시작', 'primary', () => send({ type: 'skip' })));
    wrap.append(head, steps, foot);
    live = { rulesTimer: timer };
    return wrap;
  }

  // ── 경기 화면 ──
  function arena() {
    const wrap = h('section', 'arena');
    const top = h('div', 'hud');
    const round = h('p', 'label'), clock = h('p', 'clock'), goal = h('p', 'label');
    const mid = h('div', 'hud-mid'); mid.append(round, clock);
    goal.textContent = `GOAL ${state.goal}`;
    top.append(h('span'), mid, goal);
    const svg = s('svg', { viewBox: '0 0 900 470', class: 'board' });
    const defs = s('defs', {}, svg);
    const f = s('filter', { id: 'neon', x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
    s('feGaussianBlur', { stdDeviation: 3.2, result: 'b' }, f);
    const m = s('feMerge', {}, f); for (const n of ['b', 'b', 'SourceGraphic']) s('feMergeNode', { in: n }, m);
    const g = s('radialGradient', { id: 'core' }, defs);
    s('stop', { offset: 0, 'stop-color': '#e9dcff' }, g); s('stop', { offset: '.35', 'stop-color': '#a66bff' }, g); s('stop', { offset: 1, 'stop-color': '#a66bff', 'stop-opacity': 0 }, g);
    const layers = { cables: s('g', {}, svg), core: s('g', {}, svg), castles: s('g', {}, svg), bolts: s('g', {}, svg) };
    // 발전소
    s('circle', { cx: CORE.x, cy: CORE.y, r: 64, fill: 'url(#core)', opacity: .45 }, layers.core);
    s('path', { d: `M${CORE.x} ${CORE.y - 38} l33 19 v38 l-33 19 l-33 -19 v-38 z`, fill: '#1a1238', stroke: '#a66bff', 'stroke-width': 2, filter: 'url(#neon)' }, layers.core);
    s('path', { d: ICONS.bolt, transform: `translate(${CORE.x} ${CORE.y}) scale(1.15)`, fill: 'none', stroke: '#efeaff', 'stroke-width': 2.2, 'stroke-linejoin': 'round' }, layers.core);
    s('text', { x: CORE.x, y: CORE.y + 66, class: 'svg-label', 'text-anchor': 'middle' }, layers.core).textContent = 'GENERATOR';
    const banner = h('div', 'banner');
    wrap.append(top, svg, banner);
    live = { svg, layers, round, clock, banner };
    paint();
    return wrap;
  }

  function paint() {
    if (!state) return;
    if (state.phase === 'RULES' && live?.rulesTimer) { live.rulesTimer.textContent = `${secondsLeft(state.deadline)}초 뒤 시작해요`; return; }
    if (!live?.layers) return;
    const t = serverNow(), { layers } = live;
    live.round.textContent = `ROUND ${state.round}`;
    const left = secondsLeft(state.deadline);
    live.clock.textContent = state.phase === 'PLAY' ? `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}` : state.phase === 'READY' ? String(left || 'GO') : '';
    const lead = Math.max(...state.players.map(p => p.power));
    const leaders = state.players.filter(p => p.power === lead);

    layers.cables.replaceChildren(); layers.castles.replaceChildren(); layers.bolts.replaceChildren();
    state.players.forEach((p, i) => {
      const at = SPOTS[i], c = COLOR[p.color].hex;
      // 케이블: 가닥 수만큼 선. 성 안쪽 모서리에서 끝난다
      const ex = at.x + (at.x < CORE.x ? 42 : -42), ey = at.y + (at.y < CORE.y ? 22 : -22);
      for (let k = 0; k < p.cables; k++) {
        const o = (k - (p.cables - 1) / 2) * 8;
        s('line', { x1: CORE.x + (at.x < CORE.x ? -30 : 30), y1: CORE.y + o, x2: ex, y2: ey + o, stroke: c, 'stroke-width': 1.6, opacity: .85, 'stroke-linecap': 'round' }, layers.cables);
      }
      // 흐르는 전기 점
      const ph = ((t / (state.surge ? 400 : 1200)) + i * .25) % 1;
      s('circle', { cx: CORE.x + (ex - CORE.x) * ph, cy: CORE.y + (ey - CORE.y) * ph, r: 2.6, fill: c, filter: 'url(#neon)' }, layers.cables);
      // 성
      const g = s('g', { transform: `translate(${at.x} ${at.y})`, stroke: c, fill: c }, layers.castles);
      s('path', { d: CASTLE, 'fill-opacity': p.overUntil ? .35 : .1, 'stroke-width': 2, 'stroke-linejoin': 'round', filter: 'url(#neon)' }, g);
      s('path', { d: 'M-9 28 v-13 a9 9 0 0 1 18 0 v13', fill: 'none', 'stroke-width': 2 }, g);
      if (p.shieldUntil) s('circle', { r: 62, cy: -4, fill: c, 'fill-opacity': .05, 'stroke-width': 1.4, 'stroke-dasharray': '3 5' }, g);
      if (leaders.length === 1 && leaders[0].id === p.id && state.phase === 'PLAY') s('path', { d: ICONS.crown, transform: 'translate(0 -58)', fill: 'none', 'stroke-width': 2, filter: 'url(#neon)' }, g);
      // 이름·숫자·분할 게이지
      const ly = at.y + 52, lx = at.x - 52;
      s('text', { x: lx, y: ly, class: 'svg-name', fill: COLOR[p.color].soft }, layers.castles).textContent = p.name;
      s('text', { x: lx + 104, y: ly + 2, class: 'svg-num', 'text-anchor': 'end' }, layers.castles).textContent = p.power;
      const filled = Math.round(Math.min(1, p.power / state.goal) * 10);
      for (let k = 0; k < 10; k++) s('rect', { x: lx + k * 10.5, y: ly + 10, width: 8, height: 4, fill: k < filled ? c : '#2a2350' }, layers.castles);
      if (p.overUntil) s('text', { x: at.x, y: at.y - 40, class: 'svg-label', fill: '#c9a6ff', 'text-anchor': 'middle' }, layers.castles).textContent = 'OVERCHARGE';
    });
    // 번개: 출발 성에서 도착 성으로 3초 동안 날아간다
    for (const b of state.bolts) {
      const a = SPOTS[state.players.findIndex(p => p.id === b.from)], z = SPOTS[state.players.findIndex(p => p.id === b.to)];
      if (!a || !z) continue;
      const k = Math.max(0, Math.min(1, 1 - (b.arriveAt - t) / 3000));
      const pts = [];
      for (let n = 0; n <= 8; n++) {
        const u = (n / 8) * k, j = n === 0 || n === 8 ? 0 : (n % 2 ? 12 : -12);
        pts.push(`${a.x + (z.x - a.x) * u + j * .4},${a.y - 10 + (z.y - a.y) * u + j}`);
      }
      const color = COLOR[byId(b.from)?.color]?.hex ?? '#fff';
      s('polyline', { points: pts.join(' '), fill: 'none', stroke: color, 'stroke-width': 2.4, 'stroke-linejoin': 'round', filter: 'url(#neon)' }, layers.bolts);
      const [hx, hy] = pts.at(-1).split(',');
      s('circle', { cx: hx, cy: hy, r: 4, fill: '#fff', filter: 'url(#neon)' }, layers.bolts);
    }
    // 아래 띠
    const b = live.banner;
    if (state.phase === 'READY') b.textContent = '곧 시작해요. 폰을 들어 주세요!';
    else if (state.phase === 'ROUND_END') { const w = byId(state.roundWinner); b.textContent = w ? `${w.name} 성 완충! 다음 판 ${left}초 뒤` : `무승부예요. 다음 판 ${left}초 뒤`; }
    else if (state.surge) b.textContent = 'SURGE · 발전소 폭주! 전기가 3배로 나와요';
    else if (state.surgeAt && state.surgeAt > t) b.textContent = `발전소 폭주까지 ${Math.ceil((state.surgeAt - t) / 1000)}초`;
    else b.textContent = '먼저 채우는 성이 이겨요';
    b.classList.toggle('hot', !!state.surge);
    lights();
  }

  function lights() {
    if (state.phase === 'ROUND_END') { const w = byId(state.roundWinner); if (w) cabin(COLOR[w.color].light, 'GUST'); return; }
    if (state.phase !== 'PLAY') return;
    const top = Math.max(...state.players.map(p => p.power));
    const leaders = state.players.filter(p => p.power === top);
    if (leaders.length === 1) cabin(COLOR[leaders[0].color].light);
  }

  function finished() {
    const wrap = h('section', 'panel end');
    const winners = state.winners.map(byId).filter(Boolean);
    wrap.append(label('FINAL'), h('h2', 'huge', winners.length === 1 ? `${winners[0].name} 성 승리!` : '공동 승리!'));
    const list = h('ol', 'ranking');
    for (const p of [...state.players].sort((a, b) => b.wins - a.wins)) {
      const li = h('li'); const dot = h('span', 'dot'); dot.style.background = COLOR[p.color].hex;
      li.append(dot, h('b', '', p.name), h('span', '', `${p.wins}승`)); list.append(li);
    }
    const row = h('div', 'row');
    row.append(button('한 번 더', 'primary big', () => send({ type: 'start' })), button('대기실로', 'ghost', () => { cabin('NORMAL'); send({ type: 'lobby' }); }));
    wrap.append(list, row);
    if (winners[0]) cabin(COLOR[winners[0].color].light, 'GUST');
    return wrap;
  }

  function render() {
    if (!state) return;
    const key = state.phase + state.round + (state.phase === 'LOBBY' ? JSON.stringify([state.players.map(p => [p.id, p.connected]), state.goal, state.soc]) : '');
    if (key === viewKey) { paint(); return; }
    viewKey = key; live = null;
    if (state.phase === 'LOBBY') cabin('NORMAL');
    const view = { LOBBY: lobby, RULES: rules, END: finished }[state.phase]?.() ?? arena();
    stage.replaceChildren(view);
    paint();
  }
  // 번개·전기 점이 움직이도록 1초에 10번 다시 그린다
  setInterval(() => { if (state && (state.phase === 'PLAY' || state.phase === 'RULES' || state.phase === 'READY' || state.phase === 'ROUND_END')) paint(); }, 100);

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
