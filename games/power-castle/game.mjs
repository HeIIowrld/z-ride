// Power Castle 규칙. 각자 자기 성에 전기를 모으고, 남의 성 전기를 끌어온다.
// 먼저 목표만큼 채우면 그 판을 이긴다. 3판 중 2판을 먼저 이기면 최종 승리.
export const MAX_PLAYERS = 4, WINS_NEEDED = 2, MAX_ROUNDS = 3;
export const RULES_MS = 15_000, READY_MS = 3000, ROUND_MS = 180_000, GAP_MS = 6000, TICK_MS = 1000;
export const START_POWER = 20, RATE = 0.6; // 케이블 1가닥당 초당 ⚡
export const MAX_CABLES = 3, BOLT_MS = 3000, DRAIN = 15, SHIELD_MS = 5000, OVER_MS = 10_000;
export const SURGE_AT_MS = 90_000, SURGE_MS = 10_000, SURGE_X = 3;
export const COST = { cable: 10, drain: 8, shield: 6, over: 12 };
export const COLORS = ['CYAN', 'PINK', 'AMBER', 'INDIGO'];

/** 충전할 양이 많은(오래 머무는) 날은 목표를 높여 판을 길게 한다. 시작할 때 한 번만 쓴다. */
export function goalFor(soc, target) {
  if (!Number.isFinite(soc) || !Number.isFinite(target)) return 100;
  return target - soc >= 40 ? 150 : 100;
}

