'use strict';
// 게임 카드. 주소는 /links.json에서 받는다(터널을 열 때마다 바뀐다).
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const GAMES = [
    {
      id: 'power-castle', tag: 'BATTLE · 2–4명', time: '판당 3분', color: '#3ef2ff',
      title: 'Power Castle', desc: '폰 하나가 성 하나. 내 성에 전기를 모으고, 남의 성 전기를 끌어와요. 방패는 타이밍!',
      art: g => {
        const castle = (x, c) => line(g, `M${x - 22} 74 V48 h7 v-7 h6 v7 h5 v-15 h12 v15 h5 v-7 h6 v7 h7 V74 Z`, c);
        castle(48, '#3ef2ff'); castle(232, '#ff3d9a');
        line(g, 'M140 30 l16 9 v18 l-16 9 l-16 -9 v-18 z', '#a66bff');
        line(g, 'M72 60 L124 52 M208 60 L156 52', '#3ef2ff', .6);
        line(g, 'M210 36 L190 46 L172 30 L150 44', '#ff3d9a');
      },
    },
    {
      id: 'volt-rush', tag: 'RACE · 2–4명', time: '판당 90초', color: '#ffd23f',
      title: 'Volt Rush', desc: '선을 깔며 가운데 충전기로 달려요. 지나간 길은 벽이 되니 상대 앞을 막아요.',
      art: g => {
        for (let x = 20; x <= 260; x += 24) line(g, `M${x} 14 V86`, '#2a2350', 1);
        for (let y = 14; y <= 86; y += 24) line(g, `M20 ${y} H260`, '#2a2350', 1);
        line(g, 'M20 14 H92 V38 H116 V50', '#2bffc6');
        line(g, 'M260 86 H188 V62 H164 V50', '#ff2d95');
        rect(g, 128, 38, 24, 24, '#ffd23f');
      },
    },
    {
      id: 'power-tug', tag: 'TEAM · 2–4명', time: '판당 20초', color: '#2bffc6',
      title: 'Power Tug', desc: '두 팀으로 나눠 폰을 연타해요. 가운데 불꽃을 우리 팀 배터리로 끌어오면 승리.',
      art: g => {
        rect(g, 24, 22, 40, 60, '#2bffc6', true); rect(g, 216, 22, 40, 60, '#ff2d95', true);
        line(g, 'M64 52 H216', '#55607a', 3);
        const spark = document.createElementNS(NS, 'circle');
        for (const [k, v] of Object.entries({ cx: 118, cy: 52, r: 9, fill: '#ffd23f' })) spark.setAttribute(k, v);
        g.append(spark);
      },
    },
    {
      id: 'charge-relay', tag: 'DRAW · 2–4명', time: '판당 5~8분', color: '#ff9a3c',
      title: '충전 릴레이', desc: '제시어를 그림으로, 그림을 답으로 돌려 가며 전달해요. 마지막에 다 같이 공개!',
      art: g => {
        line(g, 'M30 70 C60 20 90 80 120 40 S170 30 190 60', '#ff9a3c');
        line(g, 'M200 72 L246 26 L256 36 L210 82 Z M200 72 L196 86 L210 82', '#efeaff', 1.6);
      },
    },
  ];

  function line(g, d, color, width = 2.2) {
    const p = document.createElementNS(NS, 'path');
    for (const [k, v] of Object.entries({ d, fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) p.setAttribute(k, v);
    g.append(p);
  }
  function rect(g, x, y, w, h, color, battery) {
    const r = document.createElementNS(NS, 'rect');
    for (const [k, v] of Object.entries({ x, y, width: w, height: h, rx: battery ? 6 : 5, fill: battery ? 'none' : color, stroke: color, 'stroke-width': 2.2 })) r.setAttribute(k, v);
    g.append(r);
    if (battery) line(g, `M${x + 8} ${y + h - 10} H${x + w - 8} M${x + 8} ${y + h - 20} H${x + w - 8}`, color, 4);
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function card(game, url) {
    const c = el('article', 'game');
    c.style.setProperty('--accent', game.color);
    const art = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 280 100', class: 'art', 'aria-hidden': 'true' })) art.setAttribute(k, v);
    game.art(art);
    const head = el('div', 'game-head');
    head.append(el('p', 'label', game.tag), el('span', 'time', game.time));
    const actions = el('div', 'actions');
    const host = el('a', 'btn primary', '큰 화면으로 방 만들기'); host.href = `${url}/`;
    const join = el('a', 'btn', '코드로 참가'); join.href = `${url}/p`;
    actions.append(host, join);
    c.append(art, head, el('h3', '', game.title), el('p', 'desc', game.desc), actions);
    return c;
  }

  async function load() {
    const box = document.getElementById('games');
    let links = {};
    try { links = await (await fetch('/links.json', { cache: 'no-store' })).json(); } catch { /* 주소를 못 받으면 카드만 보인다 */ }
    box.replaceChildren(...GAMES.map(g => card(g, links[g.id] ?? '')));
  }
  load();
})();
