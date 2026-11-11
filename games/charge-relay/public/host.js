'use strict';
// 큰 화면(차량 화면·노트북). 방을 열고 QR을 보여 주고, 공개 순서를 진행한다.
(() => {
  const { h, paper, paint, replay, connect, post, store, secondsLeft } = window.Relay;
  const KEY = 'relay.host';
  const SOC_START = 30, SOC_TARGET = 80; // 시연용 값. 실제 차량 SOC를 받으면 gauge()만 바꾸면 된다.
  const $ = id => document.getElementById(id);
  const stage = $('stage');
  let session = null, net = null, state = null, viewKey = '', rounds = 3, timerEl = null, barEl = null;

  function gauge() {
    const done = !state || state.phase === 'LOBBY' ? 0 : state.phase === 'END' ? state.rounds
      : state.round - 1 + (state.phase === 'ROUND_END' ? 1 : 0);
    const soc = Math.round(SOC_START + (SOC_TARGET - SOC_START) * done / (state?.rounds || 1));
    $('gauge-fill').style.width = soc + '%';
    $('gauge-text').textContent = `충전 ${soc}% (시연값)`;
  }

  function button(text, className, onClick) { const b = h('button', className, text); b.type = 'button'; b.onclick = onClick; return b; }
  const send = message => net?.send(message);

  function seats() {
    const list = h('ul', 'seats');
    for (let i = 0; i < 4; i++) {
      const p = state.players[i], li = h('li', p ? 'seat on' : 'seat');
      li.append(h('b', '', p ? p.name : '빈자리'));
      if (p) {
        li.append(h('span', p.connected ? 'dot live' : 'dot', p.connected ? '접속 중' : '끊김'));
        li.append(button('내보내기', 'ghost small', () => send({ type: 'kick', playerId: p.id })));
      }
      list.append(li);
    }
    return list;
  }

  function lobby() {
    const wrap = h('section', 'lobby');
    const qrCard = h('div', 'card qr-card');
    qrCard.append(h('h2', '', '폰 카메라로 찍기'));
    const qr = h('div', 'qr'); qrCard.append(qr);
    qrCard.append(h('p', 'code', session.code));
    try { window.ZRideQR.renderSvg(qr, session.joinUrl); } catch { qr.textContent = 'QR을 그리지 못했어요'; }
    const side = h('div', 'card');
    side.append(h('h2', '', `가족 ${state.players.length} / 4`), seats());
    side.append(h('p', 'hint', '단어를 그리고 → 다음 사람이 맞히고 → 또 그려요. 마지막에 큰 화면에서 어디서 바뀌었는지 같이 봐요.'));
    const pick = h('div', 'pick');
    for (const [n, label] of [[2, '짧게 2판'], [3, '보통 3판'], [5, '길게 5판']]) {
      pick.append(button(label, n === rounds ? 'chip on' : 'chip', () => { rounds = n; viewKey = ''; render(); }));
    }
    side.append(pick);
    const start = button(state.players.length < 2 ? '2명부터 시작할 수 있어요' : '시작하기', 'primary big', () => send({ type: 'start', rounds }));
    start.disabled = state.players.length < 2;
    side.append(start);
    wrap.append(qrCard, side);
    return wrap;
  }

  function playing() {
    const wrap = h('section', 'play card');
    const draw = state.stepKind === 'DRAW';
    wrap.append(h('p', 'eyebrow', `${state.round}판 · ${state.step + 1} / ${state.steps}칸`));
    wrap.append(h('h2', 'huge', draw ? '모두 그리는 중' : '모두 맞히는 중'));
    wrap.append(h('p', 'hint', '정답은 큰 화면에 나오지 않아요. 폰을 가리고 하세요!'));
    const bar = h('div', 'bar'); barEl = h('div', 'bar-fill'); bar.append(barEl); wrap.append(bar);
    timerEl = h('p', 'timer'); wrap.append(timerEl);
    const list = h('ul', 'done-list');
    for (const p of state.players) {
      const li = h('li', p.done ? 'done' : '');
      li.append(h('b', '', p.name), h('span', '', p.done ? '다 했어요' : p.connected ? '하는 중' : '끊김'));
      list.append(li);
    }
    wrap.append(list);
    wrap.append(button('지금 넘기기', 'ghost', () => send({ type: 'skip' })));
    tick();
    return wrap;
  }

  function entryCard(entry, animate) {
    const card = h('figure', 'entry' + (animate ? ' fresh' : ''));
    if (entry.kind === 'DRAW') {
      const canvas = paper(); card.append(canvas);
      if (animate) requestAnimationFrame(() => replay(canvas, entry.drawing)); else paint(canvas, entry.drawing);
      if (!entry.drawing.strokes.length) card.append(h('p', 'empty', '시간 안에 못 그렸어요'));
    } else card.append(h('p', 'guess', entry.text));
    const cap = h('figcaption', '', entry.author + (entry.kind === 'DRAW' ? '의 그림' : '의 답'));
    const heart = h('span', 'heart', entry.hearts ? '♥ ' + entry.hearts : ''); cap.append(heart);
    card.append(cap);
    return card;
  }

  function reveal() {
    const r = state.reveal, wrap = h('section', 'reveal');
    const head = h('div', 'reveal-head');
    head.append(h('p', 'eyebrow', `스케치북 ${r.book + 1} / ${r.books}`));
    const word = h('p', 'word'); word.append(h('small', '', '처음 단어'), h('b', '', r.word)); head.append(word);
    wrap.append(head);
    const strip = h('div', 'strip');
    r.entries.forEach((e, i) => strip.append(entryCard(e, i === r.entries.length - 1)));
    if (!r.entries.length) strip.append(h('p', 'hint big-hint', '이 단어가 어떻게 바뀌었을까요?'));
    wrap.append(strip);
    if (r.complete) wrap.append(h('p', r.matched ? 'verdict win' : 'verdict', r.matched ? '전달 성공! ⚡' : '어디서 바뀌었을까요?'));
    const last = r.complete && r.book + 1 === r.books;
    wrap.append(button(r.complete ? (last ? '이번 판 결과' : '다음 스케치북') : '다음 칸 보기', 'primary big', () => send({ type: 'next' })));
    return wrap;
  }

  function ranking() {
    const list = h('ol', 'rank');
    for (const p of [...state.players].sort((a, b) => b.hearts - a.hearts)) {
      const li = h('li'); li.append(h('b', '', p.name), h('span', 'heart', '♥ ' + p.hearts)); list.append(li);
    }
    return list;
  }

  function roundEnd() {
    const wrap = h('section', 'play card'), last = state.round >= state.rounds;
    wrap.append(h('p', 'eyebrow', `${state.round}판 끝`));
    wrap.append(h('h2', 'huge', `전달 성공 ${state.family.success} / ${state.family.total}`));
    wrap.append(ranking());
    wrap.append(button(last ? '최종 결과' : '다음 판', 'primary big', () => send({ type: 'next' })));
    return wrap;
  }

  function finished() {
    const wrap = h('section', 'play card');
    const top = Math.max(...state.players.map(p => p.hearts));
    const stars = state.players.filter(p => p.hearts === top && top > 0).map(p => p.name);
    wrap.append(h('p', 'eyebrow', '충전 끝!'));
    wrap.append(h('h2', 'huge', stars.length ? `오늘의 화가 ${stars.join(' · ')}` : '다 같이 수고했어요'));
    wrap.append(h('p', 'hint', `우리 가족 전달 성공 ${state.family.success} / ${state.family.total}`));
    wrap.append(ranking());
    wrap.append(button('한 번 더', 'primary big', () => send({ type: 'next' })));
    return wrap;
  }

  function render() {
    if (!state) return;
    gauge();
    const r = state.reveal;
    const key = state.phase === 'LOBBY' ? 'L' + JSON.stringify(state.players) + rounds
      : state.phase === 'PLAY' ? `P${state.round}:${state.step}:` + JSON.stringify(state.players.map(p => [p.done, p.connected]))
      : state.phase === 'REVEAL' ? `R${state.round}:${r.book}:${r.shown}` : state.phase + state.round + JSON.stringify(state.players.map(p => p.hearts));
    if (key === viewKey) {
      // 공개 중에 하트만 늘면 그림을 다시 그리지 않는다
      if (r) stage.querySelectorAll('.entry .heart').forEach((el, i) => { el.textContent = r.entries[i]?.hearts ? '♥ ' + r.entries[i].hearts : ''; });
      return;
    }
    viewKey = key; timerEl = barEl = null;
    const view = { LOBBY: lobby, PLAY: playing, REVEAL: reveal, ROUND_END: roundEnd, END: finished }[state.phase]();
    stage.replaceChildren(view);
  }

  function tick() {
    if (!timerEl || state?.phase !== 'PLAY') return;
    const left = secondsLeft(state.deadline), total = state.stepKind === 'DRAW' ? 75 : 35;
    timerEl.textContent = left + '초';
    timerEl.classList.toggle('warn', left <= 10);
    barEl.style.width = Math.min(100, left / total * 100) + '%';
  }
  setInterval(tick, 250);

  function link(value) {
    $('link').textContent = value === 'LIVE' ? '' : value === 'RETRYING' ? '다시 연결 중…' : '연결 중…';
  }

  async function open(fresh) {
    session = fresh ? null : store.get(KEY);
    if (!session) {
      try { session = await post('/api/rooms'); store.set(KEY, session); }
      catch { stage.replaceChildren(h('p', 'hint', '서버에 연결할 수 없어요. 새로고침해 주세요.')); return; }
    }
    net = connect({
      code: session.code, token: session.hostToken, onLink: link,
      onState: value => { state = value; render(); },
      onError: code => { if (code === 'NEED_PLAYERS') link('RETRYING'); },
      onGone: code => { if (code === 4409) { stage.replaceChildren(h('p', 'hint', '다른 화면에서 이 방을 열었어요.')); return; } store.drop(KEY); viewKey = ''; open(true); },
    });
  }
  open(false);
})();