export class Game {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.players = [];
    this.phase = 'LOBBY'; this.round = 0; this.deadline = null;
    this.soc = null; this.target = 80; this.goal = goalFor(null, null);
    this.bolts = []; this.uid = 0;
    this.lastTick = null; this.nextTick = null; this.roundStart = null;
    this.roundWinner = null; this.winners = [];
  }

  addPlayer(id, name) {
    if (this.phase !== 'LOBBY') throw new Error('GAME_STARTED');
    if (this.players.length >= MAX_PLAYERS) throw new Error('ROOM_FULL');
    const color = COLORS.find(c => !this.players.some(p => p.color === c));
    this.players.push({ id, name, color, connected: false, power: 0, cables: 1, shieldUntil: 0, overUntil: 0, wins: 0, drained: 0, blocked: 0 });
  }
  removePlayer(id) {
    const i = this.players.findIndex(p => p.id === id);
    if (i < 0) return;
    this.players.splice(i, 1);
    if (this.phase !== 'LOBBY') this.backToLobby();
  }
  setConnected(id, on) { const p = this.players.find(x => x.id === id); if (p) p.connected = on; }

  setSoc(soc, target) {
    soc = Math.round(Number(soc));
    if (!Number.isFinite(soc) || soc < 0 || soc > 100) throw new Error('BAD_SOC');
    if (target != null) {
      const t = Math.round(Number(target));
      if (!Number.isFinite(t) || t < 50 || t > 100) throw new Error('BAD_TARGET');
      if (this.phase === 'LOBBY') this.target = t;
    }
    this.soc = soc;
    if (this.phase === 'LOBBY') this.goal = goalFor(this.soc, this.target);
  }

  /** 시작을 누르면 먼저 차 화면에 규칙을 띄운다. */
  start() {
    if (this.phase !== 'LOBBY' && this.phase !== 'END') throw new Error('NOT_LOBBY');
    if (this.players.length < 2) throw new Error('NEED_PLAYERS');
    this.goal = goalFor(this.soc, this.target);
    for (const p of this.players) p.wins = 0;
    this.round = 0; this.winners = [];
    this.phase = 'RULES'; this.deadline = this.now() + RULES_MS;
  }
  skipRules() { if (this.phase === 'RULES') this.nextRound(); }

  nextRound() {
    this.round += 1;
    for (const p of this.players) Object.assign(p, { power: START_POWER, cables: 1, shieldUntil: 0, overUntil: 0, drained: 0, blocked: 0 });
    this.bolts = []; this.roundWinner = null;
    this.phase = 'READY'; this.deadline = this.now() + READY_MS;
  }

  surging(t = this.now()) {
    return this.phase === 'PLAY' && t - this.roundStart >= SURGE_AT_MS && t - this.roundStart < SURGE_AT_MS + SURGE_MS;
  }

  /** 서버가 다음에 깨어날 시각: 마감·다음 정산·번개 도착 중 가장 이른 것. */
  wakeAt() {
    const times = [this.deadline];
    if (this.phase === 'PLAY') { times.push(this.nextTick); for (const b of this.bolts) times.push(b.arriveAt); }
    const next = times.filter(v => v != null);
    return next.length ? Math.min(...next) : null;
  }
  wake() {
    const t = this.now();
    if (this.phase === 'PLAY') { this.settle(t); if (this.phase !== 'PLAY') return; }
    if (this.deadline != null && t >= this.deadline) this.expire();
  }
  expire() {
    const t = this.now();
    if (this.phase === 'RULES') this.nextRound();
    else if (this.phase === 'READY') {
      this.phase = 'PLAY'; this.deadline = t + ROUND_MS; this.roundStart = t;
      this.lastTick = t; this.nextTick = t + TICK_MS;
    } else if (this.phase === 'PLAY') { this.settle(t); if (this.phase === 'PLAY') this.finishRound(null); }
    else if (this.phase === 'ROUND_END') this.next();
  }
  next() {
    if (this.phase !== 'ROUND_END') return;
    if (this.players.some(p => p.wins >= WINS_NEEDED) || this.round >= MAX_ROUNDS) this.finish(); else this.nextRound();
  }

  /** 지난 정산 이후 흐른 시간만큼 발전소 전기를 나눠 주고, 도착한 번개를 처리한다. */
  settle(t = this.now()) {
    if (this.phase !== 'PLAY') return;
    const from = this.lastTick, to = Math.min(t, this.deadline);
    if (to > from) {
      // 폭주 구간과 겹치는 시간만큼 3배
      const s0 = this.roundStart + SURGE_AT_MS, s1 = s0 + SURGE_MS;
      const surge = Math.max(0, Math.min(to, s1) - Math.max(from, s0));
      const secs = (to - from + surge * (SURGE_X - 1)) / 1000;
      for (const p of this.players) {
        const over = Math.max(0, Math.min(to, p.overUntil) - from) / 1000;
        p.power += p.cables * RATE * (secs + over);
      }
      this.lastTick = to;
    }
    this.nextTick = this.lastTick + TICK_MS;
    for (const b of this.bolts.filter(x => x.arriveAt <= t)) this.land(b);
    this.bolts = this.bolts.filter(x => x.arriveAt > t);
    this.checkWin();
  }

  land(b) {
    const from = this.players.find(p => p.id === b.from), to = this.players.find(p => p.id === b.to);
    if (!from || !to) return;
    if (to.shieldUntil >= b.arriveAt) { to.blocked += 1; b.result = 'BLOCKED'; return; }
    const take = Math.min(DRAIN, Math.floor(to.power));
    to.power -= take; from.power += take; from.drained += take;
  }

  checkWin() {
    const done = this.players.filter(p => p.power >= this.goal).sort((a, b) => b.power - a.power);
    if (done.length) this.finishRound(done[0].id);
  }

  act(id, kind, targetId) {
    if (this.phase !== 'PLAY') throw new Error('NOT_PLAYING');
    const t = this.now();
    this.settle(t);
    if (this.phase !== 'PLAY') return;
    const p = this.players.find(x => x.id === id);
    if (!p) throw new Error('NO_PLAYER');
    const cost = COST[kind];
    if (cost == null) throw new Error('BAD_ACTION');
    if (p.power < cost) throw new Error('NO_POWER');
    if (kind === 'cable') {
      if (p.cables >= MAX_CABLES) throw new Error('MAX_CABLES');
      p.cables += 1;
    } else if (kind === 'drain') {
      const target = this.players.find(x => x.id === targetId);
      if (!target || target.id === id) throw new Error('BAD_TARGET');
      if (this.bolts.some(b => b.from === id)) throw new Error('BOLT_FLYING');
      this.bolts.push({ id: `b${++this.uid}`, from: id, to: target.id, arriveAt: t + BOLT_MS });
    } else if (kind === 'shield') {
      if (p.overUntil > t) throw new Error('OVERCHARGED');
      p.shieldUntil = t + SHIELD_MS;
    } else if (kind === 'over') p.overUntil = t + OVER_MS;
    p.power -= cost;
  }

  finishRound(winnerId) {
    if (this.phase !== 'PLAY') return;
    let w = winnerId;
    if (!w) {
      const top = Math.max(...this.players.map(p => Math.floor(p.power)));
      const best = this.players.filter(p => Math.floor(p.power) === top);
      if (best.length === 1) w = best[0].id;
    }
    const p = this.players.find(x => x.id === w);
    if (p) p.wins += 1;
    this.roundWinner = p?.id ?? null;
    this.bolts = [];
    this.phase = 'ROUND_END'; this.deadline = this.now() + GAP_MS;
  }

  finish() {
    this.phase = 'END'; this.deadline = null;
    const top = Math.max(...this.players.map(p => p.wins));
    this.winners = this.players.filter(p => p.wins === top).map(p => p.id);
  }

  backToLobby() {
    this.phase = 'LOBBY'; this.round = 0; this.deadline = null; this.bolts = [];
    this.roundWinner = null; this.winners = [];
    for (const p of this.players) Object.assign(p, { power: 0, cables: 1, wins: 0 });
  }

  publicView() {
    const t = this.now();
    return {
      phase: this.phase, round: this.round, maxRounds: MAX_ROUNDS, winsNeeded: WINS_NEEDED,
      deadline: this.deadline, serverNow: t, goal: this.goal, soc: this.soc, target: this.target,
      surge: this.surging(t), surgeAt: this.phase === 'PLAY' ? this.roundStart + SURGE_AT_MS : null,
      cost: COST, maxCables: MAX_CABLES,
      roundWinner: this.roundWinner, winners: this.winners,
      bolts: this.bolts.map(b => ({ id: b.id, from: b.from, to: b.to, arriveAt: b.arriveAt })),
      players: this.players.map(p => ({
        id: p.id, name: p.name, color: p.color, connected: p.connected, wins: p.wins,
        power: Math.floor(p.power), cables: p.cables,
        shieldUntil: p.shieldUntil > t ? p.shieldUntil : 0, overUntil: p.overUntil > t ? p.overUntil : 0,
        drained: p.drained, blocked: p.blocked,
      })),
    };
  }
  playerView(id) { return { ...this.publicView(), me: id }; }
}
