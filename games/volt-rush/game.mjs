// Volt Rush 규칙. 각자 모서리에서 출발해 선을 깔며 가운데 충전기에 먼저 닿는다.
// 지나간 칸은 벽이 된다. 한 칸에 ⚡1. ⚡는 판 전체에서 한 번만 받는다(충전할 양만큼).
export const W = 13, H = 9;
export const CHARGER = { x: 6, y: 4 };
export const COLORS = ['MINT', 'PINK', 'YELLOW', 'BLUE'];
// 2명이면 대각선으로 마주 보게 순서를 둔다
const STARTS = [{ x: 0, y: 0 }, { x: 12, y: 8 }, { x: 12, y: 0 }, { x: 0, y: 8 }];
const DIRS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
export const MAX_PLAYERS = 4, ROUNDS = 3;
export const READY_MS = 3000, ROUND_MS = 90_000, GAP_MS = 6000;
export const MOVE_GAP_MS = 130; // 패드 연타로 순간이동하지 않게
export const BOLT = 3, ITEM_CELL = 5, BOOST_MS = 8000, BLACKOUT_MS = 5000, SHIELD_MS = 10_000, SCAN_MS = 6000;
const WALL = -2, EMPTY = -1;

// 주행 중 얻은 아이템이 들어올 자리. 루트 시스템이 붙기 전까지는 테스트 가방에서 2개씩 준다
export const ITEMS = {
  JUMP: { name: '절연 장갑', tag: 'escape', desc: '다음 한 번, 막힌 칸을 뛰어넘어요' },
  CUT: { name: '고전압 코일', tag: 'attack', desc: '앞쪽 3칸의 남의 선을 끊어요' },
  SHIELD: { name: '네온 방패', tag: 'defense', desc: '10초 동안 내 선이 안 끊겨요' },
  SCAN: { name: '신호 다트', tag: 'detection', desc: '충전기까지 가장 짧은 길을 보여 줘요' },
  CELL: { name: '배터리 셀', tag: 'part', desc: '⚡+5' },
};
const TEST_SOURCES = ['빗방울 캐치', '폴짝 전봇대', '면허 퀴즈', '길 위 상자'];
export const EVENTS = ['SURGE', 'BOOST', 'BLACKOUT'];

/** 충전할 양(목표 − 지금)으로 ⚡ 예산을 정한다. 많이 충전하는 날일수록 넉넉하다. */
export function budgetFor(soc, target) {
  const diff = Number.isFinite(soc) && Number.isFinite(target) ? Math.max(0, target - soc) : 40;
  return Math.max(35, Math.min(80, Math.round(diff * 0.8) + 20));
}

const at = (x, y) => y * W + x;
const xy = i => ({ x: i % W, y: Math.floor(i / W) });
const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
const CHARGER_I = at(CHARGER.x, CHARGER.y);

export class Game {
  constructor({ now = Date.now, rng = Math.random } = {}) {
    this.now = now; this.rng = rng;
    this.players = [];
    this.phase = 'LOBBY'; this.round = 0; this.deadline = null;
    this.occ = new Array(W * H).fill(EMPTY); this.bolts = new Set();
    this.soc = null; this.target = 80; this.budget = budgetFor(null, null);
    this.event = null; this.eventCount = 0;
    this.roundWinner = null; this.winners = [];
    this.uid = 0;
  }

  addPlayer(id, name) {
    if (this.phase !== 'LOBBY') throw new Error('GAME_STARTED');
    if (this.players.length >= MAX_PLAYERS) throw new Error('ROOM_FULL');
    const color = COLORS.find(c => !this.players.some(p => p.color === c));
    this.players.push({ id, name, color, connected: false, score: 0, energy: 0, bag: [], x: 0, y: 0, dir: 'R', trail: [], lastMove: 0, jump: false, shieldUntil: 0, scanUntil: 0 });
  }
  removePlayer(id) {
    const i = this.players.findIndex(p => p.id === id);
    if (i < 0) return;
    if (this.phase !== 'LOBBY') { for (const c of this.players[i].trail) if (c != null && this.occ[c] === i) this.occ[c] = EMPTY; }
    this.players.splice(i, 1);
    if (this.phase !== 'LOBBY') this.backToLobby();
  }
  setConnected(id, on) { const p = this.players.find(x => x.id === id); if (p) p.connected = on; }

