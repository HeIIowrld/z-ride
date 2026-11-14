'use strict';
// 폰. 내 성 하나를 맡는다. 버튼 4개와 끌어올 성 고르기.
(() => {
  const { h, COLOR, connect, post, store, secondsLeft, sync, serverNow, icon } = window.Castle;
  const KEY = 'castle.phone';
  const ERR = {
    NO_ROOM: '방을 찾을 수 없어요. 코드를 다시 확인해 주세요.', ROOM_FULL: '네 자리가 모두 찼어요.',
    GAME_STARTED: '이미 게임이 시작됐어요. 다음 판에 같이 해요.', NAME_REQUIRED: '이름을 적어 주세요.', NETWORK: '서버에 연결할 수 없어요.',
    NO_POWER: '전기가 모자라요', MAX_CABLES: '케이블은 3가닥까지예요', BOLT_FLYING: '번개가 아직 날아가는 중이에요',
    OVERCHARGED: '과충전 중에는 방패를 못 써요', BAD_TARGET: '끌어올 성을 골라 주세요',
  };
  const app = document.getElementById('app'), toast = document.getElementById('toast');
  let session = store.get(KEY), net = null, state = null, viewKey = '', live = null, target = null, toastTimer = null;
  const felt = new Set();

  function say(text, ms) { toast.textContent = text; toast.hidden = !text; clearTimeout(toastTimer); if (text && ms) toastTimer = setTimeout(() => say(''), ms); }
  const button = (text, className, onClick) => { const b = h('button', className, text); b.type = 'button'; if (onClick) b.onclick = onClick; return b; };
  const label = text => h('p', 'label', text);

  const hashCode = location.hash.slice(1).toUpperCase();
  const stripHash = () => { if (location.hash) history.replaceState(null, '', location.pathname); };
  stripHash();
  addEventListener('hashchange', stripHash);

  function joinView(message) {
    const form = h('form', 'panel join');
    form.append(label('POWER CASTLE'), h('h1', '', '내 성에 이름 붙이기'));
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
  const tone = () => COLOR[me().color];

  function header() {
    const p = me(), head = h('header', 'mine');
    const left = h('div'); left.append(label('MY CASTLE'), h('p', 'mine-name', p.name));
    left.lastChild.style.color = tone().soft;
    const num = h('p', 'mine-num'); const value = h('b', '', String(p.power)); num.append(value, h('small', '', `/${state.goal}`));
    const gauge = h('div', 'segs');
    for (let k = 0; k < 10; k++) gauge.append(h('i'));
    head.append(left, num, gauge);
    return { head, value, gauge };
  }
  function paintGauge(gauge, power) {
    const filled = Math.round(Math.min(1, power / state.goal) * 10);
    [...gauge.children].forEach((seg, k) => { seg.style.background = k < filled ? tone().hex : ''; });
  }

  function waitView(title, text) {
    const wrap = h('section', 'screen');
    const { head, gauge } = header();
    const card = h('div', 'panel center');
    card.append(label(title), h('h2', '', text));
    const list = h('ul', 'mini-rules');
    for (const [name, color, t] of [['plug', '#3ef2ff', '케이블: 받는 전기 늘리기'], ['bolt', '#ff3d9a', '끌어오기: 남의 성에서 전기 15'], ['shield', '#3ef2ff', '방패: 폰이 울리면 바로!'], ['batt', '#a66bff', '과충전: 10초 동안 2배']]) {
      const li = h('li'); li.append(icon(name, color, 26), h('span', '', t)); list.append(li);
    }
    card.append(list);
    wrap.append(head, card);
    paintGauge(gauge, me().power);
    return wrap;
  }

  function playView() {
    const wrap = h('section', 'screen play');
    const { head, value, gauge } = header();
    const alert = h('div', 'alert');
    const grid = h('div', 'actions');
    const acts = {};
    for (const [kind, name, title, color] of [['cable', 'plug', '케이블', '#3ef2ff'], ['drain', 'bolt', '끌어오기', '#ff3d9a'], ['shield', 'shield', '방패', '#3ef2ff'], ['over', 'batt', '과충전', '#a66bff']]) {
      const b = button('', `act act-${kind}`, () => act(kind));
      const note = h('small', 'act-note');
      b.append(icon(name, color, 34), h('b', '', title), note);
      grid.append(b); acts[kind] = { b, note };
    }
    const targets = h('div', 'targets');
    wrap.append(head, alert, grid, label('TARGET'), targets);
    live = { value, gauge, alert, acts, targets };
    paint();
    return wrap;
  }

  function act(kind) {
    if (state?.phase !== 'PLAY') return;
    if (kind === 'drain' && !target) return say(ERR.BAD_TARGET, 1500);
    net.send({ type: 'act', kind, target: kind === 'drain' ? target : undefined });
  }

  function paint() {
    if (!live || !state || !me()) return;
    const p = me(), t = serverNow();
    live.value.textContent = String(p.power);
    paintGauge(live.gauge, p.power);

    // 나를 노리는 번개
    const incoming = state.bolts.filter(b => b.to === p.id);
    for (const b of incoming) if (!felt.has(b.id)) { felt.add(b.id); navigator.vibrate?.([120, 60, 120]); }
    live.alert.replaceChildren();
    live.alert.className = 'alert';
    if (incoming.length) {
      const b = incoming[0], from = state.players.find(x => x.id === b.from);
      live.alert.classList.add('danger');
      const txt = h('div'); txt.append(label('INCOMING'), h('p', '', `${from?.name ?? '누군가'}가 전기를 끌어오는 중`));
      live.alert.append(txt, h('b', 'count', ((b.arriveAt - t) / 1000).toFixed(1)));
    } else if (p.shieldUntil) { live.alert.classList.add('ok'); live.alert.append(label('SHIELD'), h('b', 'count', `${Math.ceil((p.shieldUntil - t) / 1000)}s`)); }
    else if (p.overUntil) { live.alert.classList.add('over'); live.alert.append(label('OVERCHARGE ×2'), h('b', 'count', `${Math.ceil((p.overUntil - t) / 1000)}s`)); }
    else if (state.surge) { live.alert.classList.add('over'); live.alert.append(label('SURGE'), h('p', '', '발전소 폭주! 전기가 3배')); }
    else if (state.phase === 'READY') live.alert.append(label('READY'), h('b', 'count', String(secondsLeft(state.deadline))));
    else live.alert.append(label('STATUS'), h('p', '', `케이블 ${p.cables}가닥 · 초당 ${(p.cables * 0.6).toFixed(1)}`));

    // 버튼 상태
    const playing = state.phase === 'PLAY';
    const flying = state.bolts.some(b => b.from === p.id);
    const set = (kind, on, note, hot) => { const a = live.acts[kind]; a.b.disabled = !playing || !on; a.note.textContent = note; a.note.classList.toggle('pw', /^\d/.test(note)); a.b.classList.toggle('hot', !!hot); };
    set('cable', p.cables < state.maxCables && p.power >= state.cost.cable, p.cables >= state.maxCables ? `MAX ${p.cables}/${state.maxCables}` : `${state.cost.cable} · ${p.cables}/${state.maxCables}`);
    set('drain', !flying && p.power >= state.cost.drain && !!target, flying ? '날아가는 중' : String(state.cost.drain));
    set('shield', !p.overUntil && p.power >= state.cost.shield, p.overUntil ? '과충전 중 불가' : String(state.cost.shield), incoming.length && !p.shieldUntil);
    set('over', p.power >= state.cost.over && !p.overUntil, String(state.cost.over));

    // 끌어올 성: 나 말고. 처음엔 1등을 고른다
    const others = state.players.filter(x => x.id !== p.id);
    const top = Math.max(...state.players.map(x => x.power));
    if (!others.some(x => x.id === target)) target = [...others].sort((a, b) => b.power - a.power)[0]?.id ?? null;
    const key = others.map(x => x.id + (x.power === top) + (x.id === target)).join();
    if (live.targetsKey !== key) {
      live.targetsKey = key;
      live.targets.replaceChildren(...others.map(x => {
        const chip = button('', 'chip' + (x.id === target ? ' on' : ''), () => { target = x.id; live.targetsKey = ''; paint(); });
        chip.style.setProperty('--c', COLOR[x.color].hex);
        if (x.power === top) chip.append(icon('crown', COLOR[x.color].hex, 16)); else chip.append(h('i', 'dot'));
        chip.append(h('span', '', x.name));
        return chip;
      }));
    }
  }

  function resultView() {
    const p = me(), end = state.phase === 'END';
    const won = end ? state.winners.includes(p.id) : state.roundWinner === p.id;
    const w = state.players.find(x => x.id === state.roundWinner);
    const wrap = h('section', 'screen');
    const card = h('div', 'panel center' + (won ? ' win' : ''));
    card.append(label(end ? 'FINAL' : `ROUND ${state.round}`));
    card.append(h('h2', 'huge', won ? (end ? '최종 승리!' : '내 성 완충!') : end ? '수고했어요' : w ? `${w.name} 성 완충` : '무승부'));
    card.append(h('p', 'hint', `${p.wins}승 · 이번 판에 끌어온 전기 ${p.drained} · 막아 낸 번개 ${p.blocked}번`));
    wrap.append(card);
    return wrap;
  }

  function render() {
    if (!state) return;
    if (!me()) { store.drop(KEY); session = null; joinView('방에서 나왔어요. 다시 들어오려면 이름을 적어 주세요.'); return; }
    const key = state.phase + state.round + (state.phase === 'LOBBY' ? me().color : '');
    if (key === viewKey) { paint(); return; }
    viewKey = key; live = null;
    const view = state.phase === 'LOBBY' ? waitView('WAITING', '차 화면에서 시작하면 내 성이 열려요')
      : state.phase === 'RULES' ? waitView('HOW TO PLAY', '차 화면에서 규칙을 확인해 주세요')
      : state.phase === 'READY' || state.phase === 'PLAY' ? playView() : resultView();
    app.replaceChildren(view);
  }
  setInterval(paint, 100);

  function start() {
    if (!session) { joinView(); return; }
    app.replaceChildren(h('p', 'hint center', '연결 중…'));
    net = connect({
      code: session.code, token: session.token,
      onLink: value => { if (value === 'LIVE') say(''); else if (value === 'RETRYING') say('연결이 끊겨 다시 붙는 중…'); },
      onState: value => { sync(value); state = value; render(); },
      onError: code => say(ERR[code] || '', 1500),
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
