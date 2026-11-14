'use strict';
// 폰. 역할·손패·단서는 여기에만 보인다. 세션은 localStorage(카메라가 여는 새 탭 대응).
// 화면 원칙: 위에는 늘 "나 · 지금 단계 · 남은 시간", 가운데는 지금 고를 것만, 실행 버튼은 엄지가 닿는 아래에 고정.
(() => {
  const { h, connect, post, store, secondsLeft, briefList, rulesList, avatar, person, meter, tip } = window.Relay;
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
  const app = document.getElementById('app'), toast = document.getElementById('toast');
  let session = store.get(KEY), net = null, state = null, viewKey = '', timerEl = null;
  let choice = { card: null, watch: null, prank: 'NONE' };

  const say = text => { toast.textContent = text; toast.hidden = !text; };
  const button = (text, className, onClick) => { const b = h('button', className, text); b.type = 'button'; b.onclick = onClick; return b; };
  const me = () => state.players.find(p => p.id === state.me);
  const hashCode = location.hash.slice(1).toUpperCase();
  const stripHash = () => { if (location.hash) history.replaceState(null, '', location.pathname); };
  stripHash();
  addEventListener('hashchange', stripHash);

  function joinView(message) {
    const form = h('form', 'card join');
    form.append(h('h1', 'logo', '전기 도둑'), h('p', 'hint', message || '이름을 적고 들어오세요. 앱 설치는 필요 없어요.'));
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

  /** 모든 화면의 뼈대: 머리(나·단계·시간) / 본문 / 아래 고정 버튼. */
  function screen(step, title, { timer = false, dock = null } = {}) {
    const wrap = h('section', 'screen' + (dock ? ' has-dock' : ''));
    const head = h('header', 'topbar');
    const who = h('div', 'bar-me'); who.append(avatar(state.players, state.me), h('span', '', me()?.name ?? ''));
    const what = h('div', 'bar-step'); what.append(h('small', '', step), h('b', '', title));
    head.append(who, what);
    if (timer) { timerEl = h('span', 'timer small-timer'); head.append(timerEl); tick(); }
    wrap.append(head);
    const body = h('div', 'screen-body'); wrap.append(body);
    if (dock) { const d = h('div', 'dock'); d.append(...[dock].flat()); wrap.append(d); }
    wrap.body = body;
    return wrap;
  }
  function block(label, ...children) {
    const b = h('div', 'block');
    if (label) b.append(h('p', 'block-label', label));
    b.append(...children);
    return b;
  }

  /** 옆 사람이 못 보게, 누르고 있는 동안만 역할을 보여 준다. */
  function roleCard() {
    const thief = state.role === 'THIEF';
    const card = h('button', 'role'); card.type = 'button';
    const hidden = '꾹 누르면 내 역할이 보여요';
    card.textContent = hidden;
    const show = event => {
      event.preventDefault();
      const [title, todo] = thief ? ['당신은 전기 도둑!', '합계가 구간을 벗어나게 몰래 크게 또는 작게 내요. 가족인 척하세요.']
        : state.solo ? ['우리는 한 팀!', '차가 몰래 −2~+2를 더해요. 둘이 숫자를 맞춰 구간에 넣어요.']
        : ['당신은 가족!', '다 같이 합계를 구간에 맞춰요. 누가 몇을 낼지 말로 맞추고 도둑을 찾으세요.'];
      card.replaceChildren(h('b', '', title), h('span', '', todo));
      card.classList.add('open', thief ? 'bad' : 'good');
    };
    const hide = () => { card.replaceChildren(hidden); card.classList.remove('open', 'bad', 'good'); };
    card.onpointerdown = show; card.onpointerup = card.onpointerleave = card.onpointercancel = hide;
    card.oncontextmenu = event => event.preventDefault();
    return card;
  }
  function rulesFold() {
    const fold = h('details', 'fold');
    fold.append(h('summary', '', '규칙 다시 보기'), briefList(state.solo), rulesList(state.solo));
    return fold;
  }
  function handView() {
    const box = h('div', 'hand peek');
    for (const v of state.hand) { const c = h('div', 'cardbtn' + (v < 0 ? ' minus' : '')); c.append(h('b', '', signed(v))); box.append(c); }
    return box;
  }
  function clueBox() {
    const box = h('div', 'clue');
    box.append(h('small', '', '내가 살펴본 결과 · 나만 보여요'), h('p', '', state.clue ?? '이번엔 살펴본 사람이 없어요.'));
    return box;
  }
  function peopleList(noteOf) {
    const list = h('ul', 'people');
    for (const p of state.players) list.append(person(state.players, p, noteOf(p), p.done));
    return list;
  }

  function lobbyView() {
    const s = screen('대기실', '곧 시작해요');
    s.body.append(block('함께하는 가족', peopleList(p => p.id === state.me ? '나' : p.connected ? '접속 중' : '끊김')), tip('큰 화면에서 "시작하기"를 누르면 시작해요.'));
    return s;
  }

  function briefView() {
    const done = me()?.done;
    if (done) {
      const s = screen('시작 전', '다른 가족을 기다려요');
      s.body.append(block('내 역할', roleCard()), block('', peopleList(p => p.done ? '이해했어요' : '읽는 중')));
      return s;
    }
    const s = screen('시작 전', '이렇게 해요', { dock: button('이해했어요', 'primary big', () => net?.send({ type: 'ready' })) });
    const more = h('details', 'fold'); more.append(h('summary', '', '자세한 규칙'), rulesList(state.solo));
    s.body.append(briefList(state.solo), block('내 역할', roleCard()), more);
    return s;
  }

  function chargingView() {
    const s = screen(state.caseNo ? `사건 ${state.caseNo} 끝` : '곧 첫 사건', '충전 중…');
    s.body.append(h('p', 'lead', `배터리 ${state.nextAt}%가 되면 다음 사건이 터져요.`), block('내 손패 · 판 내내 써요', handView()), block('내 역할', roleCard()), rulesFold());
    if (state.caseNo === 0) s.body.append(tip('큰 카드는 몇 장 없어요. 언제 쓸지 생각해 두세요.'));
    return s;
  }

  function caseView() {
    if (me()?.done) {
      const s = screen(`사건 ${state.caseNo}`, '냈어요!', { timer: true });
      s.body.append(h('p', 'lead', '다른 가족을 기다리는 중이에요.'), block('', peopleList(p => p.done ? '냈어요' : '고르는 중')), block('남은 손패', handView()));
      return s;
    }
    const go = button('몰래 내기', 'primary big', () => net?.send({ type: 'play', card: choice.card, watch: choice.watch, prank: choice.prank }));
    const ready = () => { go.disabled = choice.card === null || (!state.solo && !choice.watch); };
    const s = screen(`사건 ${state.caseNo}`, `합계 ${state.range.lo}~${state.range.hi}`, { timer: true, dock: go });
    s.body.append(meter({ lo: state.range.lo, hi: state.range.hi }));
    const hand = h('div', 'hand');
    const cards = state.hand.map((value, i) => {
      const b = button('', 'cardbtn' + (value < 0 ? ' minus' : '') + (choice.card === i ? ' on' : ''), () => { choice.card = i; cards.forEach((x, j) => x.classList.toggle('on', j === i)); ready(); });
      b.append(h('b', '', signed(value)), h('small', '', cardLabel(value)));
      return b;
    });
    hand.append(...cards);
    s.body.append(block('① 카드 1장 고르기 · 낸 카드는 없어져요', hand));
    if (!state.solo) {
      const row = h('div', 'pick-people');
      const others = state.players.filter(p => p.id !== state.me).map(p => {
        const b = button('', 'chip person-chip' + (choice.watch === p.id ? ' on' : ''), () => { choice.watch = p.id; others.forEach(x => x.classList.toggle('on', x === b)); ready(); });
        b.append(avatar(state.players, p.id), h('span', '', p.name));
        return b;
      });
      row.append(...others);
      s.body.append(block('② 살펴볼 사람 · 반반 확률로 그 사람 카드가 보여요', row));
    }
    if (state.role === 'THIEF') {
      const row = h('div', 'row');
      const pranks = PRANKS.map(([id, label]) => {
        const b = button(label, 'chip' + (choice.prank === id ? ' on' : ''), () => { choice.prank = id; pranks.forEach(x => x.classList.toggle('on', x === b)); });
        return b;
      });
      row.append(...pranks);
      s.body.append(block('③ 몰래 장난 · 도둑만 보여요', row));
    }
    s.body.append(block('내 역할', roleCard()));
    if (state.caseNo === 1) s.body.append(tip('모두 낸 뒤 큰 화면에 합계만 나와요. 구간 안이면 성공!'));
    ready();
    return s;
  }

  function resultView() {
    const r = state.result;
    const tone = r.saved ? 'saved' : r.outcome === 'OK' ? 'ok' : r.outcome === 'LOW' ? 'low' : 'high';
    const s = screen(`사건 ${state.caseNo} 결과`, resultTitle(r));
    const banner = h('div', 'banner tone-' + tone); banner.append(h('b', '', resultTitle(r)), h('span', '', `합계 ${r.sum} · 구간 ${r.lo}~${r.hi}` + (r.carNoise ? ` · 차가 몰래 ${signed(r.carNoise)}` : '')));
    s.body.append(banner, meter({ lo: r.lo, hi: r.hi, sum: r.sum }));
    if (!state.solo) s.body.append(clueBox());
    return s;
  }

  function talkView() {
    const s = screen('토론', '누가 수상한가요?', { timer: true });
    s.body.append(clueBox(), tip('단서를 말해도 되고 숨겨도 돼요. 거짓말도 괜찮아요.'), block('내 손패', handView()), block('내 역할', roleCard()), rulesFold());
    return s;
  }

  function voteView() {
    if (me()?.done) {
      const s = screen('비밀 투표', '투표했어요');
      s.body.append(h('p', 'lead', '결과를 기다려요.'), block('', peopleList(p => p.done ? '투표했어요' : '고르는 중')));
      return s;
    }
    const s = screen('비밀 투표', '도둑은 누구?', { timer: true, dock: button('이번엔 기권', 'ghost big', () => net?.send({ type: 'vote', suspect: 'SKIP' })) });
    // 단서를 투표 버튼 바로 위에 둔다(판단 근거와 선택을 가까이)
    s.body.append(clueBox());
    const grid = h('div', 'vote-grid');
    for (const p of state.players) if (p.id !== state.me) {
      const b = button('', 'vote-btn', () => net?.send({ type: 'vote', suspect: p.id }));
      b.append(avatar(state.players, p.id, 'lg'), h('b', '', p.name));
      grid.append(b);
    }
    s.body.append(block('과반이 지목하면 체포돼요', grid));
    return s;
  }

  function verdictView() {
    const v = state.verdict;
    const s = screen('투표 결과', v.arrested ? `${v.arrested} 체포!` : '체포 없음');
    const banner = h('div', 'banner tone-' + (v.caught ? 'ok' : v.arrested ? 'high' : 'saved'));
    banner.append(h('b', '', v.arrested ? `${v.arrested} 체포!` : '아무도 체포되지 않았어요'),
      h('span', '', v.arrested ? (v.caught ? '진짜 도둑이었어요!' : '억울한 가족이었어요. 퓨즈 하나.') : '도둑은 아직 차 안에 있어요.'));
    s.body.append(banner, tip('큰 화면에서 "다음"을 누르면 다시 충전을 기다려요.'));
    return s;
  }

  function endView() {
    const title = { FAMILY: '가족 승리!', THIEF: '도둑 승리!', CAR: '차가 이겼어요' }[state.winner];
    const won = state.winner === 'FAMILY' ? state.role !== 'THIEF' : state.winner === 'THIEF' ? state.role === 'THIEF' : false;
    const s = screen('충전 끝', title);
    const banner = h('div', 'banner tone-' + (won ? 'ok' : 'high'));
    banner.append(h('b', '', won ? '이겼어요!' : '아쉽게 졌어요'), h('span', '', title));
    s.body.append(banner);
    if (state.thief) {
      const thief = state.players.find(p => p.name === state.thief);
      const reveal = h('div', 'reveal-thief');
      if (thief) reveal.append(avatar(state.players, thief.id, 'xl'));
      reveal.append(h('p', '', `전기 도둑은 ${state.thief}`), h('small', '', state.role === 'THIEF' ? '바로 나였어요' : '나는 가족이었어요'));
      s.body.append(reveal);
    }
    s.body.append(tip('큰 화면에서 "한 번 더"를 누르면 같은 사람끼리 다시 해요.'));
    return s;
  }

  const views = { LOBBY: lobbyView, BRIEFING: briefView, CHARGING: chargingView, CASE: caseView, RESULT: resultView, TALK: talkView, VOTE: voteView, VERDICT: verdictView, END: endView };

  function render() {
    if (!state) return;
    const key = [state.phase, state.caseNo, state.nextAt, me()?.done, state.result?.saved,
      ['LOBBY', 'BRIEFING', 'CASE', 'VOTE'].includes(state.phase) ? JSON.stringify(state.players.map(p => [p.name, p.connected, p.done])) : ''].join('|');
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