  /** 차 화면이 보낸 배터리 값. 게임 중 10% 단위를 넘으면 이벤트가 터진다. */
  setSoc(soc, target) {
    soc = Math.round(Number(soc));
    if (!Number.isFinite(soc) || soc < 0 || soc > 100) throw new Error('BAD_SOC');
    if (target != null) {
      const t = Math.round(Number(target));
      if (!Number.isFinite(t) || t < 50 || t > 100) throw new Error('BAD_TARGET');
      if (this.phase === 'LOBBY') this.target = t;
    }
    const before = this.soc;
    this.soc = soc;
    if (this.phase === 'LOBBY') this.budget = budgetFor(this.soc, this.target);
    if (this.phase === 'PLAY' && before != null && Math.floor(soc / 10) > Math.floor(before / 10)) this.trigger();
  }

  /** 이벤트를 하나 터뜨린다. 서지 → 무료 이동 → 정전 순서로 돈다. */
  trigger(kind = EVENTS[this.eventCount % EVENTS.length]) {
    this.eventCount += 1;
    const t = this.now();
    if (kind === 'SURGE') {
      // 머리만 남기고 모든 선을 지운다. 막혀 있던 사람에게 다시 길이 열린다
      this.players.forEach((p, i) => {
        for (const c of p.trail) if (c != null && this.occ[c] === i) this.occ[c] = EMPTY;
        const head = at(p.x, p.y); this.occ[head] = i; p.trail = [head];
      });
      this.event = { kind, until: t + 2500 };
    } else if (kind === 'BOOST') this.event = { kind, until: t + BOOST_MS };
    else this.event = { kind, until: t + BLACKOUT_MS };
  }

  start() {
    if (this.phase !== 'LOBBY' && this.phase !== 'END') throw new Error('NOT_LOBBY');
    if (this.players.length < 2) throw new Error('NEED_PLAYERS');
    this.budget = budgetFor(this.soc, this.target);
    const kinds = Object.keys(ITEMS);
    for (const p of this.players) {
      p.score = 0; p.energy = this.budget;
      const pick = [...kinds].sort(() => this.rng() - 0.5).slice(0, 2);
      p.bag = pick.map(kind => ({ id: `i${++this.uid}`, kind, from: TEST_SOURCES[Math.floor(this.rng() * TEST_SOURCES.length)] }));
    }
    this.round = 0; this.winners = []; this.eventCount = 0;
    this.nextRound();
  }

  nextRound() {
    this.round += 1;
    this.buildMap();
    this.players.forEach((p, i) => {
      const s = STARTS[i];
      p.x = s.x; p.y = s.y; p.dir = s.x === 0 ? 'R' : 'L';
      p.trail = [at(s.x, s.y)]; this.occ[at(s.x, s.y)] = i;
      p.lastMove = 0; p.jump = false; p.shieldUntil = 0; p.scanUntil = 0;
    });
    this.event = null; this.roundWinner = null;
    this.phase = 'READY'; this.deadline = this.now() + READY_MS;
  }

