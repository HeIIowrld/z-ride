'use strict';
// 폰. 화면 전체가 연타 버튼이다. 연타는 모아서 0.12초마다 보낸다.
(() => {
  const { h, TEAM, avatar, connect, post, store, secondsLeft } = window.Tug;
  const KEY = 'tug.phone';
  const ERR = {
    NO_ROOM: '방을 찾을 수 없어요. 코드를 다시 확인해 주세요.', ROOM_FULL: '네 자리가 모두 찼어요.',
    GAME_STARTED: '이미 게임이 시작됐어요. 다음 판에 같이 해요.', NAME_REQUIRED: '이름을 적어 주세요.', NETWORK: '서버에 연결할 수 없어요.',
  };
  const app = document.getElementById('app'), toast = document.getElementById('toast');
  let session = store.get(KEY), net = null, state = null, viewKey = '', live = null, pending = 0, mine = 0;

  function say(text) { toast.textContent = text; toast.hidden = !text; }
  const button = (text, className, onClick) => { const b = h('button', className, text); b.type = 'button'; b.onclick = onClick; return b; };

  const hashCode = location.hash.slice(1).toUpperCase();
  const stripHash = () => { if (location.hash) history.replaceState(null, '', location.pathname); };
  stripHash();
  addEventListener('hashchange', stripHash);

  function joinView(message) {
    const form = h('form', 'card join');
    form.append(h('h1', 'logo', 'Power Tug'));
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
  const myCharge = () => { const mint = Math.round(50 - state.pos / 2); return me()?.team === 'MINT' ? mint : 100 - mint; };

  function lobbyView() {
    const p = me(), t = p.team;
    const wrap = h('section', `screen team-${t.toLowerCase()}`);
    const card = h('div', 'card center');
    card.append(avatar(p, 'xl'), h('p', 'eyebrow', '내 팀'), h('h2', 'huge', `${TEAM[t].name} 팀`));
    const mates = state.players.filter(x => x.team === t && x.id !== p.id).map(x => x.name);
    card.append(h('p', 'hint', mates.length ? `같은 팀: ${mates.join(', ')}` : '아직 혼자예요'));
    card.append(button('팀 바꾸기', 'ghost', () => net.send({ type: 'team' })));
    if (state.phase === 'RULES') card.append(h('p', 'lead rules-now', '차 화면에서 게임 방법을 보는 중이에요'));
    card.append(h('p', 'hint', '차 화면에서 시작하면 폰 화면 전체가 버튼이 돼요.'));
    wrap.append(card);
    return wrap;
  }

  function padView() {
    const t = me().team;
    const wrap = h('section', `pad-screen team-${t.toLowerCase()}`);
    const head = h('header', 'pad-head');
    const charge = h('b', 'pad-charge'); const timer = h('span', 'pad-timer');
    head.append(h('span', '', `${state.round}판 · ${TEAM[t].name} 팀`), timer);
    const pad = h('button', 'pad'); pad.type = 'button';
    const label = h('span', 'pad-label'); const count = h('small', 'pad-count');
    const meter = h('div', 'pad-meter'); const fill = h('div', 'pad-fill'); meter.append(fill);
    pad.append(label, charge, meter, count);
    // pointerdown은 손가락마다 따로 온다. 클릭(떼기)을 기다리지 않아 빠르다
    pad.addEventListener('pointerdown', event => {
      event.preventDefault();
      if (state?.phase !== 'PULL') return;
      pending += 1; mine += 1;
      pad.classList.remove('hit'); void pad.offsetWidth; pad.classList.add('hit');
      count.textContent = `${mine}번`;
    });
    pad.addEventListener('contextmenu', e => e.preventDefault());
    wrap.append(head, pad);
    live = { label, charge, fill, timer, count, pad };
    paint();
    return wrap;
  }

  function paint() {
    if (!live || !state) return;
    const c = myCharge(), left = secondsLeft(state.deadline);
    live.charge.textContent = c + '%';
    live.fill.style.width = c + '%';
    live.pad.classList.toggle('waiting', state.phase !== 'PULL');
    if (state.phase === 'READY') { live.label.textContent = left > 0 ? `${left}…` : '연타!'; live.timer.textContent = '준비'; }
    else if (state.phase === 'PULL') { live.label.textContent = c > 50 ? '좋아요, 계속!' : c < 50 ? '밀리고 있어요! 연타!' : '연타!'; live.timer.textContent = left + '초'; }
  }

  function resultView() {
    const t = me().team, end = state.phase === 'END';
    const w = end ? state.winner : state.roundWinner, won = w === t;
    const wrap = h('section', `screen team-${t.toLowerCase()}`);
    const card = h('div', `card center ${w ? (won ? 'win' : 'lose') : ''}`);
    card.append(h('p', 'eyebrow', end ? '게임 끝' : `${state.round}판 결과`));
    card.append(h('h2', 'huge', !w ? '무승부' : won ? (end ? '우리 팀 승리!' : '이번 판 이겼어요!') : (end ? '아쉽게 졌어요' : '이번 판은 졌어요')));
    card.append(h('p', 'lead', `민트 ${state.wins.MINT} : ${state.wins.PINK} 핑크`));
    card.append(h('p', 'hint', `이번에 나는 ${me().taps}번 두드렸어요`));
    if (!end) card.append(h('p', 'hint', '곧 다음 판이 시작돼요. 손 풀어 두세요!'));
    wrap.append(card);
    return wrap;
  }

  function render() {
    if (!state) return;
    if (!me()) { store.drop(KEY); session = null; joinView('방에서 나왔어요. 다시 들어오려면 이름을 적어 주세요.'); return; }
    const key = state.phase + state.round + (state.phase === 'LOBBY' ? JSON.stringify(state.players.map(p => [p.id, p.team])) : '');
    if (key === viewKey) { paint(); return; }
    if (state.phase === 'READY') mine = 0;
    viewKey = key; live = null;
    const view = state.phase === 'LOBBY' || state.phase === 'RULES' ? lobbyView()
      : state.phase === 'READY' || state.phase === 'PULL' ? padView() : resultView();
    app.replaceChildren(view);
  }
  setInterval(paint, 250);
  // 모은 연타를 보낸다. 끊겨 있으면 버린다(늦게 도착한 연타로 판이 바뀌지 않게)
  setInterval(() => {
    if (!pending) return;
    if (state?.phase === 'PULL' && net?.isLive()) net.send({ type: 'tap', n: pending });
    pending = 0;
  }, 120);

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
