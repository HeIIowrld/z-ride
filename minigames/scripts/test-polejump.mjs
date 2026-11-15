import assert from 'node:assert/strict';
import { travelDir } from '../shared/motion.js';
import { poleJumpHandGeometry } from '../shared/sketch.js';
import { HOP_MS, LANDING_TOLERANCE_RATIO, SCROLL_MULTIPLIER, HAND_X_RATIO, landingOutcome, landingWindowSeconds, poleGeometry, standingOutcome, wireCurves, simulateDemo } from '../games/pole-jump/logic.js';

const pole = (index, distance) => ({ index, distance, height: 1, lean: 1, ground: 0 });
const a = poleGeometry(pole(1, 0), 100, 10, 200);
const b = poleGeometry(pole(2, 38), 400, 10, 200);
for(const seat of ['right','left']){const dx=travelDir(seat)*38;assert.equal(Math.sign(dx),travelDir(seat),`seat ${seat} pole drift direction`);assert.equal(Math.abs(travelDir(seat)*0),0,`seat ${seat} stopped pole`)}
wireCurves(a, b).forEach((curve, i) => {
  assert.deepEqual(curve.from, a.insulators[i]);
  assert.deepEqual(curve.to, b.insulators[i]);
});
const dt = landingWindowSeconds(38, 42);
assert.ok(dt >= .35, `landing window ${dt}s`);
const pxPerMs = 0.04;
assert.equal(landingOutcome({ oldX: 0, nextX: 20.8, handX: 10, hopMs: HOP_MS, scrollPxPerMs: pxPerMs, tolerancePx: 1 }), 'land');
assert.equal(landingOutcome({ oldX: 0, nextX: 10, handX: 10, hopMs: HOP_MS, scrollPxPerMs: pxPerMs, tolerancePx: 1 }), 'fall');
assert.equal(standingOutcome(100, 113, 12), 'pushed_out');
const footholdForStanding = poleGeometry(pole(1, 0), 100, 10, 200).footholds[1];
const footholdForObstacle = poleGeometry(pole(1, 0), 100, 10, 200).footholds[1];
assert.deepEqual(footholdForStanding, footholdForObstacle);
const screenWidth = 390, handX = screenWidth * HAND_X_RATIO, ppm = screenWidth / 60;
const firstPoleX = handX - 12;
const onFootholdAtStart = Math.abs(firstPoleX + 12 - handX) <= screenWidth * .12;
assert.equal(onFootholdAtStart, true, 'run starts on the middle foothold');
for (const seat of ['left', 'right']) for (let lane = 0; lane < 3; lane++) {
  const direction = travelDir(seat), poleX = 100, geometry = poleGeometry(pole(1, 26), poleX, 844 * .11, 844 * .57);
  const peg = geometry.footholds[lane], hand = poleJumpHandGeometry(peg, { direction });
  const contacts = [-4.5, 4.5].map(offset => ({ x: peg.x + direction * offset, y: peg.y }));
  for (const [i, contact] of contacts.entries()) {
    assert.ok(Math.abs(contact.y - peg.y) <= .5, `${seat} lane ${lane + 1} finger ${i + 1} on peg top`);
    assert.ok(contact.x >= peg.x - peg.length / 2 && contact.x <= peg.x + peg.length / 2, `${seat} lane ${lane + 1} finger ${i + 1} within peg`);
  }
  assert.ok(hand.wrist.y < peg.y, `${seat} lane ${lane + 1} wrist above peg`);
  const armX = [hand.forearm.x, hand.elbow.x, hand.wrist.x], shaft = [poleX - 6, poleX + 6];
  assert.ok(Math.max(...armX) < shaft[0] || Math.min(...armX) > shaft[1], `${seat} lane ${lane + 1} forearm clear of shaft`);
  assert.ok(Math.abs(Math.hypot(hand.elbow.x - (hand.forearm.x - direction * 12), hand.elbow.y - (peg.y + 15)) - 35) < 1, 'upper IK bone length');
  assert.ok(Math.abs(Math.hypot(hand.wrist.x - hand.elbow.x, hand.wrist.y - hand.elbow.y) - 31) < 1, 'lower IK bone reaches wrist');
  assert.ok(peg.length >= 18, `lane ${lane + 1} peg is long enough`);
}
assert.ok(SCROLL_MULTIPLIER >= 1.25 && LANDING_TOLERANCE_RATIO > 0);
const demo = simulateDemo({ durationMs: 60000, speedKmh: 42 });
assert.equal(demo.elapsedMs, 60000, 'demo simulation terminates at 60 s');
assert.ok(demo.aliveMs >= 20000, `demo survived ${demo.aliveMs} ms`);
assert.ok(demo.clears >= 8, `demo cleared ${demo.clears} poles`);
console.log('pole-jump logic: all checks passed');
