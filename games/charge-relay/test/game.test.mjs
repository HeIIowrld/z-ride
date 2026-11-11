import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, cleanDrawing, DRAW_MS, GUESS_MS } from '../game.mjs';

const line = { strokes: [{ c: 0, w: 1, p: [0, 0, 1000, 1000] }] };

function game(n, opts = {}) {
  let t = 1000;
  const g = new Game({ rng: () => 0.5, now: () => t, ...opts });
  for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i);
  g.tick = ms => { t += ms; };
  return g;
}
function playStep(g, guess = () => '틀린 답') {
  const step = g.step;
  for (const p of [...g.players]) {
    const task = g.taskFor(p.id);
    g.submit(p.id, task.kind === 'DRAW' ? { step, drawing: line } : { step, text: guess(p, task) });
  }
}

for (const n of [2, 3, 4]) {
  test(`${n}명: 단계마다 모두 다른 스케치북을 맡고 단어를 본 사람은 다시 맞히지 않는다`, () => {
    const g = game(n);
    g.start(2);
    const wordSeenBy = new Map();
    for (let step = 0; step < n; step++) {
      const books = g.players.map((_, i) => g.bookOf(i));
      assert.equal(new Set(books).size, n);
      g.players.forEach((p, i) => {
        if (step === 0) wordSeenBy.set(books[i], p.id);
        else if (g.stepKind() === 'GUESS') assert.notEqual(wordSeenBy.get(books[i]), p.id);
      });
      playStep(g);
    }
    assert.equal(g.phase, 'REVEAL');
    for (const b of g.books) {
      assert.equal(b.entries.length, n);
      assert.equal(new Set(b.entries.map(e => e.authorId)).size, n, '한 스케치북에 같은 사람이 두 번 쓰지 않는다');
    }
  });
}

test('그리는 단계의 과제는 앞 칸만 보여 주고 공개 화면에는 단어가 없다', () => {
  const g = game(4);
  g.start();
  const words = g.books.map(b => b.word);
  assert.ok(words.includes(g.taskFor('p0').prompt));
  const leaked = JSON.stringify(g.publicView());
  for (const w of words) assert.ok(!leaked.includes(w));
  playStep(g);
  const task = g.taskFor('p0');
  assert.equal(task.kind, 'GUESS');
  assert.equal(task.prompt, undefined);
  assert.deepEqual(task.drawing, line);
  const other = JSON.stringify(g.playerView('p1'));
  for (const w of words) assert.ok(!other.includes(w), '맞히는 사람에게 단어가 가지 않는다');
});

test('마지막 맞힘이 단어와 같으면 공백·대소문자와 상관없이 전달 성공', () => {
  const g = game(2);
  g.start(2);
  const answers = new Map(g.players.map((p, i) => [p.id, null]));
  playStep(g);
  g.players.forEach((p, i) => answers.set(p.id, g.books[g.bookOf(i)].word));
  playStep(g, p => ' ' + answers.get(p.id).split('').join(' ') + ' ');
  for (let i = 0; i < 2 * 3; i++) g.next();
  assert.equal(g.phase, 'ROUND_END');
  assert.deepEqual(g.family, { success: 2, total: 2 });
});

test('시간이 지나면 못 낸 칸을 비워 넘어가고, 늦은 제출과 중복 제출은 거부한다', () => {
  const g = game(3);
  g.start();
  assert.equal(g.deadline, 1000 + DRAW_MS);
  g.submit('p0', { step: 0, drawing: line });
  assert.throws(() => g.submit('p0', { step: 0, drawing: line }), /ALREADY_SUBMITTED/);
  g.expire();
  assert.equal(g.step, 1);
  assert.equal(g.deadline, 1000 + GUESS_MS);
  assert.throws(() => g.submit('p1', { step: 0, drawing: line }), /STALE_STEP/);
  g.expire();
  assert.equal(g.step, 2);
  assert.equal(g.books[0].entries[1].text, '(모르겠음)');
});

test('라운드가 다 끝나면 END, 다시 하면 같은 사람으로 대기실', () => {
  const g = game(2);
  g.start(2);
  for (let round = 0; round < 2; round++) {
    playStep(g); playStep(g);
    while (g.phase === 'REVEAL') g.next();
    assert.equal(g.phase, 'ROUND_END');
    g.next();
  }
  assert.equal(g.phase, 'END');
  g.next();
  assert.equal(g.phase, 'LOBBY');
  assert.equal(g.players.length, 2);
  assert.deepEqual(g.family, { success: 0, total: 0 });
});

test('한 판 안에서 단어가 겹치지 않는다', () => {
  const g = game(4, { rng: Math.random });
  g.start(5);
  const seen = new Set();
  for (let round = 0; round < 5; round++) {
    for (const b of g.books) { assert.ok(!seen.has(b.word)); seen.add(b.word); }
    for (let s = 0; s < 4; s++) playStep(g);
    while (g.phase === 'REVEAL') g.next();
    g.next();
  }
  assert.equal(seen.size, 20);
});

test('하트는 공개된 칸에만, 내 칸은 안 되고, 한 번만 센다', () => {
  const g = game(2);
  g.start();
  playStep(g); playStep(g);
  assert.throws(() => g.heart('p0', 0), /NOT_SHOWN/);
  g.next();
  const author = g.books[0].entries[0].authorId, fan = author === 'p0' ? 'p1' : 'p0';
  assert.throws(() => g.heart(author, 0), /OWN_ENTRY/);
  g.heart(fan, 0); g.heart(fan, 0);
  assert.equal(g.players.find(p => p.id === author).hearts, 1);
  assert.equal(g.playerView(fan).reveal.entries[0].hearted, true);
});

test('인원·시작 조건', () => {
  const one = game(1);
  assert.throws(() => one.start(), /NEED_PLAYERS/);
  const full = game(4);
  assert.throws(() => full.addPlayer('x', 'X'), /ROOM_FULL/);
  full.start();
  assert.throws(() => full.addPlayer('y', 'Y'), /GAME_STARTED/);
  assert.throws(() => game(2).start(9), /BAD_ROUNDS/);
});

test('그림 검증은 범위 밖 값과 낯선 필드를 버린다', () => {
  assert.deepEqual(cleanDrawing({ strokes: [{ c: 1, w: 2, p: [1, 2], evil: '<x>' }], extra: 1 }), { strokes: [{ c: 1, w: 2, p: [1, 2] }] });
  assert.equal(cleanDrawing({ strokes: [{ c: 9, w: 0, p: [1, 2] }] }), null);
  assert.equal(cleanDrawing({ strokes: [{ c: 0, w: 0, p: [1, 2000] }] }), null);
  assert.equal(cleanDrawing({ strokes: [{ c: 0, w: 0, p: [1] }] }), null);
  assert.equal(cleanDrawing({ strokes: Array(301).fill({ c: 0, w: 0, p: [1, 2] }) }), null);
  assert.equal(cleanDrawing('x'), null);
});
