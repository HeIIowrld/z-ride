'use strict';
// 큰 화면과 폰이 같이 쓰는 그림·연결 도구. 토큰은 URL에 넣지 않는다.
window.Relay = (() => {
  const PALETTE = ['#1e2a3a', '#e5484d', '#1f7ae0', '#17935c', '#f59e0b', '#8b5a2b'];
  const WIDTHS = [7, 16, 34];

  function h(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }
  function paper() { const c = h('canvas', 'paper'); c.width = c.height = 1000; return c; }

  /** limit: 앞에서부터 그릴 점 개수(다시 그리기용). */
  function paint(canvas, drawing, limit = Infinity) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1000, 1000);
    ctx.lineCap = ctx.lineJoin = 'round';
    let left = limit;
    for (const s of drawing?.strokes ?? []) {
      if (left <= 0) break;
      const points = Math.min(s.p.length / 2, left);
      left -= points;
      ctx.strokeStyle = ctx.fillStyle = PALETTE[s.c]; ctx.lineWidth = WIDTHS[s.w];
      if (points === 1) { ctx.beginPath(); ctx.arc(s.p[0], s.p[1], WIDTHS[s.w] / 2, 0, 7); ctx.fill(); continue; }
      ctx.beginPath(); ctx.moveTo(s.p[0], s.p[1]);
      for (let i = 1; i < points; i++) ctx.lineTo(s.p[i * 2], s.p[i * 2 + 1]);
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
  }

  function replay(canvas, drawing, ms = 2400) {
    const total = (drawing?.strokes ?? []).reduce((n, s) => n + s.p.length / 2, 0);
    const start = performance.now();
    const frame = t => {
      const done = Math.min(1, (t - start) / ms);
      paint(canvas, drawing, Math.ceil(total * done));
      if (done < 1 && canvas.isConnected) requestAnimationFrame(frame);
    };
    paint(canvas, null);
    requestAnimationFrame(frame);
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
      const socket = ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws?room=' + encodeURIComponent(code));
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

  // 사람마다 색 하나. 이름 첫 글자 동그라미로 어디서나 같은 사람을 알아보게 한다
  const COLORS = ['#ffd23f', '#5fd0c0', '#ff9aa8', '#a9bcff'];
  function avatar(players, id, size) {
    const index = players.findIndex(p => p.id === id), p = players[index];
    const el = h('span', 'ava' + (size ? ' ' + size : ''), p ? [...p.name][0] : '?');
    el.style.setProperty('--c', COLORS[(index < 0 ? 0 : index) % COLORS.length]);
    return el;
  }
  function person(players, p, note, done) {
    const li = h('li', 'person' + (done ? ' done' : '') + (p.connected === false ? ' off' : ''));
    li.append(avatar(players, p.id), h('b', '', p.name));
    if (note) li.append(h('span', 'note', note));
    return li;
  }
  function tip(text) { const el = h('p', 'tip'); el.append(h('b', '', '팁'), h('span', '', text)); return el; }

  /**
   * 스케치북은 자리 순서대로 옆 사람에게 넘어간다(스케치북 b의 s번째 칸은 b+1+s번 사람).
   * 그래서 지금 내 스케치북은 늘 바로 앞사람에게서 받고 바로 뒷사람에게 넘긴다.
   */
  function relayOf(players, id, step, steps) {
    const n = players.length, i = players.findIndex(p => p.id === id);
    return { from: step === 0 ? null : players[(i - 1 + n) % n], to: step + 1 >= steps ? null : players[(i + 1) % n] };
  }
  /** 바통 띠: 받은 사람 → 나 → 넘길 사람. 결승이면 깃발. */
  function baton(players, id, step, steps) {
    const { from, to } = relayOf(players, id, step, steps);
    const strip = h('div', 'baton');
    const node = (p, label) => { const n = h('div', 'baton-node'); if (p) n.append(avatar(players, p.id)); else n.append(h('span', 'flag', label === '단어 카드' ? '가' : '🏁')); n.append(h('small', '', p ? p.name : label)); return n; };
    strip.append(node(from, '단어 카드'), h('span', 'baton-arrow', '→'), (() => { const n = node(players.find(p => p.id === id)); n.classList.add('me'); n.querySelector('small').textContent = '나'; return n; })(), h('span', 'baton-arrow', '→'), node(to, '결승'));
    return strip;
  }
  /** 이번 판의 구간들: 그리기·맞히기가 번갈아 이어지고 마지막이 결승. */
  function legs(step, steps, kindOf) {
    const list = h('ol', 'legs');
    for (let s = 0; s < steps; s++) {
      const li = h('li', s < step ? 'past' : s === step ? 'on' : '');
      li.append(h('small', '', s + 1 === steps ? '결승' : `${s + 1}구간`), h('b', '', kindOf(s) === 'DRAW' ? '그리기' : '맞히기'));
      list.append(li);
    }
    return list;
  }

  return { PALETTE, WIDTHS, h, paper, paint, replay, connect, post, store, secondsLeft, avatar, person, tip, relayOf, baton, legs };
})();