  /** 네 귀퉁이가 똑같이 공평하도록 왼쪽 위 1/4에 벽·⚡를 놓고 상하좌우로 뒤집어 복사한다. */
  buildMap() {
    for (let attempt = 0; attempt < 50; attempt++) {
      this.occ.fill(EMPTY); this.bolts.clear();
      const free = (x, y) => x <= 5 && y <= 3 && x + y > 1 && !(x === 5 && y === 3);
      const mirror = (x, y) => [[x, y], [W - 1 - x, y], [x, H - 1 - y], [W - 1 - x, H - 1 - y]];
      for (let n = 0; n < 3; n++) {
        const x = Math.floor(this.rng() * 6), y = Math.floor(this.rng() * 4);
        const [dx, dy] = this.rng() < 0.5 ? [1, 0] : [0, 1];
        for (const [cx, cy] of [[x, y], [x + dx, y + dy]]) if (free(cx, cy)) for (const [mx, my] of mirror(cx, cy)) this.occ[at(mx, my)] = WALL;
      }
      for (let n = 0; n < 2; n++) {
        const x = Math.floor(this.rng() * 6), y = Math.floor(this.rng() * 4);
        if (free(x, y) && this.occ[at(x, y)] === EMPTY) for (const [mx, my] of mirror(x, y)) this.bolts.add(at(mx, my));
      }
      if (STARTS.every(s => this.path(at(s.x, s.y)))) return;
    }
    this.occ.fill(EMPTY); this.bolts.clear();
  }

  /** 출발 칸에서 충전기까지 가장 짧은 길(칸 번호 목록). 없으면 null. */
  path(from) {
    const prev = new Map([[from, -1]]), queue = [from];
    while (queue.length) {
      const c = queue.shift();
      if (c === CHARGER_I) { const out = []; for (let k = c; k !== -1; k = prev.get(k)) out.push(k); return out.reverse(); }
      const { x, y } = xy(c);
      for (const [dx, dy] of Object.values(DIRS)) {
        const nx = x + dx, ny = y + dy, n = at(nx, ny);
        if (inside(nx, ny) && !prev.has(n) && (n === CHARGER_I || this.occ[n] === EMPTY)) { prev.set(n, c); queue.push(n); }
      }
    }
    return null;
  }

  expire() {
    if (this.phase === 'READY') { this.phase = 'PLAY'; this.deadline = this.now() + ROUND_MS; }
    else if (this.phase === 'PLAY') this.finishRound(null);
    else if (this.phase === 'ROUND_END') this.next();
  }
  next() {
    if (this.phase !== 'ROUND_END') return;
    if (this.round >= ROUNDS) this.finish(); else this.nextRound();
  }

  boosting() { return this.event?.kind === 'BOOST' && this.event.until > this.now(); }
  /** 이 칸으로 들어갈 수 있나. 충전기는 늘 열려 있다. */
  open(n) { return n === CHARGER_I || this.occ[n] === EMPTY; }
  canMove(p) {
    if (!this.boosting() && p.energy <= 0) return false;
    if (p.jump || p.bag.some(b => b.kind === 'JUMP' || b.kind === 'CUT')) return true;
    return Object.values(DIRS).some(([dx, dy]) => inside(p.x + dx, p.y + dy) && this.open(at(p.x + dx, p.y + dy)));
  }

  move(id, dir) {
    if (this.phase !== 'PLAY' || !DIRS[dir]) return;
    const i = this.players.findIndex(p => p.id === id), p = this.players[i];
    if (!p) return;
    const t = this.now();
    if (t - p.lastMove < MOVE_GAP_MS) return;
    const cost = this.boosting() ? 0 : 1;
    if (p.energy < cost) return;
    const [dx, dy] = DIRS[dir];
    let nx = p.x + dx, ny = p.y + dy;
    p.dir = dir;
    if (!inside(nx, ny)) return;
    if (!this.open(at(nx, ny))) {
      // 절연 장갑: 막힌 칸 하나를 건너 그 뒤 칸에 내린다
      const jx = nx + dx, jy = ny + dy;
      if (!p.jump || !inside(jx, jy) || !this.open(at(jx, jy))) return;
      p.jump = false; nx = jx; ny = jy;
    }
    p.lastMove = t; p.energy -= cost;
    const n = at(nx, ny);
    p.x = nx; p.y = ny;
    if (n === CHARGER_I) { this.finishRound(p.id); return; }
    this.occ[n] = i; p.trail.push(n);
    if (this.bolts.delete(n)) p.energy += BOLT;
    if (!this.players.some(q => this.canMove(q))) this.finishRound(null);
  }

