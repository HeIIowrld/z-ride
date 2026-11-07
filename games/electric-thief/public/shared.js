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
    ['도둑이 숨어 있어요', '우리 중 한 명은 전기 도둑이에요. 내 역할은 폰에서 나만 봐요.'],
    ['충전되면 사건이 터져요', '배터리가 5% 찰 때마다 모두 폰으로 카드 1장을 몰래 내고, 한 명을 살펴봐요. 그 사람 카드가 보일 수도 있어요.'],
    ['모자라면 정전!', '차는 합계만 알려 줘요. 목표보다 적으면 불이 꺼지고 추워져요. 도둑은 몰래 조명·에어컨을 건드릴 수도 있어요. 정전 3번이면 도둑 승리.'],
    ['말로 찾고, 투표해요', '수상한 사람을 투표로 잡아요. 진짜 도둑이면 가족 승리!'],
  ];
  const SOLO_RULES = [
    ['차가 방해꾼이에요', '오늘은 둘이 한 팀이에요. 차가 몰래 전기를 빼 가요.'],
    ['충전되면 사건이 터져요', '배터리가 5% 찰 때마다 둘 다 폰으로 카드 1장을 내요.'],
    ['모자라면 정전!', '합계가 목표보다 적으면 불이 꺼지고 추워져요. 정전 3번이면 차가 이겨요.'],
    ['끝까지 버티면 승리', '사건을 모두 넘기면 우리가 이겨요.'],
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
