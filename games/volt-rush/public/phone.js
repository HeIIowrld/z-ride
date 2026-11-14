'use strict';
// 폰. 방향 패드와 내 가방. 누르고 있으면 계속 같은 쪽으로 간다.
(() => {
  const { h, COLOR, avatar, connect, post, store, secondsLeft, sync, serverNow } = window.Volt;
  const KEY = 'volt.phone';
  const ERR = {
    NO_ROOM: '방을 찾을 수 없어요. 코드를 다시 확인해 주세요.', ROOM_FULL: '네 자리가 모두 찼어요.',
    GAME_STARTED: '이미 게임이 시작됐어요. 다음 판에 같이 해요.', NAME_REQUIRED: '이름을 적어 주세요.', NETWORK: '서버에 연결할 수 없어요.',
  };
  const app = document.getElementById('app'), toast = document.getElementById('toast');
  let session = store.get(KEY), net = null, state = null, viewKey = '', live = null, hold = null;

  function say(text) { toast.textContent = text; toast.hidden = !text; }
  const button = (text, className, onClick) => { const b = h('button', className, text); b.type = 'button'; if (onClick) b.onclick = onClick; return b; };

  const hashCode = location.hash.slice(1).toUpperCase();
  const stripHash = () => { if (location.hash) history.replaceState(null, '', location.pathname); };
  stripHash();
  addEventListener('hashchange', stripHash);

  function joinView(message) {
    const form = h('form', 'card join');
    form.append(h('h1', 'logo', 'Volt Rush'));
    form.append(h('p', 'hint', message || '이름을 적고 들어오세요.'));
    const name = h('input'); name.placeholder = '이름 (예: 아빠)'; name.maxLength = 10; name.autocomplete = 'off'; name.required = true;
    const code = h('input'); code.placeholder = '방 코드 5자리'; code.maxLength = 5; code.value = hashCode; code.autocapitalize = 'characters'; code.autocomplete = 'off';
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
    name.focus();
  }

  const me = () => state.players.find(p => p.id === state.me);
  const tone = () => `c-${me().color.toLowerCase()}`;

  function lobbyView() {
    const p = me();
    const wrap = h('section', `screen ${tone()}`);
    const card = h('div', 'card center tinted');
    card.append(avatar(p, 'xl'), h('p', 'eyebrow', '내 색'), h('h2', 'huge', COLOR[p.color].name));
    card.append(h('p', 'hint', '차 화면에서 시작하면 방향 버튼이 나와요. 한 번 누르면 한 칸(⚡1), 누르고 있으면 계속 가요.'));
    card.append(h('p', 'hint', '시작하면 오는 길에 얻은 아이템 2개가 가방에 들어와요. (지금은 테스트 가방)'));
    wrap.append(card);
    return wrap;
  }

  function step(dir) { if (state?.phase === 'PLAY') net?.send({ type: 'move', dir }); }
  function stopHold() { clearInterval(hold); hold = null; }

  function padView() {
    const p = me();
    const wrap = h('section', `play ${tone()}`);
    const head = h('header', 'play-head');
    const energy = h('b', 'play-energy'), timer = h('span', 'pad-timer');
    head.append(h('span', '', `${COLOR[p.color].name} · ${state.round}/${state.rounds}판`), timer);
    const status = h('p', 'play-status');
    const bag = h('div', 'bag');
    for (const item of state.bag) {
      const b = button('', 'item', () => { if (state.phase === 'PLAY') net.send({ type: 'item', id: item.id }); });
      b.append(h('b', '', item.name), h('small', '', item.desc), h('small', 'from', `${item.from}에서 획득`));
      bag.append(b);
    }
    if (!state.bag.length) bag.append(h('p', 'hint', '가방이 비었어요'));
    const pad = h('div', 'dpad');
    for (const [dir, label] of [['U', '▲'], ['L', '◀'], ['R', '▶'], ['D', '▼']]) {
      const b = button(label, `dir d-${dir}`);
      b.addEventListener('pointerdown', event => {
        event.preventDefault(); stopHold(); step(dir);
        hold = setInterval(() => step(dir), 170);
      });
      for (const end of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(end, stopHold);
      b.addEventListener('contextmenu', e => e.preventDefault());
      pad.append(b);
    }
    pad.append(energy);
    wrap.append(head, status, bag, pad);
    live = { energy, timer, status, pad };
    paint();
    return wrap;
  }

  function paint() {
    if (!live || !state) return;
    const p = me(), left = secondsLeft(state.deadline);
    live.energy.textContent = `⚡${p.energy}`;
    const ev = state.event && state.event.until > serverNow() ? state.event.kind : null;
    live.timer.textContent = state.phase === 'PLAY' ? `${left}초` : state.phase === 'READY' ? `${left}…` : '';
    live.pad.classList.toggle('waiting', state.phase !== 'PLAY' || p.stuck);
    live.status.textContent = state.phase === 'READY' ? '곧 출발해요!'
      : p.stuck ? '막혔어요! 아이템이 있으면 써 보세요'
      : ev === 'BOOST' ? '지금은 무료 이동! 마음껏 달려요'
      : ev === 'BLACKOUT' ? '정전! 차 화면이 꺼졌어요. 기억으로 움직여요'
      : state.jump ? '절연 장갑 준비됨: 막힌 칸으로 가면 뛰어넘어요'
      : `충전기까지 ${p.dist}칸`;
  }

  function resultView() {
    const p = me(), end = state.phase === 'END';
    const won = end ? state.winners.includes(p.id) : state.roundWinner === p.id;
    const wrap = h('section', `screen ${tone()}`);
    const card = h('div', `card center ${won ? 'win' : ''}`);
    card.append(h('p', 'eyebrow', end ? '게임 끝' : `${state.round}판 결과`));
    const w = state.players.find(x => x.id === state.roundWinner);
    card.append(h('h2', 'huge', won ? (end ? '최종 승리!' : '충전기 도착!') : end ? '수고했어요' : w ? `${w.name} 님이 닿았어요` : '아무도 못 닿았어요'));
    card.append(h('p', 'lead', `내 점수 ${p.score}승 · 남은 ⚡${p.energy}`));
    if (!end) card.append(h('p', 'hint', '⚡는 다음 판으로 이어져요. 아껴 쓰세요!'));
    wrap.append(card);
    return wrap;
  }

  function render() {
    if (!state) return;
    if (!me()) { store.drop(KEY); session = null; joinView('방에서 나왔어요. 다시 들어오려면 이름을 적어 주세요.'); return; }
    const key = state.phase + state.round + state.bag?.map(b => b.id).join() + (state.phase === 'LOBBY' ? me().color : '');
    if (key === viewKey) { paint(); return; }
    viewKey = key; live = null; stopHold();
    const view = state.phase === 'LOBBY' ? lobbyView()
      : state.phase === 'READY' || state.phase === 'PLAY' ? padView() : resultView();
    app.replaceChildren(view);
  }
  setInterval(paint, 250);
  // 브라우저로 시험할 때는 방향키로도 움직인다
  addEventListener('keydown', e => { const dir = { ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R' }[e.key]; if (dir) { e.preventDefault(); step(dir); } });

  function start() {
    if (!session) { joinView(); return; }
    app.replaceChildren(h('p', 'hint center', '연결 중…'));
    net = connect({
      code: session.code, token: session.token,
      onLink: value => { if (value === 'LIVE') say(''); else if (value === 'RETRYING') say('연결이 끊겨 다시 붙는 중…'); },
      onState: value => { sync(value); state = value; render(); },
      onError: code => { if (code === 'NO_ITEM') say(''); },
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
