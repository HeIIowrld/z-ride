'use strict';
// 큰 화면(차량 화면·노트북). 방을 열고 QR을 보여 주고, 공개 순서를 진행한다.
(() => {
  const { h, paper, paint, replay, connect, post, store, secondsLeft, avatar, person, tip, legs } = window.Relay;
  const kindOf = s => s % 2 === 0 ? 'DRAW' : 'GUESS';
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
      if (p) {
        li.append(avatar(state.players, p.id, 'lg'));
        const who = h('div', 'who'); who.append(h('b', '', p.name), h('span', p.connected ? 'dot live' : 'dot', p.connected ? '접속 중' : '끊김'));
        li.append(who, button('내보내기', 'ghost small', () => send({ type: 'kick', playerId: p.id })));
      } else li.append(h('span', 'empty-seat', '빈자리'));
      list.append(li);
    }
    return list;
  }

  function lobby() {
    const wrap = h('section', 'lobby');
    const qrCard = h('div', 'card qr-card');
    qrCard.append(h('h2', '', '폰 카메라로 찍어서 참가'));
    const qr = h('div', 'qr'); qrCard.append(qr);
    qrCard.append(h('p', 'code', session.code), h('p', 'hint', '앱 설치 없이 이름만 쓰면 돼요'));
    try { window.ZRideQR.renderSvg(qr, session.joinUrl); } catch { qr.textContent = 'QR을 그리지 못했어요'; }
    const side = h('div', 'card lobby-side');
    const head = h('div', 'side-head'); head.append(h('h2', '', '가족'), h('span', 'count', `${state.players.length} / 4`));
    side.append(head, seats());
    // 이어달리기 한눈에: 세 덩어리로만
    const how = h('ol', 'how');
    for (const [t, d] of [['그리기', '단어를 그림으로'], ['맞히기', '그림만 보고 단어로'], ['바통 넘기기', '옆 사람에게, 한 바퀴'], ['결승', '처음 단어가 살아남았나?']]) { const li = h('li'); li.append(h('b', '', t), h('span', '', d)); how.append(li); }
    side.append(how);
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
    const draw = state.stepKind === 'DRAW', last = state.step + 1 === state.steps;
    wrap.append(h('p', 'eyebrow', `${state.round}판 · ${last ? '결승 구간' : `${state.step + 1}구간`}`));
    wrap.append(legs(state.step, state.steps, kindOf));
    wrap.append(h('h2', 'huge', draw ? '모두 그리는 중' : '모두 맞히는 중'));
    wrap.append(h('p', 'hint', last ? '마지막 주자예요! 정답은 큰 화면에 나오지 않아요.' : '다 하면 바통이 옆 사람에게 넘어가요. 폰을 가리고 하세요!'));
    const bar = h('div', 'bar'); barEl = h('div', 'bar-fill'); bar.append(barEl); wrap.append(bar);
    timerEl = h('p', 'timer'); wrap.append(timerEl);
    const list = h('ul', 'people');
    for (const p of state.players) list.append(person(state.players, p, p.done ? '바통 넘김' : p.connected ? (draw ? '그리는 중' : '맞히는 중') : '끊김', p.done));
    wrap.append(list);
    if (state.round === 1 && state.step === 0) wrap.append(tip('글자나 숫자는 그리면 안 돼요. 그림만으로 전해요!'));
    wrap.append(button('지금 넘기기', 'ghost small', () => send({ type: 'skip' })));
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
    const cap = h('figcaption'); const by = h('span', 'by'); by.append(avatar(state.players, entry.authorId), h('span', '', entry.author + (entry.kind === 'DRAW' ? '의 그림' : '의 답'))); cap.append(by);
    const heart = h('span', 'heart', entry.hearts ? '♥ ' + entry.hearts : ''); cap.append(heart);
    card.append(cap);
    return card;
  }

  function reveal() {
    const r = state.reveal, wrap = h('section', 'reveal');
    const head = h('div', 'reveal-head');
    head.append(h('p', 'eyebrow', `바통 ${r.book + 1} / ${r.books} · 한 바퀴 다시 보기`));
    const word = h('p', 'word'); word.append(h('small', '', '처음 단어'), h('b', '', r.word)); head.append(word);
    wrap.append(head);
    const strip = h('div', 'strip');
    r.entries.forEach((e, i) => {
      if (i) strip.append(h('span', 'pass', '→'));
      const card = entryCard(e, i === r.entries.length - 1);
      card.prepend(h('small', 'leg', i + 1 === state.steps ? '결승' : `${i + 1}구간`));
      strip.append(card);
    });
    if (!r.entries.length) {
      const start = h('div', 'start-card'); start.append(h('small', '', '출발 단어'), h('b', '', r.word), h('p', 'hint', '이 단어가 한 바퀴 돌고 어떻게 바뀌었을까요?'));
      strip.append(start);
    }
    wrap.append(strip);
    if (r.complete) wrap.append(h('p', r.matched ? 'verdict win' : 'verdict', r.matched ? '결승 통과! 처음 단어 그대로 ⚡' : '어디서 바뀌었을까요?'));
    const last = r.complete && r.book + 1 === r.books;
    wrap.append(button(r.complete ? (last ? '이번 판 결과' : '다음 스케치북') : '다음 칸 보기', 'primary big', () => send({ type: 'next' })));
    return wrap;
  }

  function ranking() {
    const list = h('ol', 'rank');
    for (const p of [...state.players].sort((a, b) => b.hearts - a.hearts)) {
      const li = h('li'); const who = h('span', 'by'); who.append(avatar(state.players, p.id), h('b', '', p.name)); li.append(who, h('span', 'heart', '♥ ' + p.hearts)); list.append(li);
    }
    return list;
  }

  function roundEnd() {
    const wrap = h('section', 'play card'), last = state.round >= state.rounds;
    wrap.append(h('p', 'eyebrow', `${state.round}판 끝`));
    wrap.append(h('h2', 'huge', `결승 통과 ${state.family.success} / ${state.family.total}`), h('p', 'hint', '처음 단어 그대로 한 바퀴를 돈 바통 수'));
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
    wrap.append(h('p', 'hint', `우리 가족 결승 통과 ${state.family.success} / ${state.family.total}`));
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
