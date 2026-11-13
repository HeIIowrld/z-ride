import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, budgetFor, W, H, CHARGER, READY_MS, MOVE_GAP_MS, BOLT } from '../game.mjs';

function setup(n = 2, seed = 1) {
  let t = 1000, s = seed;
  const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const g = new Game({ now: () => t, rng });
  for (let i = 0; i < n; i++) g.addPlayer('p' + i, '이름' + i);
  const tick = ms => { t += ms; };
  return { g, tick, play() { g.start(); tick(READY_MS); g.expire(); } };
}
const at = (x, y) => y * W + x;
/** 벽 없는 판으로 바꿔 움직임만 본다. */
function clear(g) { g.occ.fill(-1); g.bolts.clear(); g.players.forEach((p, i) => { g.occ[at(p.x, p.y)] = i; }); }

test('충전할 양으로 ⚡ 예산을 정한다(최소 35, 최대 80)', () => {
  assert.equal(budgetFor(30, 80), 60);
  assert.equal(budgetFor(75, 80), 35);
  assert.equal(budgetFor(5, 100), 80);
  assert.equal(budgetFor(null, null), 52);
});

test('지도는 네 귀퉁이가 대칭이고 모든 출발점에서 충전기까지 길이 있다', () => {
  for (let seed = 1; seed < 30; seed++) {
    const { g } = setup(4, seed); g.start();
    for (let i = 0; i < W * H; i++) {
      const x = i % W, y = Math.floor(i / W);
      assert.equal(g.occ[i] === -2, g.occ[at(W - 1 - x, H - 1 - y)] === -2);
    }
    for (const p of g.players) assert.ok(g.path(at(p.x, p.y)));
    assert.notEqual(g.occ[at(CHARGER.x, CHARGER.y)], -2);
  }
});

test('한 칸에 ⚡1, 지나간 칸은 벽이 되고, 너무 빠른 연타는 무시한다', () => {
  const { g, tick, play } = setup(); play(); clear(g);
  const p = g.players[0], start = p.energy;
  g.move('p0', 'R'); assert.deepEqual([p.x, p.y, p.energy], [1, 0, start - 1]);
  g.move('p0', 'R'); assert.equal(p.x, 1, '간격 안의 이동은 무시');
  tick(MOVE_GAP_MS); g.move('p0', 'L'); assert.equal(p.x, 1, '내 선으로는 못 돌아감');
  tick(MOVE_GAP_MS); g.move('p0', 'D'); assert.deepEqual([p.x, p.y], [1, 1]);
  assert.equal(g.occ[at(1, 0)], 0);
});

test('⚡ 셀을 밟으면 ⚡가 늘고, 충전기에 닿으면 판을 이긴다', () => {
  const { g, tick, play } = setup(); play(); clear(g);
  g.bolts.add(at(1, 0));
  const p = g.players[0], e = p.energy;
  g.move('p0', 'R'); assert.equal(p.energy, e - 1 + BOLT);
  // (1,0) → (6,4) 직진
  for (const d of ['R', 'R', 'R', 'R', 'R', 'D', 'D', 'D', 'D']) { tick(MOVE_GAP_MS); g.move('p0', d); }
  assert.equal(g.phase, 'ROUND_END');
  assert.equal(g.roundWinner, 'p0');
  assert.equal(p.score, 1);
});

test('절연 장갑은 막힌 칸을 뛰어넘고, 고전압 코일은 앞쪽 남의 선을 끊는다', () => {
  const { g, tick, play } = setup(); play(); clear(g);
  const p = g.players[0];
  p.bag = [{ id: 'a', kind: 'JUMP', from: 'x' }, { id: 'b', kind: 'CUT', from: 'x' }];
  g.occ[at(1, 0)] = 1; g.players[1].trail.push(at(1, 0));
  g.move('p0', 'R'); assert.equal(p.x, 0, '막혀서 못 감');
  g.useItem('p0', 'a'); tick(MOVE_GAP_MS); g.move('p0', 'R');
  assert.deepEqual([p.x, p.y], [2, 0], '한 칸 건너뜀');
  g.occ[at(3, 0)] = 1; g.occ[at(4, 0)] = 1; g.players[1].trail.push(at(3, 0), at(4, 0));
  g.useItem('p0', 'b');
  assert.equal(g.occ[at(3, 0)], -1); assert.equal(g.occ[at(4, 0)], -1);
  assert.ok(g.players[1].trail.includes(null));
  assert.throws(() => g.useItem('p0', 'b'), /NO_ITEM/);
});

test('게임 중 배터리가 10% 단위를 넘으면 서지로 모든 선이 지워진다', () => {
  const { g, tick, play } = setup();
  g.setSoc(48, 80);
  assert.equal(g.budget, budgetFor(48, 80));
  play(); clear(g);
  g.move('p0', 'R'); tick(MOVE_GAP_MS); g.move('p0', 'R');
  g.setSoc(49); assert.equal(g.event, null);
  g.setSoc(50);
  assert.equal(g.event.kind, 'SURGE');
  assert.equal(g.players[0].trail.length, 1);
  assert.equal(g.occ[at(1, 0)], -1);
  g.setSoc(60); assert.equal(g.event.kind, 'BOOST');
  const e = g.players[0].energy; tick(MOVE_GAP_MS); g.move('p0', 'D');
  assert.equal(g.players[0].energy, e, '무료 이동 중엔 ⚡를 안 씀');
  assert.throws(() => g.setSoc(120), /BAD_SOC/);
});

test('시간이 끝나면 가장 가까운 사람이 가져가고, 3판 뒤 점수·남은 ⚡로 순위를 정한다', () => {
  const { g, tick, play } = setup(); play(); clear(g);
  g.move('p0', 'R');
  g.expire();
  assert.equal(g.roundWinner, 'p0');
  g.next(); tick(READY_MS); g.expire(); g.expire();
  g.next(); tick(READY_MS); g.expire(); g.expire();
  g.next();
  assert.equal(g.phase, 'END');
  assert.ok(g.winners.length >= 1);
  assert.throws(() => g.addPlayer('x', 'x'), /GAME_STARTED/);
});
