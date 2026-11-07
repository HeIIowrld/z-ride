'use strict';
// 폰. 세션은 localStorage에 둔다: 카메라가 여는 새 탭은 sessionStorage를 이어받지 못한다.
(() => {
  const { PALETTE, WIDTHS, h, paper, paint, replay, connect, post, store, secondsLeft } = window.Relay;
  const KEY = 'relay.phone', SKETCH_KEY = 'relay.sketch';
  const MAX_STROKES = 290, MAX_COORDS = 11_500;
  const ERR = {
    NO_ROOM: '방을 찾을 수 없어요. 코드를 다시 확인해 주세요.', ROOM_FULL: '네 자리가 모두 찼어요.',
    GAME_STARTED: '이미 게임이 시작됐어요. 다음 판에 같이 해요.', NAME_REQUIRED: '이름을 적어 주세요.', NETWORK: '서버에 연결할 수 없어요.',
  };
  const app = document.getElementById('app'), toast = document.getElementById('toast');
  let session = store.get(KEY), net = null, state = null, viewKey = '', timerEl = null;
  let sketch = null, pending = null; // sketch: 지금 그리는 칸. 재접속해도 유지한다.

  function say(text) { toast.textContent = text; toast.hidden = !text; }
  function button(text, className, onClick) { const b = h('button', className, text); b.type = 'button'; b.onclick = onClick; return b; }

  const hashCode = location.hash.slice(1).toUpperCase();
  const stripHash = () => { if (location.hash) history.replaceState(null, '', location.pathname); };
  stripHash();
  addEventListener('hashchange', stripHash); // 같은 탭에서 QR을 다시 열어도 주소에 코드를 남기지 않는다

  function joinView(message) {
    const form = h('form', 'card join');
    form.append(h('h1', 'logo', '충전 릴레이'));
    form.append(h('p', 'hint', message || '이름을 적고 들어오세요.'));
    const name = h('input'); name.placeholder = '이름 (예: 엄마)'; name.maxLength = 10; name.autocomplete = 'off'; name.required = true;
    const code = h('input'); code.placeholder = '방 코드 5자리'; code.maxLength = 5; code.value = hashCode; code.autocapitalize = 'characters'; code.autocomplete = 'off';
    if (hashCode) code.hidden = true;
    const go = h('button', 'primary big', '들어가기');
    form.append(name, code, go);
    form.onsubmit = async event => {
      event.preventDefault(); go.disabled = true; say('');
      try {
        const roomCode = code.value.trim().toUpperCase();
        session = await post(`/api/rooms/${encodeURIComponent(roomCode)}/join`, { name: name.value });
        store.set(KEY, session); start();
      } catch (e) { say(ERR[e.message] || ERR.NETWORK); go.disabled = false; }
    };
    app.replaceChildren(form);
    name.focus();
  }

  function timer() { timerEl = h('span', 'timer small-timer'); tick(); return timerEl; }

  function drawView(task) {
    const key = `${session.code}:${state.round}:${task.step}`;
    // 화면을 끄면 아이폰이 탭을 새로 불러올 수 있어서 그리던 칸을 저장해 둔다
    if (sketch?.key !== key) { const saved = store.get(SKETCH_KEY); sketch = saved?.key === key ? saved : { key, strokes: [], color: 0, width: 1 }; }
    const s = sketch, wrap = h('section', 'task');
    const head = h('div', 'task-head');
    const prompt = h('p', 'prompt'); prompt.append(h('small', '', task.step === 0 ? '이 단어를 그리세요' : '이 말을 그리세요'), h('b', '', task.prompt));
    head.append(prompt, timer()); wrap.append(head);
    const canvas = paper(); canvas.classList.add('pad'); wrap.append(canvas);
    const coords = () => s.strokes.reduce((n, x) => n + x.p.length, 0);
    const redraw = () => paint(canvas, { strokes: s.strokes });
    redraw();
    let active = null;
    const at = event => {
      const r = canvas.getBoundingClientRect();
      const clamp = v => Math.max(0, Math.min(1000, Math.round(v)));
      return [clamp((event.clientX - r.left) / r.width * 1000), clamp((event.clientY - r.top) / r.height * 1000)];
    };
    canvas.onpointerdown = event => {
      event.preventDefault();
      if (s.strokes.length >= MAX_STROKES || coords() >= MAX_COORDS) { say('종이가 꽉 찼어요. 지우거나 내 주세요.'); return; }
      canvas.setPointerCapture(event.pointerId);
      active = { c: s.color, w: s.width, p: at(event) }; s.strokes.push(active); redraw();
    };
    canvas.onpointermove = event => {
      if (!active || coords() >= MAX_COORDS) return;
      const [x, y] = at(event), n = active.p.length;
      if (Math.hypot(x - active.p[n - 2], y - active.p[n - 1]) < 6) return;
      active.p.push(x, y); redraw();
    };
    canvas.onpointerup = canvas.onpointercancel = () => { active = null; store.set(SKETCH_KEY, s); };
    const tools = h('div', 'tools');
    const swatches = PALETTE.map((color, i) => {
      const b = button('', 'swatch' + (i === s.color ? ' on' : ''), () => { s.color = i; swatches.forEach((x, j) => x.classList.toggle('on', j === i)); });
      b.style.background = color; b.setAttribute('aria-label', '색 ' + (i + 1)); return b;
    });
    const sizes = WIDTHS.map((_, i) => {
      const b = button(['얇게', '보통', '굵게'][i], 'chip small' + (i === s.width ? ' on' : ''), () => { s.width = i; sizes.forEach((x, j) => x.classList.toggle('on', j === i)); });
      return b;
    });
    const row = h('div', 'row'); row.append(...swatches);
    const row2 = h('div', 'row'); row2.append(...sizes,
      button('되돌리기', 'ghost small', () => { s.strokes.pop(); redraw(); store.set(SKETCH_KEY, s); }),
      button('지우기', 'ghost small', () => { s.strokes.length = 0; redraw(); store.set(SKETCH_KEY, s); }));
    tools.append(row, row2); wrap.append(tools);
    wrap.append(button('다 그렸어요', 'primary big', () => submit({ drawing: { strokes: s.strokes } })));
    return wrap;
  }

  function guessView(task) {
    const wrap = h('section', 'task');
    const head = h('div', 'task-head');
    const prompt = h('p', 'prompt'); prompt.append(h('small', '', '이 그림은 뭘까요?')); head.append(prompt, timer()); wrap.append(head);
    const canvas = paper(); wrap.append(canvas);
    requestAnimationFrame(() => replay(canvas, task.drawing, 1600));
    const form = h('form', 'guess-form');
    const input = h('input'); input.placeholder = '정답을 적어요'; input.maxLength = 30; input.autocomplete = 'off'; input.id = 'guess';
    form.append(input, h('button', 'primary big', '보내기'));
    form.onsubmit = event => { event.preventDefault(); submit({ text: input.value }); };
    wrap.append(form);
    return wrap;
  }

  function submit(content) {
    pending = { type: 'submit', step: state.step, round: state.round, ...content };
    flush();
  }
  function flush() {
    if (!pending || !state) return;
    if (state.phase !== 'PLAY' || pending.step !== state.step || pending.round !== state.round) { pending = null; return; }
    const { round, ...message } = pending;
    if (net?.send(message)) pending = null; else say('연결을 기다렸다가 보낼게요…');
  }

  function waitView(title, hint) {
    const wrap = h('section', 'card wait');
    wrap.append(h('h2', '', title));
    if (hint) wrap.append(h('p', 'hint', hint));
    if (state.phase === 'PLAY' || state.phase === 'LOBBY') {
      const list = h('ul', 'done-list');
      for (const p of state.players) {
        const li = h('li', p.done ? 'done' : '');
        li.append(h('b', '', p.name + (p.id === state.me ? ' (나)' : '')), h('span', '', state.phase === 'LOBBY' ? (p.connected ? '접속 중' : '끊김') : p.done ? '다 했어요' : '하는 중'));
        list.append(li);
      }
      wrap.append(list);
    }
    return wrap;
  }

  function revealView() {
    const r = state.reveal, wrap = h('section', 'task');
    const entry = r.entries.at(-1), index = r.entries.length - 1;
    wrap.append(h('p', 'eyebrow', `스케치북 ${r.book + 1} / ${r.books} · 처음 단어 "${r.word}"`));
    if (!entry) { wrap.append(h('h2', '', '큰 화면을 봐요!')); return wrap; }
    if (entry.kind === 'DRAW') { const c = paper(); wrap.append(c); requestAnimationFrame(() => replay(c, entry.drawing, 1600)); }
    else wrap.append(h('p', 'guess', entry.text));
    wrap.append(h('p', 'hint', entry.author + (entry.kind === 'DRAW' ? '의 그림' : '의 답')));
    if (entry.authorId !== state.me) {
      const b = button(entry.hearted ? '♥ 하트 보냈어요' : '♥ 이거 최고', 'heart-btn', () => { net?.send({ type: 'heart', index }); });
      b.disabled = entry.hearted; wrap.append(b);
    }
    if (r.complete) wrap.append(h('p', r.matched ? 'verdict win' : 'verdict', r.matched ? '전달 성공! ⚡' : '어디서 바뀌었을까요?'));
    return wrap;
  }

  function render() {
    if (!state) return;
    const r = state.reveal;
    const key = [state.phase, state.round, state.step, state.submitted, r?.book, r?.shown, r?.entries.at(-1)?.hearted,
      state.phase === 'PLAY' && state.submitted || state.phase === 'LOBBY' ? JSON.stringify(state.players.map(p => [p.name, p.done, p.connected])) : ''].join('|');
    if (key === viewKey) return;
    viewKey = key; timerEl = null; say('');
    let view;
    if (state.phase === 'LOBBY') view = waitView('곧 시작해요', '큰 화면에서 시작을 눌러 주세요.');
    else if (state.phase === 'PLAY') view = state.submitted || !state.task ? waitView('잘 냈어요!', '다른 가족을 기다리는 중이에요.')
      : state.task.kind === 'DRAW' ? drawView(state.task) : guessView(state.task);
    else if (state.phase === 'REVEAL') view = revealView();
    else if (state.phase === 'ROUND_END') view = waitView(`전달 성공 ${state.family.success} / ${state.family.total}`, '큰 화면을 봐요!');
    else view = waitView('충전 끝!', '수고했어요. 큰 화면에서 결과를 봐요.');
    app.replaceChildren(view);
  }

  function tick() {
    if (state?.phase !== 'PLAY' || state.submitted || !state.task) return;
    const left = secondsLeft(state.deadline);
    if (timerEl) { timerEl.textContent = left + '초'; timerEl.classList.toggle('warn', left <= 10); }
    // 시간이 끝나면 지금까지 그린 만큼 낸다
    if (left === 0 && !pending) {
      if (state.task.kind === 'DRAW') submit({ drawing: { strokes: sketch?.strokes ?? [] } });
      else submit({ text: document.getElementById('guess')?.value ?? '' });
    }
  }
  setInterval(tick, 250);

  function start() {
    if (!session) { joinView(); return; }
    app.replaceChildren(h('p', 'hint center', '연결 중…'));
    net = connect({
      code: session.code, token: session.token,
      onLink: value => { if (value === 'LIVE') { say(''); flush(); } else if (value === 'RETRYING') say('연결이 끊겨 다시 붙는 중…'); },
      onState: value => { state = value; render(); flush(); },
      onError: code => { if (code === 'STALE_STEP') pending = null; },
      onGone: code => {
        if (code === 4409) { say('다른 탭에서 이어서 하는 중이에요.'); return; }
        store.drop(KEY); session = null; state = null; viewKey = '';
        joinView('방이 닫혔어요. 큰 화면의 새 QR을 찍어 주세요.');
      },
    });
  }

  if (session && hashCode && session.code !== hashCode) { store.drop(KEY); session = null; }
  start();
})();
