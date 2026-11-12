'use strict';
// 큰 화면(차량 화면). 방을 열고 QR을 보여 주고, 가운데 전선 위로 전기가 어느 쪽으로 흐르는지 보여 준다.
(() => {
  const { h, TEAM, avatar, connect, post, store, secondsLeft, tip } = window.Tug;
  const KEY = 'tug.host';
  const $ = id => document.getElementById(id);
  const stage = $('stage');
  let session = null, net = null, state = null, viewKey = '', live = null;

  // Z-RIDE 차량 SDK. Pleos 허브 앱 안이면 실제 차 신호가 오고, ?mockcar면 가짜 차 패널이 뜬다
  const car = ZRide.car;
  const withCar = car.inCar || car.mocked;
  let signal = null, lastLight = '';
  car.on('signal', value => { signal = value; cover(); });
  function cover() {
    const blocked = withCar && !signal?.parked;
    $('cover').hidden = !blocked;
    $('cover').firstElementChild.innerHTML = signal ? '주행 중에는 게임을 가려요.<br>P에 두면 다시 보여요.' : '차량 상태를 확인하는 중…';
  }
  /** 실내등은 앞선 팀 색을 따라간다. 같은 값이면 다시 보내지 않는다. */
  function cabin(light, air) {
    if (!withCar) return;
    const key = light + (air ?? '');
    if (key === lastLight && !air) return;
    lastLight = key;
    car.setCabin(air ? { light, air } : { light });
  }

  const button = (text, className, onClick) => { const b = h('button', className, text); b.type = 'button'; b.onclick = onClick; return b; };
  const send = message => net?.send(message);
  const team = t => state.players.filter(p => p.team === t);
  const blueCharge = () => Math.round(50 - state.pos / 2); // 민트 배터리 %. 핑크은 100에서 뺀 값

  function lobby() {
    const wrap = h('section', 'lobby');
    const qrCard = h('div', 'card qr-card');
    qrCard.append(h('h2', '', '폰 카메라로 찍어서 참가'));
    const qr = h('div', 'qr'); qrCard.append(qr);
    qrCard.append(h('p', 'code', session.code), h('p', 'hint', '앱 설치 없이 이름만 쓰면 돼요'));
    try { window.ZRideQR.renderSvg(qr, session.joinUrl); } catch { qr.textContent = 'QR을 그리지 못했어요'; }

    const side = h('div', 'card lobby-side');
    side.append(h('p', 'lead', '폰을 연타해서 가운데 전기를 우리 팀 배터리로 끌어와요. 3판 중 2판 먼저!'));
    const teams = h('div', 'teams');
    for (const t of ['MINT', 'PINK']) {
      const box = h('div', `team-box ${t.toLowerCase()}`);
      box.append(h('h3', '', `${TEAM[t].name} 팀`));
      const list = h('ul', 'members');
      for (const p of team(t)) { const li = h('li', p.connected ? '' : 'off'); li.append(avatar(p), h('b', '', p.name)); li.append(button('내보내기', 'ghost small', () => send({ type: 'kick', playerId: p.id }))); list.append(li); }
      if (!team(t).length) list.append(h('li', 'empty', '아직 없어요'));
      box.append(list); teams.append(box);
    }
    side.append(teams);
    if (state.players.length >= 2) side.append(tip('팀은 폰에서 바꿀 수 있어요. 인원이 달라도 공평하게 계산해요.'));
    const row = h('div', 'row');
    row.append(button('팀 섞기', 'ghost', () => send({ type: 'shuffle' })));
    const ready = state.players.length >= 2 && team('MINT').length && team('PINK').length;
    const start = button(state.players.length < 2 ? '2명부터 시작할 수 있어요' : ready ? '시작하기' : '두 팀 모두 한 명 이상 있어야 해요', 'primary big', () => send({ type: 'start' }));
    start.disabled = !ready;
    row.append(start);
    side.append(row);
    wrap.append(qrCard, side);
    return wrap;
  }

  function battery(t) {
    const box = h('div', `battery ${t.toLowerCase()}`);
    const cell = h('div', 'cell'); const fill = h('div', 'fill'); cell.append(fill, h('span', 'cap'));
    const pct = h('b', 'pct');
    const members = h('ul', 'members compact');
    for (const p of team(t)) { const li = h('li'); li.append(avatar(p), h('span', '', p.name), h('small', 'taps', '')); li.dataset.id = p.id; members.append(li); }
    const wins = h('div', 'wins');
    for (let i = 0; i < 2; i++) wins.append(h('span', i < state.wins[t] ? 'pip on' : 'pip'));
    box.append(h('h3', '', `${TEAM[t].name} 팀`), wins, cell, pct, members);
    box.fill = fill; box.pct = pct; box.members = members;
    return box;
  }

  function arena() {
    const wrap = h('section', 'arena');
    const mint = battery('MINT'), pink = battery('PINK');
    const wire = h('div', 'wire');
    const spark = h('div', 'spark'); wire.append(h('span', 'line'), spark);
    const mid = h('div', 'mid');
    const title = h('p', 'round', `${state.round}판`);
    const big = h('p', 'huge');
    const timer = h('p', 'timer');
    mid.append(title, wire, big, timer);
    wrap.append(mint, mid, pink);
    if (state.round === 1 && state.phase === 'READY') wrap.append(tip('손가락 여러 개로 두드려도 돼요. 너무 빠른 연타(초당 16번 넘게)는 세지 않아요.'));
    live = { mint, pink, spark, big, timer, wrap };
    paint();
    return wrap;
  }

  /** 자주 바뀌는 값(줄 위치·시간·연타 수)만 고친다. */
  function paint() {
    if (!live || !state) return;
    const b = blueCharge();
    live.mint.fill.style.height = b + '%'; live.mint.pct.textContent = b + '%';
    live.pink.fill.style.height = (100 - b) + '%'; live.pink.pct.textContent = (100 - b) + '%';
    live.spark.style.left = (50 + state.pos / 2) + '%';
    live.spark.classList.toggle('to-mint', state.pos < 0); live.spark.classList.toggle('to-pink', state.pos > 0);
    for (const box of [live.mint, live.pink]) for (const li of box.members.children) {
      const p = state.players.find(x => x.id === li.dataset.id);
      li.querySelector('.taps').textContent = p ? `${p.taps}번` : '';
    }
    const left = secondsLeft(state.deadline);
    if (state.phase === 'READY') { live.big.textContent = left > 0 ? String(left) : '당겨!'; live.timer.textContent = '폰을 들고 준비!'; }
    else if (state.phase === 'PULL') {
      live.big.textContent = state.pos === 0 ? '팽팽해요' : `${TEAM[state.pos < 0 ? 'MINT' : 'PINK'].name} 쪽으로 흐르는 중`;
      live.timer.textContent = left + '초';
      live.timer.classList.toggle('warn', left <= 5);
      if (Math.abs(state.pos) >= 8) cabin(TEAM[state.pos < 0 ? 'MINT' : 'PINK'].light);
    }
  }

  function roundEnd() {
    const wrap = arena();
    const w = state.roundWinner;
    live.big.textContent = w ? `${TEAM[w].name} 팀이 전기를 가져갔어요!` : '무승부! 아무도 못 가져갔어요';
    live.timer.textContent = `다음 판 ${secondsLeft(state.deadline)}초 뒤`;
    wrap.append(button('바로 다음 판', 'ghost small', () => send({ type: 'next' })));
    if (w) cabin(TEAM[w].light, 'GUST');
    return wrap;
  }

  function finished() {
    const w = state.winner;
    const wrap = h('section', `card end ${w ? w.toLowerCase() : ''}`);
    wrap.append(h('p', 'eyebrow', w ? '최종 승리' : '5판 끝'), h('h2', 'huge', w ? `${TEAM[w].name} 팀!` : '무승부!'));
    wrap.append(h('p', 'lead', `${state.wins.MINT} : ${state.wins.PINK} · ` + (w ? `이번 충전 전기는 ${TEAM[w].name} 팀 몫이에요` : '전기를 사이좋게 나눠 가져요')));
    const best = [...state.players].sort((a, b) => b.total - a.total)[0];
    if (best) wrap.append(h('p', 'hint', `가장 많이 두드린 사람: ${best.name} (${best.total}번)`));
    const row = h('div', 'row');
    row.append(button('한 번 더', 'primary big', () => send({ type: 'start' })), button('팀 다시 짜기', 'ghost', () => { cabin('NORMAL'); send({ type: 'lobby' }); }));
    wrap.append(row);
    if (w) cabin(TEAM[w].light, 'GUST');
    return wrap;
  }

  function render() {
    if (!state) return;
    const key = state.phase + state.round + (state.phase === 'LOBBY' ? JSON.stringify(state.players.map(p => [p.id, p.team, p.connected])) : '');
    if (key === viewKey) { paint(); return; }
    viewKey = key; live = null;
    if (state.phase === 'LOBBY') cabin('NORMAL');
    const view = { LOBBY: lobby, READY: arena, PULL: arena, ROUND_END: roundEnd, END: finished }[state.phase]();
    stage.replaceChildren(view);
  }
  setInterval(() => {
    paint();
    if (state?.phase === 'ROUND_END' && live) live.timer.textContent = `다음 판 ${secondsLeft(state.deadline)}초 뒤`;
  }, 250);

  function link(value) { $('link').textContent = value === 'LIVE' ? '' : value === 'RETRYING' ? '다시 연결 중…' : '연결 중…'; }

  async function open(fresh) {
    session = fresh ? null : store.get(KEY);
    if (!session) {
      try { session = await post('/api/rooms'); store.set(KEY, session); }
      catch { stage.replaceChildren(h('p', 'hint', '서버에 연결할 수 없어요. 새로고침해 주세요.')); return; }
    }
    net = connect({
      code: session.code, token: session.hostToken, onLink: link,
      onState: value => { state = value; render(); },
      onGone: code => { if (code === 4409) { stage.replaceChildren(h('p', 'hint', '다른 화면에서 이 방을 열었어요.')); return; } store.drop(KEY); viewKey = ''; open(true); },
    });
  }
  addEventListener('pagehide', () => { if (withCar) car.reset(); });
  cover();
  open(false);
})();
