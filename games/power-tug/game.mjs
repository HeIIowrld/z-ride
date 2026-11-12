// 전력 줄다리기 규칙. 네트워크·타이머를 모르는 순수 상태 기계다.
//
// 두 팀이 폰을 연타하면 가운데 전기가 연타가 많은 쪽 배터리로 흘러간다.
// 줄 위치(pos)는 -100(민트 배터리 꽉 참) ~ +100(핑크 배터리 꽉 참). 끝에 닿거나 시간이 끝났을 때
// 줄이 넘어가 있는 팀이 그 판을 이긴다. 3판 2선승.

export const MIN_PLAYERS = 2, MAX_PLAYERS = 4;
export const TEAMS = ['MINT', 'PINK'];
export const READY_MS = 3_000, PULL_MS = 20_000, GAP_MS = 5_000, WINS_NEEDED = 2, MAX_ROUNDS = 5;
export const STEP = 4;            // 한 사람 한 번 연타가 줄을 미는 양(팀 인원으로 나눈다)
export const MAX_TAPS_PER_SEC = 16; // 사람 손으로 낼 수 있는 정도. 넘는 건 버린다

export class Game {
  constructor({ now = Date.now, rng = Math.random } = {}) {
    Object.assign(this, { now, rng });
    this.players = [];
    this.reset();
  }

  reset() {
    this.phase = 'LOBBY';
    this.round = 0; this.pos = 0; this.deadline = 0;
    this.wins = { MINT: 0, PINK: 0 };
    this.roundWinner = null; this.winner = null;
    for (const p of this.players) { p.taps = 0; p.total = 0; p.bucket = []; }
  }

  addPlayer(id, name) {
    if (this.phase !== 'LOBBY') throw new Error('GAME_STARTED');
    if (this.players.length >= MAX_PLAYERS) throw new Error('ROOM_FULL');
    // 인원이 적은 팀에 넣는다(같으면 민트)
    const team = this.size('MINT') <= this.size('PINK') ? 'MINT' : 'PINK';
    this.players.push({ id, name, team, connected: false, taps: 0, total: 0, bucket: [] });
  }
  removePlayer(id) {
    const p = this.players.find(x => x.id === id);
    if (!p) return;
    if (this.phase !== 'LOBBY' && this.players.length <= MIN_PLAYERS) throw new Error('TOO_FEW');
    this.players = this.players.filter(x => x.id !== id);
  }
  setConnected(id, connected) { const p = this.players.find(x => x.id === id); if (p) p.connected = connected; }
  size(team) { return this.players.filter(p => p.team === team).length; }

  /** 로비에서 내 팀을 바꾼다. 한 팀이 비면 시작할 수 없다. */
  switchTeam(id) {
    if (this.phase !== 'LOBBY') throw new Error('GAME_STARTED');
    const p = this.players.find(x => x.id === id);
    if (!p) throw new Error('NO_PLAYER');
    p.team = p.team === 'MINT' ? 'PINK' : 'MINT';
  }
  shuffleTeams() {
    if (this.phase !== 'LOBBY') throw new Error('GAME_STARTED');
    const order = [...this.players].sort(() => this.rng() - 0.5);
    order.forEach((p, i) => { p.team = TEAMS[i % 2]; });
  }

  start() {
    if (this.phase !== 'LOBBY' && this.phase !== 'END') throw new Error('BAD_PHASE');
    if (this.players.length < MIN_PLAYERS) throw new Error('TOO_FEW');
    if (!this.size('MINT') || !this.size('PINK')) throw new Error('EMPTY_TEAM');
    const keep = this.players;
    this.reset(); this.players = keep;
    this.nextRound();
  }

  nextRound() {
    if (this.phase === 'END') throw new Error('BAD_PHASE');
    this.round += 1; this.pos = 0; this.roundWinner = null;
    for (const p of this.players) { p.taps = 0; p.bucket = []; }
    this.phase = 'READY'; this.deadline = this.now() + READY_MS;
  }

  /** 시간이 다 된 단계를 넘긴다. 서버 타이머가 부른다. */
  expire() {
    if (this.phase === 'READY' && this.now() >= this.deadline) { this.phase = 'PULL'; this.deadline = this.now() + PULL_MS; return true; }
    if (this.phase === 'PULL' && this.now() >= this.deadline) { this.finishRound(this.pos === 0 ? null : this.pos < 0 ? 'MINT' : 'PINK'); return true; }
    if (this.phase === 'ROUND_END' && this.now() >= this.deadline) { this.nextRound(); return true; }
    return false;
  }

  /** 폰이 모아 보낸 연타 수. 초당 상한을 넘는 몫은 버린다. */
  tap(id, count) {
    if (this.phase !== 'PULL') return 0;
    const p = this.players.find(x => x.id === id);
    if (!p) throw new Error('NO_PLAYER');
    const n = Math.max(0, Math.min(20, Math.floor(Number(count) || 0)));
    const t = this.now();
    p.bucket = p.bucket.filter(x => t - x < 1000);
    const ok = Math.min(n, MAX_TAPS_PER_SEC - p.bucket.length);
    if (ok <= 0) return 0;
    for (let i = 0; i < ok; i++) p.bucket.push(t);
    p.taps += ok; p.total += ok;
    const push = STEP * ok / this.size(p.team);
    this.pos = Math.max(-100, Math.min(100, this.pos + (p.team === 'MINT' ? -push : push)));
    if (Math.abs(this.pos) >= 100) this.finishRound(p.team);
    return ok;
  }

  finishRound(team) {
    this.roundWinner = team; // null이면 무승부
    if (team) this.wins[team] += 1;
    const done = TEAMS.find(t => this.wins[t] >= WINS_NEEDED);
    // 무승부가 이어지면 5판에서 끝낸다(앞선 팀 승리, 같으면 무승부)
    const last = this.round >= MAX_ROUNDS;
    if (done || last) { this.winner = done ?? (this.wins.MINT === this.wins.PINK ? null : this.wins.MINT > this.wins.PINK ? 'MINT' : 'PINK'); this.phase = 'END'; this.deadline = 0; }
    else { this.phase = 'ROUND_END'; this.deadline = this.now() + GAP_MS; }
  }

  next() {
    if (this.phase !== 'ROUND_END') throw new Error('BAD_PHASE');
    this.nextRound();
  }

  backToLobby() { const keep = this.players; this.reset(); this.players = keep; }

  /** 큰 화면용. */
  publicView() {
    return {
      phase: this.phase, round: this.round, pos: Math.round(this.pos * 10) / 10, deadline: this.deadline,
      wins: { ...this.wins }, roundWinner: this.roundWinner, winner: this.winner,
      players: this.players.map(({ id, name, team, connected, taps, total }) => ({ id, name, team, connected, taps, total })),
    };
  }
  /** 폰용. 숨길 정보가 없어서 큰 화면과 같고, 내가 누군지만 더한다. */
  playerView(id) { return { ...this.publicView(), me: id }; }
}
