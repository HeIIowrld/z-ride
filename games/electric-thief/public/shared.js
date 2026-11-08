'use strict';
// 큰 화면과 폰이 같이 쓰는 연결 도구. 토큰은 URL에 넣지 않는다.
window.Relay = (() => {
  function h(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }
  /**
   * 아이폰 Safari는 WebSocket이 열리지도 실패하지도 않고 멈출 때가 있고, 화면을 끄면 끊긴다.
   * 8초 안에 auth.ok가 없으면 버리고 다시 붙으며, 화면 복귀·online·pageshow에서도 다시 붙는다.
   */
  function connect({ code, token, onState, onError, onLink, onGone }) {
    let ws = null, retry = 0, live = false, stopped = false, timer = null, watchdog = null;
    function open() {
      if (stopped) return;
      clearTimeout(timer); clearTimeout(watchdog);
      live = false; onLink?.(retry ? 'RETRYING' : 'CONNECTING');
      const socket = ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
      socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', code, token }));
      socket.onmessage = event => {
        if (socket !== ws) return;
        const message = JSON.parse(event.data);
        if (message.type === 'auth.ok') { live = true; retry = 0; clearTimeout(watchdog); onLink?.('LIVE'); }
        else if (message.type === 'state') onState(message.state);
        else if (message.type === 'error') onError?.(message.code);
      };
      socket.onclose = event => {
        if (socket !== ws) return;
        live = false; ws = null; clearTimeout(watchdog);
        if ([4401, 4404, 4409].includes(event.code)) { stopped = true; onGone?.(event.code); return; }
        onLink?.('RETRYING');
        timer = setTimeout(open, Math.min(8000, 500 * 2 ** retry++) + Math.random() * 300);
      };
      watchdog = setTimeout(() => {
        if (socket !== ws || live) return;
        socket.onclose = socket.onmessage = socket.onopen = null;
        try { socket.close(); } catch {}
        ws = null; onLink?.('RETRYING');
        timer = setTimeout(open, 500);
      }, 8000);
    }
    const wake = () => { if (!stopped && !document.hidden && (!ws || ws.readyState !== WebSocket.OPEN)) { retry = 0; open(); } };
    document.addEventListener('visibilitychange', wake);
    addEventListener('online', wake);
    addEventListener('pageshow', wake);
    open();
    return { send: message => { if (!live) return false; ws.send(JSON.stringify(message)); return true; }, isLive: () => live };
  }

  // 큰 화면과 폰이 같은 말로 설명한다
  const RULES = [
    ['도둑이 숨어 있어요', '우리 중 한 명은 전기 도둑이에요. 운전자일 수도 있어요. 내 역할은 폰에서 나만 봐요.'],
    ['카드 4장으로 판 내내', '카드는 −1~+4. 사건마다 1장 내고 1장 새로 뽑아요. 큰 카드는 아껴 쓰세요.'],
    ['전기를 딱 맞게', '배터리가 5% 찰 때마다 차 화면에 구간(예: 7~9)이 떠요. 모두 카드 1장을 몰래 내요. 모자라면 정전, 넘치면 과부하! 퓨즈 3개가 나가면 도둑 승리.'],
    ['살펴보고, 투표해요', '한 명을 살펴보면 그 사람 카드가 보일 수 있어요. 수상한 사람을 투표로 잡아요. 진짜 도둑이면 가족 승리!'],
    ['운전석 비상 차단기', '차 화면에서 한 판에 2번, 방금 난 정전·과부하를 취소할 수 있어요.'],
  ];
  const SOLO_RULES = [
    ['차가 방해꾼이에요', '오늘은 둘이 한 팀이에요. 차가 매번 몰래 −2~+2를 더해요.'],
    ['카드 4장으로 판 내내', '카드는 −1~+4. 사건마다 1장 내고 1장 새로 뽑아요.'],
    ['전기를 딱 맞게', '차 화면의 구간에 합계를 맞춰요. 모자라면 정전, 넘치면 과부하! 차가 더할 몫을 생각해 여유를 두세요.'],
    ['끝까지 버티면 승리', '퓨즈 3개가 나가기 전에 사건을 모두 넘기면 우리가 이겨요. 비상 차단기는 한 번!'],
  ];
  function rulesList(solo) {
    const list = h('ol', 'rules');
    for (const [title, text] of solo ? SOLO_RULES : RULES) { const li = h('li'); li.append(h('b', '', title), h('span', '', text)); list.append(li); }
    return list;
  }

  async function post(path, body = {}) {
    const res = await fetch(path, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const value = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(value.error || 'NETWORK');
    return value;
  }

  const store = {
    get(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
    drop(key) { try { localStorage.removeItem(key); } catch {} },
  };
  const secondsLeft = deadline => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));

  return { h, connect, post, store, secondsLeft, rulesList };
})();
