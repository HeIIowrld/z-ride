'use strict';
// 큰 화면. 공개 정보만 보여 준다. 차가 있으면 같은 cabin 값을 Pleos 앱이 실내에 적용한다.
(() => {
  const { h, connect, post, store, secondsLeft, rulesList } = window.Relay;
  const KEY = 'thief.host';
  const $ = id => document.getElementById(id);
  const stage = $('stage');
  let session = null, net = null, state = null, viewKey = '', timerEl = null;
  // Pleos 앱 안에서 열리면 window.PleosCar가 있고, 앱이 onCarSignal로 실제 차 값을 넣어 준다
  const car = window.PleosCar ?? null;
  let signal = null, lastCabin = '';
  window.onCarSignal = value => {
    signal = value;
    if (value.parked && value.soc != null) send({ type: 'soc', value: value.soc, source: 'CAR' });
    cover();
  };
  function cover() {
    const blocked = !!car && !signal?.parked;
    document.body.classList.toggle('driving', blocked);
    $('cover').hidden = !blocked;
    // 앱이 첫 신호를 보내기 전에는 주행 중인지 아직 모른다
    $('cover').firstElementChild.innerHTML = signal ? '주행 중에는 게임을 가려요.<br>P에 두면 다시 보여요.' : '차량 상태를 확인하는 중…';
  }

  const button = (text, className, onClick) => { const b = h('button', className, text); b.type = 'button'; b.onclick = onClick; return b; };
  const send = message => net?.send(message);
  const next = () => send({ type: 'next' });

  function top() {
    $('gauge-fill').style.width = state.soc + '%';
    $('gauge-text').textContent = `배터리 ${state.soc}%` + (state.socSource === 'CAR' ? '' : ' (시연)');
    $('fuses').textContent = state.phase === 'LOBBY' ? '' : '퓨즈 ' + '●'.repeat(state.maxBlackouts - state.blackouts) + '○'.repeat(Math.min(state.blackouts, state.maxBlackouts));
    document.body.dataset.light = state.cabin.light;
    document.body.dataset.climate = state.cabin.climate;
    const cabin = JSON.stringify(state.cabin);
    if (car && cabin !== lastCabin) { lastCabin = cabin; car.applyCabin(cabin); }
  }

  function lobby() {
    const wrap = h('section', 'lobby');
    const qrCard = h('div', 'card qr-card');
    qrCard.append(h('h2', '', '폰 카메라로 찍기'));
    const qr = h('div', 'qr'); qrCard.append(qr, h('p', 'code', session.code));
    try { window.ZRideQR.renderSvg(qr, session.joinUrl); } catch { qr.textContent = 'QR을 그리지 못했어요'; }
    const side = h('div', 'card');
    side.append(h('h2', '', `가족 ${state.players.length} / 4`));
    const seats = h('ul', 'seats');
    for (let i = 0; i < 4; i++) {
      const p = state.players[i], li = h('li', p ? 'seat on' : 'seat');
      li.append(h('b', '', p ? p.name : '빈자리'));
      if (p) li.append(h('span', p.connected ? 'dot live' : 'dot', p.connected ? '접속 중' : '끊김'), button('내보내기', 'ghost small', () => send({ type: 'kick', playerId: p.id })));
      seats.append(li);
    }
    side.append(seats);
    side.append(h('p', 'hint', state.players.length === 2
      ? '2명이면 차가 방해꾼이 돼요. 정전 3번 전에 사건을 모두 넘기면 승리!'
      : '이 중 한 명은 전기 도둑이에요. 배터리가 5% 오를 때마다 사건이 터져요. 충전이 끝나기 전에 도둑을 잡으세요.'));
    const full = state.soc >= 95;
    const start = button(full ? '배터리가 거의 다 차서 시작할 수 없어요' : state.players.length < 2 ? '2명부터 시작할 수 있어요' : '시작하기', 'primary big', () => send({ type: 'start' }));
    start.disabled = full || state.players.length < 2;
    side.append(start);
    wrap.append(qrCard, side);
    return wrap;
  }

  function panel(eyebrow, title, hint) {
    const wrap = h('section', 'play card');
    wrap.append(h('p', 'eyebrow', eyebrow), h('h2', 'huge', title));
    if (hint) wrap.append(h('p', 'hint', hint));
    return wrap;
  }
  function waiting(wrap) {
    timerEl = h('p', 'timer'); wrap.append(timerEl);
    const list = h('ul', 'done-list');
    for (const p of state.players) { const li = h('li', p.done ? 'done' : ''); li.append(h('b', '', p.name), h('span', '', p.done ? '냈어요' : p.connected ? '고르는 중' : '끊김')); list.append(li); }
    wrap.append(list);
    tick();
  }

  const views = {
    LOBBY: lobby,
    BRIEFING() {
      const wrap = h('section', 'brief card');
      wrap.append(h('h2', 'brief-title', '게임 방법'), rulesList(state.solo));
      const foot = h('div', 'brief-foot');
      const list = h('ul', 'done-list');
      for (const p of state.players) { const li = h('li', p.done ? 'done' : ''); li.append(h('b', '', p.name), h('span', '', p.done ? '이해했어요' : p.connected ? '읽는 중' : '끊김')); list.append(li); }
      foot.append(list, button('바로 시작', 'primary', next));
      wrap.append(foot);
      return wrap;
    },
    CHARGING() {
      const left = Math.max(0, state.nextAt - state.soc);
      return panel(`사건 ${state.caseNo} / ${state.cases} 끝`, '충전 중…', `배터리가 ${state.nextAt}%가 되면 다음 사건이 터져요. 앞으로 ${left}%`);
    },
    CASE() {
      const wrap = panel(`사건 ${state.caseNo} / ${state.cases}`, `전기 ${state.target}칸을 모아라`, state.solo ? '차가 몰래 전기를 빼 가요. 폰에서 카드를 내세요.' : '폰에서 몰래 카드를 내세요. 차는 합계만 알려 줘요.');
      waiting(wrap); return wrap;
    },
    RESULT() {
      const r = state.result, wrap = panel(`사건 ${state.caseNo} 결과`, r.success ? '성공!' : '정전!', `모인 전기 ${r.sum} / 필요한 전기 ${r.target}` + (r.carPenalty ? ` · 차가 ${r.carPenalty}칸 빼 갔어요` : ''));
      if (state.tampered) wrap.append(h('p', 'alarm', '누군가 몰래 차를 건드렸어요!'));
      wrap.append(button('다음', 'primary big', next));
      return wrap;
    },
    TALK() {
      const wrap = panel('토론', '누가 수상한가요?', '각자 폰의 단서를 말해요. 거짓말을 해도 돼요.');
      timerEl = h('p', 'timer'); wrap.append(timerEl); tick();
      wrap.append(button('투표하기', 'primary big', next));
      return wrap;
    },
    VOTE() {
      const wrap = panel('비밀 투표', '도둑을 지목하세요', '과반이 지목해야 체포돼요. 억울한 사람을 잡으면 퓨즈가 하나 나가요.');
      waiting(wrap); return wrap;
    },
    VERDICT() {
      const v = state.verdict;
      const wrap = panel('투표 결과', v.arrested ? `${v.arrested} 체포!` : '아무도 체포되지 않았어요', v.arrested ? (v.caught ? '진짜 도둑이었어요!' : '억울한 가족이었어요. 퓨즈가 하나 나갔어요.') : '도둑은 아직 차 안에 있어요.');
      wrap.append(button('다음', 'primary big', next));
      return wrap;
    },
    END() {
      const title = { FAMILY: '가족 승리!', THIEF: '도둑 승리!', CAR: '차가 이겼어요' }[state.winner];
      const wrap = panel('충전 끝', title, state.thief ? `전기 도둑은 ${state.thief}이었어요.` : '다음엔 차를 이겨 봐요.');
      wrap.append(button('한 번 더', 'primary big', next));
      return wrap;
    },
  };

  function render() {
    if (!state) return;
    top();
    const key = state.phase + state.caseNo + (state.phase === 'CHARGING' ? state.nextAt - state.soc : '') + (state.soc >= 95)
      + JSON.stringify(state.players.map(p => [p.name, p.done, p.connected])) + state.tampered;
    if (key === viewKey) return;
    viewKey = key; timerEl = null;
    stage.replaceChildren(views[state.phase]());
  }
  function tick() {
    if (!timerEl || !state?.deadline) return;
    const left = secondsLeft(state.deadline);
    timerEl.textContent = left + '초';
    timerEl.classList.toggle('warn', left <= 10);
  }
  setInterval(tick, 250);
  // 차가 배터리를 보내지 않으면 시연용으로 천천히 올린다
  setInterval(() => { if (!car && state?.phase === 'CHARGING' && state.socSource !== 'CAR' && state.soc < 100) send({ type: 'soc', value: state.soc + 1 }); }, 1500);

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
  cover();
  open(false);
})();
