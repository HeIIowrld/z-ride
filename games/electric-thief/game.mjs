export const MIN_PLAYERS = 2, MAX_PLAYERS = 4;
export const CASE_MS = 30_000, TALK_MS = 60_000, VOTE_MS = 20_000, SHOW_MS = 15_000; // 결과 화면: 운전자가 차단기를 쓸지 고를 시간
export const STEP_SOC = 5;      // 배터리가 이만큼 오를 때마다 사건이 하나 터진다
export const CASES = 6, MAX_BLACKOUTS = 3;
export const PRANKS = ['NONE', 'LIGHT', 'WIND']; // 도둑만 고를 수 있는 몰래 장난
export const HAND = 4;          // 판 내내 들고 있는 카드 수. 한 장 내면 다음 사건 전에 한 장 뽑는다
export const SPAN = 2;          // 구간 폭: 목표 lo ~ lo+SPAN
export const CAR_NOISE = [-2, -1, 0, 1, 2]; // 2명 판에서 차가 몰래 더하는 값
// 덱 구성. 큰 카드는 적게 넣어 아껴 쓰게 한다. 도둑도 같은 덱에서 받는다
const DECK = [[-1, 4], [0, 4], [1, 6], [2, 6], [3, 5], [4, 4]].flatMap(([v, n]) => Array(n).fill(v));
const CLUE_CHANCE = 0.5;
const NORMAL_CABIN = { light: 'NORMAL', air: 'NORMAL' };

