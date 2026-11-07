export const MIN_PLAYERS = 2, MAX_PLAYERS = 4;
export const CASE_MS = 30_000, TALK_MS = 60_000, VOTE_MS = 20_000, SHOW_MS = 9_000;
export const STEP_SOC = 5;      // 배터리가 이만큼 오를 때마다 사건이 하나 터진다
export const CASES = 6, MAX_BLACKOUTS = 3;
export const PRANKS = ['NONE', 'LIGHT', 'CLIMATE']; // 도둑만 고를 수 있는 몰래 장난
const TARGET = { 2: 3, 3: 4, 4: 6 };
const POOL = [0, 1, 1, 2, 2, 3];
const CLUE_CHANCE = 0.5;
const NORMAL_CABIN = { light: 'NORMAL', climate: 'NORMAL' };

/**
 * 판 하나의 규칙. 네트워크·타이머를 모르는 순수 상태 기계다.
 *
 * LOBBY → BRIEFING → CHARGING → (배터리 +5%) CASE → RESULT → TALK → VOTE → VERDICT → CHARGING … → END
 * 2명이면 도둑 대신 차가 방해하고 토론·투표 없이 사건만 버틴다.
 * cabin은 차 실내가 지금 어떤 상태여야 하는지다. Pleos 앱은 이 값을 그대로 적용하면 되고,
 * 판이 끝나면 NORMAL로 돌아오므로 복구도 같은 경로로 처리된다.
 */
export class Game {
  constructor({ rng = Math.random, now = Date.now } = {}) {
    Object.assign(this, { rng, now });
    this.players = [];
    this.reset();
  }

  reset() {
    this.phase = 'LOBBY';
    this.soc = 30; this.socSource = 'DEMO'; this.nextAt = 0;
    this.caseNo = 0; this.cases = CASES; this.blackouts = 0; this.deadline = 0;
    this.result = null; this.verdict = null; this.winner = null; this.tampered = false;
    this.cabin = { ...NORMAL_CABIN };
    this.thiefId = null; this.plays = new Map(); this.votes = new Map(); this.ready = new Set();
    for (const p of this.players) { p.hand = []; p.clue = null; }
  }

  addPlayer(id, name) {
    if (this.phase !== 'LOBBY') throw new Error('GAME_STARTED');
    if (this.players.length >= MAX_PLAYERS) throw new Error('ROOM_FULL');
    this.players.push({ id, name, connected: false, hand: [], clue: null });
  }
  removePlayer(id) { if (this.phase === 'LOBBY') this.players = this.players.filter(p => p.id !== id); }
  setConnected(id, connected) { const p = this.player(id); if (p) p.connected = connected; }
  player(id) { return this.players.find(p => p.id === id); }
  get solo() { return this.players.length === 2; } // 2명: 차가 도둑 역할
  get target() { return TARGET[this.players.length]; }
  pick(list) { return list[Math.floor(this.rng() * list.length)]; }

  start() {
    if (this.phase !== 'LOBBY') throw new Error('GAME_STARTED');
    if (this.players.length < MIN_PLAYERS) throw new Error('NEED_PLAYERS');
    // 배터리가 찰 여유만큼만 사건을 낸다. 거의 다 찼으면 사건이 터질 수 없다.
    const room = Math.floor((100 - this.soc) / STEP_SOC);
    if (room < 1) throw new Error('BATTERY_FULL');
    this.cases = Math.min(CASES, room);
    this.thiefId = this.solo ? null : this.pick(this.players).id;
    this.phase = 'BRIEFING'; // 규칙을 다 읽고 첫 사건으로 간다
  }

  /** 규칙을 읽은 사람이 누른다. 모두 누르면 충전을 기다린다. */
  confirm(id) {
    if (this.phase !== 'BRIEFING' || !this.player(id)) throw new Error('NOT_BRIEFING');
    this.ready.add(id);
    if (this.ready.size === this.players.length) this.next();
  }

  /** 실제 차 또는 시연용 배터리 값. 사건은 배터리가 올라야만 터진다. */
  setSoc(value, source = 'DEMO') {
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('BAD_SOC');
    this.soc = Math.round(value); this.socSource = source;
    if (this.phase === 'CHARGING' && this.soc >= this.nextAt) this.startCase();
  }

  startCase() {
    this.caseNo += 1;
    this.phase = 'CASE';
    this.plays = new Map(); this.votes = new Map();
    this.result = null; this.verdict = null; this.tampered = false;
    this.cabin = { ...NORMAL_CABIN };
    for (const p of this.players) {
      p.clue = null;
      p.hand = [this.pick(POOL), this.pick(POOL), p.id === this.thiefId ? this.pick([-2, -3]) : this.pick(POOL)];
    }
    this.deadline = this.now() + CASE_MS;
  }

  /**
   * card: 손패 번호. watch: 이번에 살펴볼 다른 사람(없으면 null).
   * prank: 도둑만 LIGHT·CLIMATE를 고를 수 있다. 가족은 NONE.
   */
  play(id, { card, watch = null, prank = 'NONE' }) {
    const p = this.player(id);
    if (this.phase !== 'CASE' || !p) throw new Error('NOT_CASE');
    if (this.plays.has(id)) throw new Error('ALREADY_PLAYED');
    if (!Number.isInteger(card) || card < 0 || card >= p.hand.length) throw new Error('BAD_CARD');
    if (watch !== null && (watch === id || !this.player(watch))) throw new Error('BAD_WATCH');
    if (!PRANKS.includes(prank) || (prank !== 'NONE' && id !== this.thiefId)) throw new Error('BAD_PRANK');
    this.plays.set(id, { value: p.hand[card], watch, prank });
    if (this.plays.size === this.players.length) this.resolveCase();
  }

