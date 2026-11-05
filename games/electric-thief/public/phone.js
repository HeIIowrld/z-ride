'use strict';
// 폰. 역할·손패·단서는 여기에만 보인다. 세션은 localStorage(카메라가 여는 새 탭 대응).
(() => {
  const { h, connect, post, store, secondsLeft } = window.Relay;
  const KEY = 'thief.phone';
  const ERR = {
    NO_ROOM: '방을 찾을 수 없어요. 코드를 다시 확인해 주세요.', ROOM_FULL: '네 자리가 모두 찼어요.',
    GAME_STARTED: '이미 게임이 시작됐어요. 다음 판에 같이 해요.', NAME_REQUIRED: '이름을 적어 주세요.', NETWORK: '서버에 연결할 수 없어요.',
  };
  const INSPECT = [['LIGHT', '조명 점검'], ['CLIMATE', '공조 점검'], ['BATTERY', '배터리 점검']];
  const app = document.getElementById('app'), toast = document.getElementById('toast');
  let session = store.get(KEY), net = null, state = null, viewKey = '', timerEl = null;
  let choice = { card: null, inspect: null };

  const say = text => { toast.textContent = text; toast.hidden = !text; };
  const button = (text, className, onClick) => { const b = h('button', className, text); b.type = 'button'; b.onclick = onClick; return b; };
  const hashCode = location.hash.slice(1).toUpperCase();
  const stripHash = () => { if (location.hash) history.replaceState(null, '', location.pathname); };
  stripHash();
  addEventListener('hashchange', stripHash);

  function joinView(message) {
    const form = h('form', 'card join');
    form.append(h('h1', 'logo', '전기 도둑'), h('p', 'hint', message || '이름을 적고 들어오세요.'));
    const name = h('input'); name.placeholder = '이름 (예: 엄마)'; name.maxLength = 10; name.autocomplete = 'off'; name.required = true;
    const code = h('input'); code.placeholder = '방 코드 5자리'; code.maxLength = 5; code.value = hashCode; code.autocomplete = 'off';
    if (hashCode) code.hidden = true;
    const go = h('button', 'primary big', '들어가기');
    form.append(name, code, go);
    form.onsubmit = async event => {
      event.preventDefault(); go.disabled = true; say('');
      try {
        session = await post(`/api/rooms/${encodeURIComponent(code.value.trim().toUpperCase())}/join`, { name: name.value });
        store.set(KEY, session); start();
      } catch (e) { say(ERR[e.message] || ERR.NETWORK); go.disabled = false; }
    };
    app.replaceChildren(form);
  }

  /** 옆 사람이 못 보게, 누르고 있는 동안만 역할을 보여 준다. */
  function roleCard() {
    const thief = state.role === 'THIEF';
    const card = h('button', 'role'); card.type = 'button';
    const hidden = '꾹 누르면 내 역할이 보여요';
    card.textContent = hidden;
    const show = event => { event.preventDefault(); card.textContent = thief ? '당신은 전기 도둑! 들키지 마세요' : state.solo ? '가족 팀! 차를 이겨요' : '당신은 가족! 도둑을 찾으세요'; card.classList.add('open', thief ? 'bad' : 'good'); };
    const hide = () => { card.textContent = hidden; card.classList.remove('open', 'bad', 'good'); };
    card.onpointerdown = show; card.onpointerup = card.onpointerleave = card.onpointercancel = hide;
    card.oncontextmenu = event => event.preventDefault();
    return card;
  }

  function wait(title, hint) {
    const wrap = h('section', 'card wait');
    wrap.append(h('h2', '', title));
    if (hint) wrap.append(h('p', 'hint', hint));
    return wrap;
  }
  function clueBox() {
    const box = h('div', 'clue');
    box.append(h('small', '', '내 점검 결과 (나만 보여요)'), h('p', '', state.clue ?? '없음'));
    return box;
  }

  function caseView() {
    const done = state.players.find(p => p.id === state.me)?.done;
    if (done) { const w = wait('냈어요!', '다른 가족을 기다리는 중이에요.'); w.append(roleCard()); return w; }
    const wrap = h('section', 'task');
    const head = h('div', 'task-head');
    const title = h('p', 'prompt'); title.append(h('small', '', `사건 ${state.caseNo} / ${state.cases}`), h('b', '', `전기 ${state.target}칸 모으기`));
    timerEl = h('span', 'timer small-timer'); head.append(title, timerEl); wrap.append(head);
    wrap.append(h('p', 'hint', '카드 한 장'));
    const hand = h('div', 'hand');
    const cards = state.hand.map((value, i) => {
      const b = button((value > 0 ? '+' : '') + value, 'cardbtn' + (value < 0 ? ' minus' : '') + (choice.card === i ? ' on' : ''), () => { choice.card = i; cards.forEach((x, j) => x.classList.toggle('on', j === i)); ready(); });
      return b;
    });
    hand.append(...cards); wrap.append(hand);
    wrap.append(h('p', 'hint', state.role === 'THIEF' ? '점검할 곳 (조명·공조는 몰래 차를 건드려요)' : '점검할 곳 (단서가 나올 수 있어요)'));
    const row = h('div', 'row');
    const spots = INSPECT.map(([id, label]) => {
      const b = button(label, 'chip' + (choice.inspect === id ? ' on' : ''), () => { choice.inspect = id; spots.forEach(x => x.classList.toggle('on', x === b)); ready(); });
      return b;
    });
    row.append(...spots); wrap.append(row);
    const go = button('몰래 내기', 'primary big', () => net?.send({ type: 'play', card: choice.card, inspect: choice.inspect }));
    const ready = () => { go.disabled = choice.card === null || !choice.inspect; };
    ready(); wrap.append(go, roleCard());
    tick();
    return wrap;
  }

  function voteView() {
    const done = state.players.find(p => p.id === state.me)?.done;
    if (done) return wait('투표했어요', '결과를 기다려요.');
    const wrap = h('section', 'task');
    const head = h('div', 'task-head');
    const title = h('p', 'prompt'); title.append(h('small', '', '비밀 투표'), h('b', '', '도둑은 누구?'));
    timerEl = h('span', 'timer small-timer'); head.append(title, timerEl); wrap.append(head);
    for (const p of state.players) if (p.id !== state.me) wrap.append(button(p.name, 'big', () => net?.send({ type: 'vote', suspect: p.id })));
    wrap.append(button('이번엔 기권', 'ghost big', () => net?.send({ type: 'vote', suspect: 'SKIP' })), clueBox());
    tick();
    return wrap;
  }

  const views = {
    LOBBY: () => { const w = wait('곧 시작해요', '큰 화면에서 시작을 눌러 주세요.'); const list = h('ul', 'done-list'); for (const p of state.players) { const li = h('li'); li.append(h('b', '', p.name + (p.id === state.me ? ' (나)' : '')), h('span', '', p.connected ? '접속 중' : '끊김')); list.append(li); } w.append(list); return w; },
    CHARGING: () => { const w = wait('충전 중…', `배터리 ${state.nextAt}%에 다음 사건이 터져요.`); w.append(roleCard()); return w; },
    CASE: caseView,
    RESULT: () => { const w = wait(state.result.success ? '성공!' : '정전!', `모인 전기 ${state.result.sum} / ${state.result.target}`); w.append(clueBox()); return w; },
    TALK: () => { const w = wait('토론 시간', '내 단서를 말해도 되고, 거짓말해도 돼요.'); w.append(clueBox(), roleCard()); return w; },
    VOTE: voteView,
    VERDICT: () => wait(state.verdict.arrested ? `${state.verdict.arrested} 체포!` : '체포 없음', '큰 화면을 봐요.'),
    END: () => wait({ FAMILY: '가족 승리!', THIEF: '도둑 승리!', CAR: '차가 이겼어요' }[state.winner], state.thief ? `도둑은 ${state.thief}이었어요.` : ''),
  };

  function render() {
    if (!state) return;
    const key = [state.phase, state.caseNo, state.nextAt, state.players.find(p => p.id === state.me)?.done, state.phase === 'LOBBY' ? JSON.stringify(state.players.map(p => [p.name, p.connected])) : ''].join('|');
    if (key === viewKey) return;
    if (state.phase === 'CASE' && !viewKey.startsWith('CASE|' + state.caseNo)) choice = { card: null, inspect: null };
    viewKey = key; timerEl = null; say('');
    app.replaceChildren(views[state.phase]());
  }
  function tick() {
    if (!timerEl || !state?.deadline) return;
    const left = secondsLeft(state.deadline);
    timerEl.textContent = left + '초';
    timerEl.classList.toggle('warn', left <= 10);
  }
  setInterval(tick, 250);

  function start() {
    if (!session) { joinView(); return; }
    app.replaceChildren(h('p', 'hint center', '연결 중…'));
    net = connect({
      code: session.code, token: session.token,
      onLink: value => { if (value === 'LIVE') say(''); else if (value === 'RETRYING') say('연결이 끊겨 다시 붙는 중…'); },
      onState: value => { state = value; render(); },
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
