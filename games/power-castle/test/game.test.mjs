import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, goalFor, COST, RULES_MS, READY_MS, TICK_MS, BOLT_MS, DRAIN, SHIELD_MS, SURGE_AT_MS, START_POWER } from '../game.mjs';

function setup(n = 2) {
  let t = 1000;
  const g = new Game({ now: () => t });
  for (let i = 0; i < n; i++) g.addPlayer('p' + i, '이름' + i);
  const tick = ms => { t += ms; g.wake(); };
  return { g, tick, now: () => t, set: v => { t = v; } };
}
function toPlay(s) { s.g.start(); assert.equal(s.g.phase, 'RULES'); s.g.skipRules(); s.tick(READY_MS); assert.equal(s.g.phase, 'PLAY'); }

test('충전할 양이 40% 이상이면 목표 ⚡150, 아니면 100', () => {
  assert.equal(goalFor(30, 80), 150);
  assert.equal(goalFor(50, 80), 100);
  assert.equal(goalFor(null, null), 100);
});

test('시작하면 규칙 화면이 먼저 뜨고, 시간이 지나거나 건너뛰면 판이 시작된다', () => {
  const s = setup();
  assert.throws(() => new Game().start(), /NEED_PLAYERS/);
  s.g.start(); assert.equal(s.g.phase, 'RULES');
  s.tick(RULES_MS); assert.equal(s.g.phase, 'READY');
  s.tick(READY_MS); assert.equal(s.g.phase, 'PLAY');
  assert.equal(s.g.players[0].power, START_POWER);
});

test('케이블이 많을수록 전기가 빨리 모인다', () => {
  const s = setup(); toPlay(s);
  s.g.act('p0', 'cable');
  assert.equal(s.g.players[0].power, START_POWER - COST.cable);
  for (let i = 0; i < 10; i++) s.tick(TICK_MS);
  const [a, b] = s.g.players;
  assert.equal(Math.round(a.power), START_POWER - COST.cable + 12); // 2가닥 × 0.6 × 10초
  assert.equal(Math.round(b.power), START_POWER + 6);
  s.g.act('p0', 'cable'); assert.throws(() => s.g.act('p0', 'cable'), /MAX_CABLES|NO_POWER/);
});

test('끌어오기는 3초 뒤 도착해 ⚡15를 옮기고, 방패가 있으면 막힌다', () => {
  const s = setup(); toPlay(s);
  s.g.act('p0', 'drain', 'p1');
  assert.throws(() => s.g.act('p0', 'drain', 'p1'), /BOLT_FLYING/);
  assert.throws(() => s.g.act('p1', 'drain', 'p1'), /BAD_TARGET/);
  const before = s.g.players.map(p => p.power);
  s.tick(BOLT_MS);
  const [a, b] = s.g.players;
  assert.ok(Math.abs(a.power - before[0] - DRAIN - 1.8) < .01);
  assert.ok(Math.abs(b.power - before[1] + DRAIN - 1.8) < .01);
  s.g.act('p0', 'drain', 'p1');
  s.tick(1000); s.g.act('p1', 'shield');
  const kept = s.g.players[1].power;
  s.tick(2000);
  assert.equal(s.g.players[1].blocked, 1);
  assert.ok(s.g.players[1].power > kept, '막혀서 빼앗기지 않음');
});

test('과충전 중에는 방패를 못 쓰고, 10초 동안 받는 양이 2배', () => {
  const s = setup(); toPlay(s);
  s.g.act('p0', 'over');
  assert.throws(() => s.g.act('p0', 'shield'), /OVERCHARGED/);
  const e = s.g.players[0].power, f = s.g.players[1].power;
  s.tick(5000);
  assert.ok(Math.abs((s.g.players[0].power - e) - 2 * (s.g.players[1].power - f)) < .01);
});

test('1분 30초부터 10초 동안 발전소 폭주로 3배', () => {
  const s = setup(); toPlay(s);
  s.tick(SURGE_AT_MS - 1000);
  const before = s.g.players[1].power;
  s.tick(1000); s.tick(1000);
  assert.ok(s.g.surging());
  assert.ok(Math.abs(s.g.players[1].power - before - (0.6 + 1.8)) < .01);
});

test('목표를 채우면 판을 이기고, 2판 먼저 이기면 끝난다', () => {
  const s = setup(); toPlay(s);
  s.g.players[0].power = 99.5; s.tick(TICK_MS);
  assert.equal(s.g.phase, 'ROUND_END'); assert.equal(s.g.roundWinner, 'p0');
  s.g.next(); s.tick(READY_MS);
  s.g.players[0].power = 99.5; s.tick(TICK_MS);
  s.g.next();
  assert.equal(s.g.phase, 'END'); assert.deepEqual(s.g.winners, ['p0']);
});

test('시간이 끝나면 전기가 가장 많은 성이 이긴다', () => {
  const s = setup(); toPlay(s);
  s.g.players[1].power = 60;
  s.tick(180_000);
  assert.equal(s.g.roundWinner, 'p1');
});
