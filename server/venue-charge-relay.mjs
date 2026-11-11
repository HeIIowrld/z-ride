import { WORDS } from './venue-charge-words.mjs';

export const MIN_PLAYERS = 2, MAX_PLAYERS = 4;
export const DRAW_MS = 75_000, GUESS_MS = 35_000;
export const ROUND_CHOICES = [2, 3, 5];
const MAX_STROKES = 300, MAX_COORDS = 12_000, MAX_GUESS = 30;
const NO_GUESS = '(모르겠음)';

const normalize = text => String(text).replace(/\s+/g, '').toLowerCase();

function shuffled(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

/** 그림은 1000×1000 좌표의 획 목록으로만 받는다. 이미지·임의 필드는 버린다. */
export function cleanDrawing(value) {
  const strokes = value?.strokes;
  if (!Array.isArray(strokes) || strokes.length > MAX_STROKES) return null;
  let coords = 0;
  const out = [];
  for (const s of strokes) {
    if (!Number.isInteger(s?.c) || s.c < 0 || s.c > 5 || !Number.isInteger(s?.w) || s.w < 0 || s.w > 2) return null;
    if (!Array.isArray(s.p) || s.p.length < 2 || s.p.length % 2) return null;
    coords += s.p.length;
    if (coords > MAX_COORDS) return null;
    if (!s.p.every(n => Number.isInteger(n) && n >= 0 && n <= 1000)) return null;
    out.push({ c: s.c, w: s.w, p: s.p });
  }
  return { strokes: out };
}

/**
 * 판 하나의 규칙. 네트워크·타이머를 모르는 순수 상태 기계다.
 *
 * 사람 수만큼 스케치북이 있고 단어는 게임이 뽑는다. 스케치북 b의 s번째 칸은 (b+1+s)번 사람이
 * 채우므로 각 단계마다 모두가 서로 다른 스케치북을 맡고, 2~4명 모두 단어를 본 사람이 다시
 * 맞히는 일이 없다. 칸은 그리기·맞히기를 번갈아 하며 3명이면 그림으로 끝난다.
 */
export class Game {
  constructor({ rng = Math.random, now = Date.now, words = WORDS } = {}) {
    Object.assign(this, { rng, now, words });
    this.players = [];
    this.reset();
  }

  reset() {
    this.phase = 'LOBBY';
    this.rounds = 3; this.round = 0; this.step = 0;
    this.books = []; this.deadline = 0; this.cursor = null;
    this.family = { success: 0, total: 0 };
    this.pool = [];
    for (const p of this.players) p.hearts = 0;
  }

  addPlayer(id, name) {
    if (this.phase !== 'LOBBY') throw new Error('GAME_STARTED');
    if (this.players.length >= MAX_PLAYERS) throw new Error('ROOM_FULL');
    this.players.push({ id, name, connected: false, hearts: 0 });
  }

  removePlayer(id) {
    if (this.phase === 'LOBBY') this.players = this.players.filter(p => p.id !== id);
  }

  setConnected(id, connected) {
    const p = this.players.find(x => x.id === id);
    if (p) p.connected = connected;
  }

  get steps() { return this.players.length; }
  stepKind(step = this.step) { return step % 2 === 0 ? 'DRAW' : 'GUESS'; }

  start(rounds = 3) {
    if (this.phase !== 'LOBBY') throw new Error('GAME_STARTED');
    if (this.players.length < MIN_PLAYERS) throw new Error('NEED_PLAYERS');
    if (!ROUND_CHOICES.includes(rounds)) throw new Error('BAD_ROUNDS');
    this.rounds = rounds;
    this.pool = shuffled(this.words, this.rng);
    this.startRound();
  }

  startRound() {
    this.round += 1;
    this.books = this.players.map(() => ({ word: this.pool.pop(), entries: [] }));
    this.phase = 'PLAY';
    this.beginStep(0);
  }

  beginStep(step) {
    this.step = step;
    this.deadline = this.now() + (this.stepKind() === 'DRAW' ? DRAW_MS : GUESS_MS);
  }

  /** 이번 단계에서 이 사람이 맡은 스케치북 번호. */
  bookOf(index) {
    const n = this.players.length;
    return (((index - 1 - this.step) % n) + n) % n;
  }

  hasSubmitted(index) { return this.books[this.bookOf(index)].entries.length > this.step; }

  taskFor(id) {
    const index = this.players.findIndex(p => p.id === id);
    if (this.phase !== 'PLAY' || index < 0) return null;
    const book = this.books[this.bookOf(index)];
    const before = book.entries[this.step - 1];
    const kind = this.stepKind();
    if (kind === 'GUESS') return { kind, step: this.step, drawing: before.drawing };
    return { kind, step: this.step, prompt: this.step === 0 ? book.word : before.text };
  }

  submit(id, value) {
    const index = this.players.findIndex(p => p.id === id);
    if (this.phase !== 'PLAY' || index < 0) throw new Error('NOT_PLAYING');
    if (value?.step !== this.step) throw new Error('STALE_STEP');
    if (this.hasSubmitted(index)) throw new Error('ALREADY_SUBMITTED');
    this.write(index, this.parse(value));
    this.advanceIfDone();
  }

  parse(value) {
    if (this.stepKind() === 'DRAW') {
      const drawing = cleanDrawing(value.drawing);
      if (!drawing) throw new Error('BAD_DRAWING');
      return { drawing };
    }
    const text = String(value.text ?? '').trim().slice(0, MAX_GUESS);
    return { text: text || NO_GUESS };
  }

  write(index, content) {
    this.books[this.bookOf(index)].entries.push({ kind: this.stepKind(), authorId: this.players[index].id, hearts: new Set(), ...content });
  }

  /** 시간이 다 되면(또는 진행자가 넘기면) 못 낸 사람 칸은 빈 칸으로 채운다. */
  expire() {
    if (this.phase !== 'PLAY') return;
    this.players.forEach((_, index) => {
      if (!this.hasSubmitted(index)) this.write(index, this.stepKind() === 'DRAW' ? { drawing: { strokes: [] } } : { text: NO_GUESS });
    });
    this.advanceIfDone();
  }

  advanceIfDone() {
    if (!this.players.every((_, index) => this.hasSubmitted(index))) return;
    if (this.step + 1 < this.steps) { this.beginStep(this.step + 1); return; }
    this.phase = 'REVEAL'; this.deadline = 0;
    this.cursor = { book: 0, shown: 0 };
  }

  matched(book) {
    const guess = book.entries.filter(e => e.kind === 'GUESS').at(-1);
    return !!guess && normalize(guess.text) === normalize(book.word);
  }

  /** 진행자의 "다음". 공개 → 라운드 결과 → 다음 라운드 → 끝. */
  next() {
    if (this.phase === 'REVEAL') {
      const c = this.cursor;
      if (c.shown < this.steps) { c.shown += 1; return; }
      if (c.book + 1 < this.books.length) { this.cursor = { book: c.book + 1, shown: 0 }; return; }
      this.family.total += this.books.length;
      this.family.success += this.books.filter(b => this.matched(b)).length;
      this.phase = 'ROUND_END'; this.cursor = null;
      return;
    }
    if (this.phase === 'ROUND_END') {
      if (this.round < this.rounds) this.startRound();
      else this.phase = 'END';
      return;
    }
    if (this.phase === 'END') this.reset();
  }

  heart(id, shownIndex) {
    if (this.phase !== 'REVEAL') throw new Error('NOT_REVEALING');
    const entry = this.books[this.cursor.book].entries[shownIndex];
    if (!entry || shownIndex >= this.cursor.shown) throw new Error('NOT_SHOWN');
    if (entry.authorId === id) throw new Error('OWN_ENTRY');
    if (entry.hearts.has(id)) return;
    entry.hearts.add(id);
    const author = this.players.find(p => p.id === entry.authorId);
    if (author) author.hearts += 1;
  }

  /** 모두에게 보여도 되는 값만. 진행 중인 단어·그림은 넣지 않는다. */
  publicView() {
    const view = {
      phase: this.phase, round: this.round, rounds: this.rounds, step: this.step, steps: this.steps,
      stepKind: this.phase === 'PLAY' ? this.stepKind() : null, deadline: this.deadline, family: this.family,
      players: this.players.map((p, index) => ({
        id: p.id, name: p.name, connected: p.connected, hearts: p.hearts,
        done: this.phase === 'PLAY' && this.hasSubmitted(index),
      })),
    };
    if (this.phase === 'REVEAL') {
      const { book: at, shown } = this.cursor, book = this.books[at];
      view.reveal = {
        book: at, books: this.books.length, word: book.word, shown, complete: shown === this.steps,
        matched: shown === this.steps && this.matched(book),
        entries: book.entries.slice(0, shown).map(e => ({
          kind: e.kind, authorId: e.authorId, author: this.players.find(p => p.id === e.authorId)?.name ?? '',
          hearts: e.hearts.size, drawing: e.drawing, text: e.text,
        })),
      };
    }
    return view;
  }

  playerView(id) {
    const index = this.players.findIndex(p => p.id === id);
    const view = this.publicView();
    view.me = id;
    view.task = this.taskFor(id);
    view.submitted = this.phase === 'PLAY' && index >= 0 && this.hasSubmitted(index);
    if (view.reveal) view.reveal.entries = view.reveal.entries.map((e, i) => ({ ...e, hearted: this.books[this.cursor.book].entries[i].hearts.has(id) }));
    return view;
  }
}