  useItem(id, itemId) {
    if (this.phase !== 'PLAY') throw new Error('NOT_PLAYING');
    const i = this.players.findIndex(p => p.id === id), p = this.players[i];
    const k = p?.bag.findIndex(b => b.id === itemId) ?? -1;
    if (k < 0) throw new Error('NO_ITEM');
    const [item] = p.bag.splice(k, 1), t = this.now();
    if (item.kind === 'JUMP') p.jump = true;
    else if (item.kind === 'SHIELD') p.shieldUntil = t + SHIELD_MS;
    else if (item.kind === 'SCAN') p.scanUntil = t + SCAN_MS;
    else if (item.kind === 'CELL') p.energy += ITEM_CELL;
    else if (item.kind === 'CUT') {
      const [dx, dy] = DIRS[p.dir];
      for (let s = 1; s <= 3; s++) {
        const cx = p.x + dx * s, cy = p.y + dy * s;
        if (!inside(cx, cy)) break;
        const c = at(cx, cy), owner = this.occ[c];
        if (owner < 0 || owner === i) continue;
        const q = this.players[owner];
        if (q.shieldUntil > t || (q.x === cx && q.y === cy)) continue;
        this.occ[c] = EMPTY;
        q.trail = q.trail.map(v => (v === c ? null : v));
      }
    }
    if (!this.players.some(q => this.canMove(q))) this.finishRound(null);
    return item;
  }

  /** 아무도 못 닿았으면 충전기에 가장 가까운 한 명이 가져간다(같으면 없음). */
  finishRound(winnerId) {
    if (this.phase !== 'PLAY') return;
    let w = winnerId;
    if (!w) {
      const d = this.players.map(p => Math.abs(p.x - CHARGER.x) + Math.abs(p.y - CHARGER.y));
      const best = Math.min(...d);
      if (d.filter(v => v === best).length === 1) w = this.players[d.indexOf(best)].id;
    }
    const p = this.players.find(x => x.id === w);
    if (p) p.score += 1;
    this.roundWinner = p?.id ?? null;
    this.phase = 'ROUND_END'; this.deadline = this.now() + GAP_MS;
  }

  finish() {
    this.phase = 'END'; this.deadline = null;
    const top = Math.max(...this.players.map(p => p.score));
    let best = this.players.filter(p => p.score === top);
    const most = Math.max(...best.map(p => p.energy));
    best = best.filter(p => p.energy === most);
    this.winners = best.map(p => p.id);
  }

  backToLobby() {
    this.phase = 'LOBBY'; this.round = 0; this.deadline = null; this.event = null;
    this.occ.fill(EMPTY); this.bolts.clear(); this.roundWinner = null; this.winners = [];
    for (const p of this.players) { p.trail = []; p.bag = []; p.score = 0; p.energy = 0; }
  }

  publicView() {
    const t = this.now();
    const walls = [];
    this.occ.forEach((v, i) => { if (v === WALL) walls.push(i); });
    return {
      phase: this.phase, round: this.round, rounds: ROUNDS, deadline: this.deadline, serverNow: t,
      w: W, h: H, charger: CHARGER, walls, bolts: [...this.bolts],
      soc: this.soc, target: this.target, budget: this.budget,
      event: this.event && this.event.until > t ? this.event : null,
      roundWinner: this.roundWinner, winners: this.winners,
      players: this.players.map(p => ({
        id: p.id, name: p.name, color: p.color, connected: p.connected, score: p.score, energy: p.energy,
        x: p.x, y: p.y, trail: p.trail, items: p.bag.length, stuck: this.phase === 'PLAY' && !this.canMove(p),
        shield: p.shieldUntil > t, dist: Math.abs(p.x - CHARGER.x) + Math.abs(p.y - CHARGER.y),
        scan: p.scanUntil > t ? this.path(at(p.x, p.y)) : null,
      })),
    };
  }
  playerView(id) {
    const p = this.players.find(x => x.id === id);
    return { ...this.publicView(), me: id, jump: !!p?.jump, bag: (p?.bag ?? []).map(b => ({ ...b, ...ITEMS[b.kind] })) };
  }
}
