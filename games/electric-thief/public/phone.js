'use strict';
// 폰. 역할·손패·단서는 여기에만 보인다. 세션은 localStorage(카메라가 여는 새 탭 대응).
(() => {
  const { h, connect, post, store, secondsLeft, rulesList } = window.Relay;
  const KEY = 'thief.phone';
  const ERR = {
    NO_ROOM: '방을 찾을 수 없어요. 코드를 다시 확인해 주세요.', ROOM_FULL: '네 자리가 모두 찼어요.',
    GAME_STARTED: '이미 게임이 시작됐어요. 다음 판에 같이 해요.', NAME_REQUIRED: '이름을 적어 주세요.', NETWORK: '서버에 연결할 수 없어요.',
  };
  const PRANKS = [['NONE', '안 해요'], ['LIGHT', '조명 빨갛게'], ['WIND', '바람 훅']];
  const cardLabel = v => v > 0 ? '충전' : v < 0 ? '방전' : '빈 카드';
  const signed = v => (v > 0 ? '+' : '') + v;
  const OUTCOME = { OK: '성공!', LOW: '정전!', HIGH: '과부하!' };
  const resultTitle = r => r.saved ? '차단기로 막았어요!' : OUTCOME[r.outcome];

  /** 판 내내 들고 있는 손패. 사건이 아닐 때도 보며 어떤 카드를 아낄지 생각한다. */
  function handPeek() {
    const box = h('div', 'hand peek');
    for (const v of state.hand) { const c = h('div', 'cardbtn' + (v < 0 ? ' minus' : '')); c.append(h('b', '', signed(v))); box.append(c); }
    const wrap = h('div'); wrap.append(h('p', 'hint', '내 손패'), box);
    return wrap;
  }
  const app = document.getElementById('app'), toast = document.getElementById('toast');
  let session = store.get(KEY), net = null, state = null, viewKey = '', timerEl = null;
  let choice = { card: null, watch: null, prank: 'NONE' };

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
    const show = event => {
      event.preventDefault();
      const [title, todo] = thief ? ['당신은 전기 도둑!', '합계가 구간을 벗어나게 몰래 크게 또는 작게 내요. 몰래 장난으로 차를 건드릴 수도 있어요. 가족인 척하세요.']
        : state.solo ? ['우리는 한 팀!', '차가 몰래 −2~+2를 더해요. 둘이 숫자를 맞춰 구간에 넣어요.']
        : ['당신은 가족!', '다 같이 합계를 구간에 맞춰요. 누가 몇을 낼지 말로 맞추고, 한 명을 살펴보며 도둑을 찾으세요.'];
      card.replaceChildren(h('b', '', title), h('span', '', todo));
      card.classList.add('open', thief ? 'bad' : 'good');
    };
    const hide = () => { card.replaceChildren(hidden); card.classList.remove('open', 'bad', 'good'); };
    card.onpointerdown = show; card.onpointerup = card.onpointerleave = card.onpointercancel = hide;
    card.oncontextmenu = event => event.preventDefault();
    return card;
  }

  /** 게임 중에도 접었다 펴서 규칙을 다시 본다. */
  function rulesFold() {
    const fold = h('details', 'fold');
    fold.append(h('summary', '', '규칙 다시 보기'), rulesList(state.solo));
    return fold;
  }

  function briefView() {
    const done = state.players.find(p => p.id === state.me)?.done;
    if (done) { const w = wait('다른 가족을 기다려요', '모두 읽으면 시작해요.'); w.append(roleCard()); return w; }
    const wrap = h('section', 'task');
    wrap.append(h('h2', 'brief-title', '게임 방법'), rulesList(state.solo), roleCard());
    wrap.append(button('이해했어요', 'primary big', () => net?.send({ type: 'ready' })));
    return wrap;
  }

  function wait(title, hint) {
    const wrap = h('section', 'card wait');
    wrap.append(h('h2', '', title));
    if (hint) wrap.append(h('p', 'hint', hint));
    return wrap;
  }
  function clueBox() {
    const box = h('div', 'clue');
    box.append(h('small', '', '내가 살펴본 결과 (나만 보여요)'), h('p', '', state.clue ?? '없음'));
    return box;
  }

  function caseView() {
    const done = state.players.find(p => p.id === state.me)?.done;
    if (done) { const w = wait('냈어요!', '다른 가족을 기다리는 중이에요.'); w.append(roleCard()); return w; }
    const wrap = h('section', 'task');
    const head = h('div', 'task-head');
    const title = h('p', 'prompt'); title.append(h('small', '', `사건 ${state.caseNo} / ${state.cases}`), h('b', '', `합계를 ${state.range.lo}~${state.range.hi} 사이로`));
    timerEl = h('span', 'timer small-timer'); head.append(title, timerEl); wrap.append(head);
    wrap.append(h('p', 'hint', '카드 한 장 (낸 카드는 없어지고, 다음 사건 전에 한 장 뽑아요)'));
    const hand = h('div', 'hand');
    const cards = state.hand.map((value, i) => {
      const b = button('', 'cardbtn' + (value < 0 ? ' minus' : '') + (choice.card === i ? ' on' : ''), () => { choice.card = i; cards.forEach((x, j) => x.classList.toggle('on', j === i)); ready(); });
      b.append(h('b', '', signed(value)), h('small', '', cardLabel(value)));
      return b;
    });
    hand.append(...cards); wrap.append(hand);
    if (!state.solo) {
      wrap.append(h('p', 'hint', '누구를 살펴볼까? (반반 확률로 그 사람 카드가 보여요)'));
      const row = h('div', 'row');
      const people = state.players.filter(p => p.id !== state.me).map(p => {
        const b = button(p.name, 'chip' + (choice.watch === p.id ? ' on' : ''), () => { choice.watch = p.id; people.forEach(x => x.classList.toggle('on', x === b)); ready(); });
        return b;
      });
      row.append(...people); wrap.append(row);
    }
    if (state.role === 'THIEF') {
      wrap.append(h('p', 'hint bad-hint', '몰래 장난 (도둑만 보여요)'));
      const row = h('div', 'row');
      const pranks = PRANKS.map(([id, label]) => {
        const b = button(label, 'chip' + (choice.prank === id ? ' on' : ''), () => { choice.prank = id; pranks.forEach(x => x.classList.toggle('on', x === b)); });
        return b;
      });
      row.append(...pranks); wrap.append(row);
    }
    const go = button('몰래 내기', 'primary big', () => net?.send({ type: 'play', card: choice.card, watch: choice.watch, prank: choice.prank }));
    const ready = () => { go.disabled = choice.card === null || (!state.solo && !choice.watch); };
    ready(); wrap.append(go, roleCard(), rulesFold());
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
    BRIEFING: briefView,
    CHARGING: () => { const w = wait('충전 중…', `배터리 ${state.nextAt}%에 다음 사건이 터져요.`); w.append(handPeek(), roleCard(), rulesFold()); return w; },
    CASE: caseView,
    RESULT: () => { const r = state.result; const w = wait(resultTitle(r), `모인 전기 ${r.sum} / 구간 ${r.lo}~${r.hi}` + (r.carNoise ? ` · 차가 몰래 ${signed(r.carNoise)}` : '')); w.append(clueBox()); return w; },
    TALK: () => { const w = wait('토론 시간', '내 단서를 말해도 되고, 거짓말해도 돼요.'); w.append(clueBox(), handPeek(), roleCard(), rulesFold()); return w; },
    VOTE: voteView,
    VERDICT: () => wait(state.verdict.arrested ? `${state.verdict.arrested} 체포!` : '체포 없음', '큰 화면을 봐요.'),
    END: () => wait({ FAMILY: '가족 승리!', THIEF: '도둑 승리!', CAR: '차가 이겼어요' }[state.winner], state.thief ? `도둑은 ${state.thief}이었어요.` : ''),
  };

  function render() {
    if (!state) return;
    const key = [state.phase, state.caseNo, state.nextAt, state.players.find(p => p.id === state.me)?.done, state.result?.saved, state.phase === 'LOBBY' ? JSON.stringify(state.players.map(p => [p.name, p.connected])) : ''].join('|');
    if (key === viewKey) return;
    if (state.phase === 'CASE' && !viewKey.startsWith('CASE|' + state.caseNo)) choice = { card: null, watch: null, prank: 'NONE' };
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
