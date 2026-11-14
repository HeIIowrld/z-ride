'use strict';
// 큰 화면과 폰이 같이 쓰는 연결·표시 도구. 토큰은 URL에 넣지 않는다.
window.Tug = (() => {
  function h(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }
  // 실내등에는 민트·핑크가 없어서 가장 가까운 GREEN·PURPLE을 쓴다
  const TEAM = { MINT: { name: '민트', light: 'GREEN' }, PINK: { name: '핑크', light: 'PURPLE' } };
  /** 팀색 동그라미에 이름 첫 글자. */
  function avatar(p, size) {
    const el = h('span', `ava ${p.team === 'PINK' ? 'pink' : 'mint'}` + (size ? ' ' + size : ''), [...p.name][0] ?? '?');
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


  function tip(text) { const el = h('p', 'tip'); el.append(h('b', '', '팁'), h('span', '', text)); return el; }

  return { h, TEAM, avatar, connect, post, store, secondsLeft, tip };
})();
