import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, PULL_MS, READY_MS, GAP_MS, MAX_TAPS_PER_SEC } from '../game.mjs';

function setup(names = ['엄마', '아빠']) {
  let t = 0;
  const g = new Game({ now: () => t, rng: () => 0.3 });
  names.forEach((n, i) => g.addPlayer('p' + i, n));
  return { g, advance: ms => { t += ms; }, at: () => t };
}
const toPull = ({ g, advance }) => { g.start(); advance(READY_MS); g.expire(); assert.equal(g.phase, 'PULL'); };

test('사람은 번갈아 두 팀에 들어가고, 팀이 비면 시작하지 않는다', () => {
  const { g } = setup(['a', 'b', 'c']);
  assert.deepEqual(g.players.map(p => p.team), ['MINT', 'PINK', 'MINT']);
  g.switchTeam('p1');
  assert.throws(() => g.start(), /EMPTY_TEAM/);
});

test('2명 미만이면 시작하지 않는다', () => {
  const { g } = setup(['a']);
  assert.throws(() => g.start(), /TOO_FEW/);
});

test('준비 3초 동안 연타는 세지 않는다', () => {
  const s = setup(); s.g.start();
  assert.equal(s.g.tap('p0', 5), 0);
  assert.equal(s.g.pos, 0);
});

test('연타가 많은 팀 쪽으로 줄이 움직이고 끝에 닿으면 판을 이긴다', () => {
  const s = setup(); toPull(s);
  s.g.tap('p0', 5);
  assert.ok(s.g.pos < 0);
  for (let i = 0; i < 10 && s.g.phase === 'PULL'; i++) { s.advance(1000); s.g.tap('p0', 16); }
  assert.equal(s.g.phase, 'ROUND_END');
  assert.equal(s.g.roundWinner, 'MINT');
  assert.equal(s.g.wins.MINT, 1);
});

test('초당 상한을 넘는 연타는 버린다', () => {
  const s = setup(); toPull(s);
  assert.equal(s.g.tap('p0', 20), MAX_TAPS_PER_SEC);
  assert.equal(s.g.tap('p0', 5), 0);
  s.advance(1001);
  assert.equal(s.g.tap('p0', 3), 3);
});

test('인원이 적은 팀은 한 번 연타가 더 크게 민다(1:2도 공평)', () => {
  const s = setup(['a', 'b', 'c']); toPull(s); // 민트 2명, 핑크 1명
  s.g.tap('p0', 4); s.g.tap('p2', 4); // 민트 둘이 4번씩
  s.g.tap('p1', 4);                  // 핑크 혼자도 4번: 1인당 같은 속도면 팽팽하다
  assert.equal(s.g.pos, 0);
});

test('시간이 끝나면 줄이 넘어간 쪽이 이기고, 가운데면 무승부', () => {
  const s = setup(); toPull(s);
  s.g.tap('p1', 3); s.advance(PULL_MS); s.g.expire();
  assert.equal(s.g.roundWinner, 'PINK');
  s.advance(GAP_MS); s.g.expire(); assert.equal(s.g.phase, 'READY'); assert.equal(s.g.round, 2);
  s.advance(READY_MS); s.g.expire(); s.advance(PULL_MS); s.g.expire();
  assert.equal(s.g.roundWinner, null);
  assert.deepEqual(s.g.wins, { MINT: 0, PINK: 1 });
});

test('먼저 2판을 이긴 팀이 최종 승리하고, 다시 시작하면 점수가 지워진다', () => {
  const s = setup(); toPull(s);
  s.g.tap('p1', 1); s.advance(PULL_MS); s.g.expire();
  s.g.next(); s.advance(READY_MS); s.g.expire();
  s.g.tap('p1', 1); s.advance(PULL_MS); s.g.expire();
  assert.equal(s.g.phase, 'END'); assert.equal(s.g.winner, 'PINK');
  s.g.start();
  assert.deepEqual(s.g.wins, { MINT: 0, PINK: 0 }); assert.equal(s.g.round, 1);
});

test('시작한 뒤에는 들어오거나 팀을 바꿀 수 없다', () => {
  const s = setup(); s.g.start();
  assert.throws(() => s.g.addPlayer('x', 'x'), /GAME_STARTED/);
  assert.throws(() => s.g.switchTeam('p0'), /GAME_STARTED/);
});

test('무승부만 이어지면 5판에서 무승부로 끝난다', () => {
  const s = setup(); s.g.start();
  for (let r = 0; r < 5; r++) { s.advance(READY_MS); s.g.expire(); s.advance(PULL_MS); s.g.expire(); if (r < 4) { s.advance(GAP_MS); s.g.expire(); } }
  assert.equal(s.g.phase, 'END'); assert.equal(s.g.winner, null); assert.equal(s.g.round, 5);
});