  resolveCase() {
    let sum = [...this.plays.values()].reduce((n, x) => n + x.value, 0);
    let carPenalty = 0;
    if (this.solo) { carPenalty = this.pick([1, 2, 3]); sum -= carPenalty; }
    const success = sum >= this.target;
    for (const p of this.players) {
      const { watch, prank } = this.plays.get(p.id);
      if (prank === 'LIGHT') { this.cabin.light = 'RED'; this.tampered = true; }
      if (prank === 'CLIMATE') { this.cabin.climate = 'COLD'; this.tampered = true; }
      // 살펴본 사람의 카드는 반반 확률로 보인다. 도둑도 똑같이 살펴볼 수 있다.
      const other = watch && this.player(watch);
      if (!other) p.clue = '이번엔 아무도 살펴보지 않았어요.';
      else if (this.rng() < CLUE_CHANCE) {
        const value = this.plays.get(other.id).value;
        p.clue = `${other.name}은(는) 이번에 ${value > 0 ? '+' : ''}${value}을(를) 냈어요.`;
      } else p.clue = `${other.name}의 카드는 못 봤어요.`;
    }
    if (!success) { this.blackouts += 1; this.cabin = { light: 'OFF', climate: 'COLD' }; }
    this.result = { sum, target: this.target, success, carPenalty };
    this.phase = 'RESULT';
    this.deadline = this.now() + SHOW_MS;
  }

  vote(id, suspect) {
    if (this.phase !== 'VOTE' || !this.player(id)) throw new Error('NOT_VOTING');
    if (this.votes.has(id)) throw new Error('ALREADY_VOTED');
    if (suspect !== 'SKIP' && (!this.player(suspect) || suspect === id)) throw new Error('BAD_VOTE');
    this.votes.set(id, suspect);
    if (this.votes.size === this.players.length) this.resolveVote();
  }

  resolveVote() {
    const count = new Map();
    for (const v of this.votes.values()) if (v !== 'SKIP') count.set(v, (count.get(v) ?? 0) + 1);
    const [accused, votes] = [...count].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    const arrested = votes * 2 > this.players.length ? accused : null; // 과반이어야 체포
    const caught = arrested === this.thiefId && arrested !== null;
    if (arrested && !caught) this.blackouts += 1; // 억울한 체포는 정전 한 번과 같다
    this.verdict = { arrested: arrested ? this.player(arrested).name : null, caught };
    this.phase = 'VERDICT';
    this.deadline = this.now() + SHOW_MS;
  }

  /** 진행자의 "다음"이자 시간 초과 처리. */
  next() {
    if (this.phase === 'BRIEFING') {
      this.phase = 'CHARGING';
      this.nextAt = this.soc + STEP_SOC;
    } else if (this.phase === 'CASE') {
      for (const p of this.players) if (!this.plays.has(p.id)) this.plays.set(p.id, { value: p.hand[0], watch: null, prank: 'NONE' });
      this.resolveCase();
    } else if (this.phase === 'RESULT') {
      if (this.solo) this.afterCase();
      else { this.phase = 'TALK'; this.deadline = this.now() + TALK_MS; }
    } else if (this.phase === 'TALK') {
      this.phase = 'VOTE'; this.deadline = this.now() + VOTE_MS;
    } else if (this.phase === 'VOTE') {
      for (const p of this.players) if (!this.votes.has(p.id)) this.votes.set(p.id, 'SKIP');
      this.resolveVote();
    } else if (this.phase === 'VERDICT') {
      this.afterCase();
    } else if (this.phase === 'END') {
      const soc = this.soc, source = this.socSource;
      this.reset();
      this.soc = soc; this.socSource = source;
    }
  }

  afterCase() {
    if (this.verdict?.caught) return this.finish('FAMILY');
    if (this.blackouts >= MAX_BLACKOUTS) return this.finish(this.solo ? 'CAR' : 'THIEF');
    if (this.caseNo >= this.cases) return this.finish(this.solo ? 'FAMILY' : 'THIEF');
    this.phase = 'CHARGING'; this.deadline = 0;
    this.nextAt = this.soc + STEP_SOC;
  }

  finish(winner) {
    this.winner = winner; this.phase = 'END'; this.deadline = 0;
    this.cabin = { ...NORMAL_CABIN };
  }

  /** 모두에게 보여도 되는 값만. 역할·손패·누가 낸 카드인지는 넣지 않는다. */
  publicView() {
    return {
      phase: this.phase, soc: this.soc, socSource: this.socSource, nextAt: this.nextAt,
      caseNo: this.caseNo, cases: this.cases, target: this.target ?? null, solo: this.solo,
      blackouts: this.blackouts, maxBlackouts: MAX_BLACKOUTS, deadline: this.deadline,
      result: this.result, verdict: this.verdict, tampered: this.tampered, cabin: this.cabin, winner: this.winner,
      thief: this.phase === 'END' ? this.player(this.thiefId)?.name ?? null : null,
      players: this.players.map(p => ({
        id: p.id, name: p.name, connected: p.connected,
        done: this.phase === 'BRIEFING' ? this.ready.has(p.id) : this.phase === 'CASE' ? this.plays.has(p.id) : this.phase === 'VOTE' ? this.votes.has(p.id) : false,
      })),
    };
  }

  playerView(id) {
    const p = this.player(id), view = this.publicView();
    view.me = id;
    view.role = this.phase === 'LOBBY' ? null : id === this.thiefId ? 'THIEF' : 'FAMILY';
    view.hand = this.phase === 'CASE' ? p?.hand ?? [] : [];
    view.clue = ['RESULT', 'TALK', 'VOTE', 'VERDICT'].includes(this.phase) ? p?.clue ?? null : null;
    return view;
  }
}