/**
 * 판 하나의 규칙. 네트워크·타이머를 모르는 순수 상태 기계다.
 *
 * LOBBY → BRIEFING → CHARGING → (배터리 +5%) CASE → RESULT → TALK → VOTE → VERDICT → CHARGING … → END
 * 사건마다 합계를 구간(lo~hi)에 맞춘다. 모자라면 정전, 넘치면 과부하이고 둘 다 퓨즈가 하나 나간다.
 * 결과 화면에서 차 화면의 비상 차단기로 그 사건의 피해를 취소할 수 있다(한 판에 정해진 횟수).
 * 2명이면 도둑 대신 차가 숨은 값을 더하고, 토론·투표 없이 사건만 버틴다.
 * cabin은 차 실내가 지금 어떤 상태여야 하는지다(light: 무드등, air: 바람). Pleos 앱은 이 값을 그대로 적용하고,
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
    this.range = null; this.breakers = 0; this.deck = []; this.discard = [];
    this.thiefId = null; this.plays = new Map(); this.votes = new Map(); this.ready = new Set();
    for (const p of this.players) { p.hand = []; p.clue = null; }
  }

  /** 덱에서 한 장. 다 쓰면 버린 카드를 섞어 다시 쓴다. */
  draw() {
    if (!this.deck.length) { this.deck = this.shuffle(this.discard.length ? this.discard : [...DECK]); this.discard = []; }
    return this.deck.pop();
  }
  shuffle(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  /**
   * 지금 손패로 실제로 만들 수 있는 합계 중 하나를 골라 구간을 정한다. 늘 맞출 방법이 있다.
   * 너무 작은 합계(마이너스·0 근처)와 "다 같이 제일 큰 카드"인 최댓값은 피해서,
   * 누가 크게 내고 누가 작게 낼지 맞춰야 하게 만든다.
   */
  pickRange() {
    let sums = new Set([0]);
    for (const p of this.players) {
      const next = new Set();
      for (const s of sums) for (const v of p.hand) next.add(s + v);
      sums = next;
    }
    const all = [...sums].sort((a, b) => a - b);
    const max = all[all.length - 1], floor = this.players.length; // 평균 +1 이상
    let pool = all.filter(s => s >= floor && s < max);
    if (!pool.length) pool = all.filter(s => s >= floor);
    if (!pool.length) pool = [max];
    const target = this.pick(pool);
    // 목표 합계가 구간 어딘가에 들어가게. 구간은 1 아래로 내려가지 않는다
    const shift = target - Math.floor(this.rng() * (SPAN + 1));
    const lo = target >= 1 ? Math.max(1, shift) : shift;
    return { lo, hi: lo + SPAN };
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
  get maxBreakers() { return this.solo ? 1 : 2; }
  pick(list) { return list[Math.floor(this.rng() * list.length)]; }

  start() {
    if (this.phase !== 'LOBBY') throw new Error('GAME_STARTED');
    if (this.players.length < MIN_PLAYERS) throw new Error('NEED_PLAYERS');
    // 배터리가 찰 여유만큼만 사건을 낸다. 거의 다 찼으면 사건이 터질 수 없다.
    const room = Math.floor((100 - this.soc) / STEP_SOC);
    if (room < 1) throw new Error('BATTERY_FULL');
    this.cases = Math.min(CASES, room);
    this.thiefId = this.solo ? null : this.pick(this.players).id;
    this.breakers = this.maxBreakers;
    this.deck = this.shuffle(DECK); this.discard = [];
    for (const p of this.players) p.hand = Array.from({ length: HAND }, () => this.draw());
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
      while (p.hand.length < HAND) p.hand.push(this.draw()); // 지난 사건에 낸 만큼 채운다
    }
    this.range = this.pickRange();
    this.deadline = this.now() + CASE_MS;
  }

  /**
   * card: 손패 번호. watch: 이번에 살펴볼 다른 사람(없으면 null).
   * prank: 도둑만 LIGHT·WIND를 고를 수 있다. 가족은 NONE.
   */
  play(id, { card, watch = null, prank = 'NONE' }) {
    const p = this.player(id);
    if (this.phase !== 'CASE' || !p) throw new Error('NOT_CASE');
    if (this.plays.has(id)) throw new Error('ALREADY_PLAYED');
    if (!Number.isInteger(card) || card < 0 || card >= p.hand.length) throw new Error('BAD_CARD');
    if (watch !== null && (watch === id || !this.player(watch))) throw new Error('BAD_WATCH');
    if (!PRANKS.includes(prank) || (prank !== 'NONE' && id !== this.thiefId)) throw new Error('BAD_PRANK');
    const [value] = p.hand.splice(card, 1);
    this.discard.push(value);
    this.plays.set(id, { value, watch, prank });
    if (this.plays.size === this.players.length) this.resolveCase();
  }

  resolveCase() {
    let sum = [...this.plays.values()].reduce((n, x) => n + x.value, 0);
    const carNoise = this.solo ? this.pick(CAR_NOISE) : 0;
    sum += carNoise;
    const { lo, hi } = this.range;
    const outcome = sum < lo ? 'LOW' : sum > hi ? 'HIGH' : 'OK';
    for (const p of this.players) {
      const { watch, prank } = this.plays.get(p.id);
      if (prank === 'LIGHT') { this.cabin.light = 'RED'; this.tampered = true; }
      if (prank === 'WIND') { this.cabin.air = 'GUST'; this.tampered = true; }
      // 살펴본 사람의 카드는 반반 확률로 보인다. 도둑도 똑같이 살펴볼 수 있다.
      const other = watch && this.player(watch);
      if (!other) p.clue = '이번엔 아무도 살펴보지 않았어요.';
      else if (this.rng() < CLUE_CHANCE) {
        const value = this.plays.get(other.id).value;
        p.clue = `${other.name}은(는) 이번에 ${value > 0 ? '+' : ''}${value}을(를) 냈어요.`;
      } else p.clue = `${other.name}의 카드는 못 봤어요.`;
    }
    // 정전: 불이 꺼지고 바람이 멎는다. 과부하: 빨간 불에 바람이 훅 분다
    if (outcome === 'LOW') { this.blackouts += 1; this.cabin = { light: 'OFF', air: 'LOW' }; }
    if (outcome === 'HIGH') { this.blackouts += 1; this.cabin = { light: 'RED', air: 'GUST' }; }
    this.result = { sum, lo, hi, outcome, success: outcome === 'OK', carNoise, saved: false };
    this.phase = 'RESULT';
    this.deadline = this.now() + SHOW_MS;
  }

  /** 차 화면의 비상 차단기. 방금 사건의 정전·과부하를 취소하고 실내를 되돌린다. */
  breaker() {
    if (this.phase !== 'RESULT' || this.result.success || this.result.saved) throw new Error('NO_FAULT');
    if (this.breakers < 1) throw new Error('NO_BREAKER');
    this.breakers -= 1; this.blackouts -= 1;
    this.result = { ...this.result, saved: true };
    this.cabin = { ...NORMAL_CABIN };
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
      // 시간 안에 못 낸 사람은 첫 카드를 낸다
      for (const p of this.players) if (!this.plays.has(p.id)) { const [value] = p.hand.splice(0, 1); this.discard.push(value); this.plays.set(p.id, { value, watch: null, prank: 'NONE' }); }
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
      caseNo: this.caseNo, cases: this.cases, range: this.range, solo: this.solo,
      blackouts: this.blackouts, maxBlackouts: MAX_BLACKOUTS, deadline: this.deadline,
      breakers: this.breakers, maxBreakers: this.maxBreakers,
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
    // 손패는 판 내내 들고 있으니 충전·토론 중에도 보여 준다(어떤 카드를 아낄지 생각하게)
    view.hand = ['LOBBY', 'END'].includes(this.phase) ? [] : p?.hand ?? [];
    view.clue = ['RESULT', 'TALK', 'VOTE', 'VERDICT'].includes(this.phase) ? p?.clue ?? null : null;
    return view;
  }
}
