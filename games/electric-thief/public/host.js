'use strict';
// 큰 화면. 공개 정보만 보여 준다. 차가 있으면 같은 cabin 값을 Pleos 앱이 실내에 적용한다.
// 화면 원칙: 위쪽은 늘 같은 자리의 상태 묶음(단계·사건·퓨즈·차단기·배터리), 가운데는 지금 할 일 하나.
(() => {
  const { h, connect, post, store, secondsLeft, briefList, rulesList, avatar, person, meter, tip } = window.Relay;
  const KEY = 'thief.host';
  const $ = id => document.getElementById(id);
  const stage = $('stage');
  let session = null, net = null, state = null, viewKey = '', timerEl = null;
  // Z-RIDE 차량 SDK(/zride-car.js). Pleos 허브 앱 안이면 실제 차 신호가 오고, ?mockcar면 가짜 차 패널이 뜬다
  const car = ZRide.car;
  const withCar = car.inCar || car.mocked;
  let signal = null, lastCabin = '';
  car.on('signal', value => {
    signal = value;
    if (value.parked && value.soc != null) send({ type: 'soc', value: value.soc, source: 'CAR' });
    cover();
  });
  function cover() {
    const blocked = withCar && !signal?.parked;
    document.body.classList.toggle('driving', blocked);
    $('cover').hidden = !blocked;
    // 앱이 첫 신호를 보내기 전에는 주행 중인지 아직 모른다
    $('cover').firstElementChild.innerHTML = signal ? '주행 중에는 게임을 가려요.<br>P에 두면 다시 보여요.' : '차량 상태를 확인하는 중…';
  }

  const button = (text, className, onClick) => { const b = h('button', className, text); b.type = 'button'; b.onclick = onClick; return b; };
  const send = message => net?.send(message);
  const next = () => send({ type: 'next' });
  const signed = v => (v > 0 ? '+' : '') + v;

  // 한 사건의 흐름. 지금 어디쯤인지 위쪽에 늘 보여 준다
  const STEPS = [['CHARGING', '충전'], ['CASE', '카드'], ['RESULT', '결과'], ['TALK', '토론'], ['VOTE', '투표']];
  const STEP_OF = { CHARGING: 'CHARGING', CASE: 'CASE', RESULT: 'RESULT', TALK: 'TALK', VOTE: 'VOTE', VERDICT: 'VOTE' };

  function top() {
    $('gauge-fill').style.width = state.soc + '%';
    $('gauge-text').textContent = `배터리 ${state.soc}%` + (state.socSource === 'CAR' ? '' : ' (시연)');
    const playing = !['LOBBY', 'BRIEFING', 'END'].includes(state.phase);
    const steps = $('steps'); steps.replaceChildren();
    if (playing) for (const [phase, label] of state.solo ? STEPS.slice(0, 3) : STEPS) steps.append(h('li', STEP_OF[state.phase] === phase ? 'on' : '', label));
    const hud = $('hud'); hud.replaceChildren();
    if (state.phase !== 'LOBBY') {
      const chip = (label, value, cls) => { const c = h('span', 'hud-chip' + (cls ? ' ' + cls : '')); c.append(h('small', '', label), h('b', '', value)); return c; };
      const left = state.maxBlackouts - state.blackouts;
      hud.append(
        chip('사건', `${state.caseNo} / ${state.cases}`),
        chip('퓨즈', '●'.repeat(Math.max(0, left)) + '○'.repeat(Math.min(state.blackouts, state.maxBlackouts)), left <= 1 ? 'warn' : ''),
        chip('차단기', `${state.breakers}번`),
      );
    }
    document.body.dataset.light = state.cabin.light;
    document.body.dataset.air = state.cabin.air;
    const cabin = JSON.stringify(state.cabin);
    if (withCar && cabin !== lastCabin) { lastCabin = cabin; car.setCabin(state.cabin); }
  }

  function lobby() {
    const wrap = h('section', 'lobby');
    const qrCard = h('div', 'card qr-card');
    qrCard.append(h('h2', '', '폰 카메라로 찍어서 참가'));
    const qr = h('div', 'qr'); qrCard.append(qr, h('p', 'code', session.code));
    try { window.ZRideQR.renderSvg(qr, session.joinUrl); } catch { qr.textContent = 'QR을 그리지 못했어요'; }
    qrCard.append(h('p', 'hint', '앱 설치 없이 이름만 쓰면 돼요'));
    const side = h('div', 'card lobby-side');
    const head = h('div', 'side-head'); head.append(h('h2', '', '가족'), h('span', 'count', `${state.players.length} / 4`));
    side.append(head);
    const seats = h('ul', 'seats');
    for (let i = 0; i < 4; i++) {
      const p = state.players[i], li = h('li', p ? 'seat on' : 'seat');
      if (p) {
        li.append(avatar(state.players, p.id, 'lg'));
        const who = h('div', 'who'); who.append(h('b', '', p.name), h('span', p.connected ? 'dot live' : 'dot', p.connected ? '접속 중' : '끊김'));
        li.append(who, button('내보내기', 'ghost small', () => send({ type: 'kick', playerId: p.id })));
      } else li.append(h('span', 'empty-seat', '빈자리'));
      seats.append(li);
    }
    side.append(seats);
    const mode = h('div', 'mode');
    mode.append(h('b', '', state.players.length === 2 ? '2명: 차와 대결' : '3~4명: 숨은 도둑 찾기'),
      h('span', '', state.players.length === 2 ? '차가 몰래 방해해요. 사건을 모두 버티면 승리!' : '이 중 한 명은 몰래 전기를 망치는 도둑이에요.'));
    side.append(mode);
    const full = state.soc >= 95;
    const start = button(full ? '배터리가 거의 다 차서 시작할 수 없어요' : state.players.length < 2 ? '2명부터 시작할 수 있어요' : '시작하기', 'primary big', () => send({ type: 'start' }));
    start.disabled = full || state.players.length < 2;
    side.append(start);
    wrap.append(qrCard, side);
    return wrap;
  }

  /** 가운데 무대: 작은 머리말 + 큰 제목 + 설명 한 줄. 나머지는 필요한 것만 덧붙인다. */
  function panel(eyebrow, title, hint, tone) {
    const wrap = h('section', 'play card' + (tone ? ' tone-' + tone : ''));
    wrap.append(h('p', 'eyebrow', eyebrow), h('h2', 'huge', title));
    if (hint) wrap.append(h('p', 'hint', hint));
    return wrap;
  }
  function people(noteOf) {
    const list = h('ul', 'people');
    for (const p of state.players) list.append(person(state.players, p, noteOf(p), p.done));
    return list;
  }
  function timer(wrap) { timerEl = h('p', 'timer'); wrap.append(timerEl); tick(); }

  const views = {
    LOBBY: lobby,
    BRIEFING() {
      const wrap = h('section', 'brief card');
      wrap.append(h('h2', 'brief-title', '이렇게 해요'), briefList(state.solo));
      const more = h('details', 'fold'); more.append(h('summary', '', '자세한 규칙'), rulesList(state.solo)); wrap.append(more);
      const foot = h('div', 'brief-foot');
      foot.append(people(p => p.done ? '이해했어요' : p.connected ? '읽는 중' : '끊김'), button('바로 시작', 'primary', next));
      wrap.append(foot);
      return wrap;
    },
    CHARGING() {
      const left = Math.max(0, state.nextAt - state.soc);
      const wrap = panel(state.caseNo ? `사건 ${state.caseNo} 끝` : '곧 첫 사건', '충전 중…', `배터리가 ${state.nextAt}%가 되면 다음 사건이 터져요`);
      const bar = h('div', 'charge-bar'); const fill = h('div', 'charge-fill'); fill.style.width = Math.max(4, 100 - left / 5 * 100) + '%'; bar.append(fill);
      wrap.append(bar, h('p', 'charge-left', `앞으로 ${left}%`));
      if (state.caseNo === 0) wrap.append(tip('폰에 내 손패 4장이 보여요. 어떤 카드를 아낄지 미리 생각해 두세요.'));
      return wrap;
    },
    CASE() {
      const { lo, hi } = state.range;
      const wrap = panel(`사건 ${state.caseNo}`, `합계를 ${lo}~${hi} 사이로!`, state.solo ? '차가 몰래 −2~+2를 더해요. 여유를 두세요.' : '차는 합계만 공개해요. 누가 뭘 냈는지는 아무도 몰라요.');
      wrap.append(meter({ lo, hi }));
      timer(wrap);
      wrap.append(people(p => p.done ? '냈어요' : p.connected ? '고르는 중' : '끊김'));
      if (state.caseNo === 1) wrap.append(tip('폰에서 카드 1장을 몰래 내요. "누가 크게 낼래?" 말로 맞춰 보세요. 도둑도 같이 듣고 있어요!'));
      return wrap;
    },
    RESULT() {
      const r = state.result;
      const tone = r.saved ? 'saved' : r.outcome === 'OK' ? 'ok' : r.outcome === 'LOW' ? 'low' : 'high';
      const title = r.saved ? '차단기로 막았어요!' : { OK: '성공!', LOW: '정전!', HIGH: '과부하!' }[r.outcome];
      const why = r.saved ? '퓨즈가 무사해요.' : r.outcome === 'OK' ? '합계가 구간 안에 들어왔어요.' : r.outcome === 'LOW' ? '전기가 모자라 퓨즈가 하나 나갔어요.' : '전기가 넘쳐 퓨즈가 하나 나갔어요.';
      const wrap = panel(`사건 ${state.caseNo} 결과`, title, why, tone);
      wrap.append(meter({ lo: r.lo, hi: r.hi, sum: r.sum }));
      const facts = h('div', 'facts');
      if (r.carNoise) facts.append(h('span', 'fact', `차가 몰래 ${signed(r.carNoise)}`));
      if (state.tampered) facts.append(h('span', 'fact alarm', '누군가 몰래 차를 건드렸어요!'));
      if (facts.childElementCount) wrap.append(facts);
      const actions = h('div', 'actions');
      // 운전석 비상 차단기: 방금 난 피해를 취소한다. 다음 버튼과 붙여 두되 색으로 구분한다
      if (!r.success && !r.saved && state.breakers > 0) {
        const box = h('div', 'breaker');
        box.append(h('small', '', `운전석 비상 차단기 · 남은 ${state.breakers}번`), button('피해 취소하기', 'big danger', () => send({ type: 'breaker' })));
        actions.append(box);
      }
      actions.append(button(state.solo ? '다음' : '토론하기', 'primary big', next));
      wrap.append(actions);
      return wrap;
    },
    TALK() {
      const r = state.result;
      const wrap = panel('토론', '누가 수상한가요?', '폰에 있는 단서를 말해요. 거짓말해도 돼요.');
      // 방금 사건을 옆에 붙여 두어 추리 근거를 다시 찾지 않게 한다
      const last = h('p', 'recap', `방금 사건: 합계 ${r.sum} · 구간 ${r.lo}~${r.hi} · ${r.saved ? '차단기로 막음' : { OK: '성공', LOW: '정전', HIGH: '과부하' }[r.outcome]}` + (state.tampered ? ' · 몰래 장난 있었음' : ''));
      wrap.append(last);
      timer(wrap);
      wrap.append(button('투표하기', 'primary big', next));
      return wrap;
    },
    VOTE() {
      const wrap = panel('비밀 투표', '도둑을 지목하세요', '과반이 지목해야 체포돼요. 억울한 사람을 잡으면 퓨즈가 하나 나가요.');
      timer(wrap);
      wrap.append(people(p => p.done ? '투표했어요' : p.connected ? '고르는 중' : '끊김'));
      return wrap;
    },
    VERDICT() {
      const v = state.verdict;
      const caught = v.arrested && v.caught;
      const wrap = panel('투표 결과', v.arrested ? `${v.arrested} 체포!` : '아무도 체포되지 않았어요',
        v.arrested ? (caught ? '진짜 도둑이었어요!' : '억울한 가족이었어요. 퓨즈가 하나 나갔어요.') : '도둑은 아직 차 안에 있어요.', caught ? 'ok' : v.arrested ? 'high' : '');
      const who = state.players.find(p => p.name === v.arrested);
      if (who) wrap.insertBefore(avatar(state.players, who.id, 'xl'), wrap.children[1]);
      wrap.append(button('다음', 'primary big', next));
      return wrap;
    },
    END() {
      const title = { FAMILY: '가족 승리!', THIEF: '도둑 승리!', CAR: '차가 이겼어요' }[state.winner];
      const wrap = panel('충전 끝', title, state.thief ? `전기 도둑은 ${state.thief}이었어요.` : '다음엔 차를 이겨 봐요.', state.winner === 'FAMILY' ? 'ok' : 'high');
      const thief = state.players.find(p => p.name === state.thief);
      if (thief) wrap.insertBefore(avatar(state.players, thief.id, 'xl'), wrap.children[1]);
      const stats = h('div', 'facts');
      stats.append(h('span', 'fact', `사건 ${state.caseNo} / ${state.cases}`), h('span', 'fact', `남은 퓨즈 ${Math.max(0, state.maxBlackouts - state.blackouts)}`));
      wrap.append(stats, button('한 번 더', 'primary big', next));
      return wrap;
    },
  };

  function render() {
    if (!state) return;
    top();
    const key = state.phase + state.caseNo + (state.phase === 'CHARGING' ? state.nextAt - state.soc : '') + (state.soc >= 95)
      + JSON.stringify(state.players.map(p => [p.name, p.done, p.connected])) + state.tampered + state.result?.saved;
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
  // 서버 연결보다 차 신호가 먼저 왔거나 놓쳤으면 맞춘다
  setInterval(() => { if (withCar && signal?.parked && signal.soc != null && state && (state.soc !== signal.soc || state.socSource !== 'CAR')) send({ type: 'soc', value: signal.soc, source: 'CAR' }); }, 2000);
  setInterval(() => { if (!withCar && state?.phase === 'CHARGING' && state.socSource !== 'CAR' && state.soc < 100) send({ type: 'soc', value: state.soc + 1 }); }, 1500);

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
