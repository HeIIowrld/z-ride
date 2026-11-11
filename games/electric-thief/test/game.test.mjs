import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, CASES, STEP_SOC, HAND, SPAN } from '../game.mjs';

function game(n, rng = () => 0) {
  const g = new Game({ rng, now: () => 1000 });
  for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i);
  return g;
}
const begin = g => { g.start(); g.next(); };
function nextCase(g) { g.setSoc(g.nextAt); assert.equal(g.phase, 'CASE'); }
function playAll(g, pick = p => ({ card: 0, watch: g.players.find(o => o.id !== p.id).id })) { for (const p of g.players) g.play(p.id, pick(p)); }
// 손패와 구간을 정해 결과를 고정한다. 모두 v를 내면 합계는 v × 인원(2명 판은 차가 더하는 값 포함)
const set = (g, v, lo) => { for (const p of g.players) p.hand = Array(HAND).fill(v); g.range = { lo, hi: lo + SPAN }; };
const good = g => set(g, 1, g.players.length);   // 합계 = 인원 → 구간 안
const low = g => set(g, 0, 5);                     // 합계 0 → 정전
const high = g => set(g, 4, 1);                    // 합계 크게 → 과부하
const NORMAL = { light: 'NORMAL', air: 'NORMAL' };

test('배터리가 5% 오르기 전에는 사건이 터지지 않는다', () => {
  const g = game(3);
  begin(g);
  g.setSoc(30 + STEP_SOC - 1);
  assert.equal(g.phase, 'CHARGING');
  g.setSoc(30 + STEP_SOC);
  assert.equal(g.phase, 'CASE');
  assert.equal(g.caseNo, 1);
});

test('도둑은 한 명이고, 모두 같은 덱에서 4장을 받으며 공개 화면에 역할과 손패가 없다', () => {
  const g = game(4, Math.random);
  begin(g);
  const roles = g.players.map(p => g.playerView(p.id).role);
  assert.equal(roles.filter(r => r === 'THIEF').length, 1);
  for (const p of g.players) {
    assert.equal(p.hand.length, HAND);
    assert.ok(p.hand.every(v => Number.isInteger(v) && v >= -1 && v <= 4));
  }
  // 충전 중에도 내 손패는 나에게만 보인다
  assert.equal(g.playerView('p0').hand.length, HAND);
  const pub = JSON.stringify(g.publicView());
  assert.ok(!pub.includes('THIEF') && !pub.includes('"hand"') && !pub.includes('role'));
  assert.equal(g.publicView().thief, null);
});

test('낸 카드는 손패에서 빠지고, 다음 사건 전에 한 장 채운다', () => {
  const g = game(3, Math.random);
  begin(g); nextCase(g);
  const before = [...g.player('p0').hand];
  g.play('p0', { card: 2, watch: 'p1' });
  assert.equal(g.player('p0').hand.length, HAND - 1);
  before.splice(2, 1);
  assert.deepEqual(g.player('p0').hand, before);
  g.play('p1', { card: 0, watch: 'p0' }); g.play('p2', { card: 0, watch: 'p0' });
  g.next(); g.next(); g.next(); g.next(); g.next(); // 결과 → 토론 → 투표(기권) → 판결 → 충전
  assert.equal(g.phase, 'CHARGING');
  nextCase(g);
  assert.equal(g.player('p0').hand.length, HAND);
  assert.deepEqual(g.player('p0').hand.slice(0, HAND - 1), before);
});

test('구간은 지금 손패로 맞출 수 있는 합계를 늘 포함한다', () => {
  for (let i = 0; i < 200; i++) {
    const g = game(2 + (i % 3), Math.random);
    begin(g); nextCase(g);
    const { lo, hi } = g.range;
    assert.equal(hi - lo, SPAN);
    let sums = new Set([0]);
    for (const p of g.players) { const n = new Set(); for (const s of sums) for (const v of p.hand) n.add(s + v); sums = n; }
    assert.ok([...sums].some(s => s >= lo && s <= hi), `구간 ${lo}~${hi}`);
  }
});

test('모자라면 정전(불 꺼짐·바람 약하게), 넘치면 과부하(빨간 불·바람 훅), 둘 다 퓨즈가 나간다', () => {
  const g = game(3);
  begin(g);
  nextCase(g); low(g); playAll(g);
  assert.equal(g.result.outcome, 'LOW');
  assert.equal(g.result.success, false);
  assert.deepEqual(g.cabin, { light: 'OFF', air: 'LOW' });
  assert.equal(g.blackouts, 1);
  assert.ok(!JSON.stringify(g.publicView()).includes('value'));
  g.next(); g.next(); g.next(); g.next();
  nextCase(g);
  assert.deepEqual(g.cabin, NORMAL); // 다음 사건에서 돌아온다
  high(g); playAll(g);
  assert.equal(g.result.outcome, 'HIGH');
  assert.deepEqual(g.cabin, { light: 'RED', air: 'GUST' });
  assert.equal(g.blackouts, 2);
});

test('구간 안이면 성공이고 실내는 그대로', () => {
  const g = game(3);
  begin(g); nextCase(g); good(g); playAll(g);
  assert.deepEqual(g.result, { sum: 3, lo: 3, hi: 5, outcome: 'OK', success: true, carNoise: 0, saved: false });
  assert.deepEqual(g.cabin, NORMAL);
  assert.equal(g.blackouts, 0);
});

test('비상 차단기는 정전·과부하를 취소하고 실내를 되돌린다. 3~4명은 2번, 2명은 1번', () => {
  const g = game(3);
  begin(g);
  assert.equal(g.publicView().breakers, 2);
  nextCase(g); good(g); playAll(g);
  assert.throws(() => g.breaker(), /NO_FAULT/); // 성공한 사건엔 못 쓴다
  for (let i = 0; i < 2; i++) {
    g.next(); g.next(); g.next(); g.next();
    nextCase(g); low(g); playAll(g);
    g.breaker();
    assert.equal(g.result.saved, true);
    assert.equal(g.blackouts, 0);
    assert.deepEqual(g.cabin, NORMAL);
    assert.throws(() => g.breaker(), /NO_FAULT/); // 같은 사건에 두 번은 안 된다
  }
  g.next(); g.next(); g.next(); g.next();
  nextCase(g); low(g); playAll(g);
  assert.throws(() => g.breaker(), /NO_BREAKER/);
  assert.equal(g.blackouts, 1);
  const two = game(2);
  begin(two);
  assert.equal(two.publicView().breakers, 1);
});

test('도둑의 몰래 장난은 차를 바꾸고(빨간 불·바람 훅), 가족은 장난을 못 친다', () => {
  const g = game(3);
  begin(g);
  nextCase(g); good(g);
  const family = g.players.find(p => p.id !== g.thiefId);
  assert.throws(() => g.play(family.id, { card: 0, prank: 'LIGHT' }), /BAD_PRANK/);
  playAll(g, p => ({ card: 0, prank: p.id === g.thiefId ? 'WIND' : 'NONE' }));
  assert.equal(g.result.success, true);
  assert.equal(g.tampered, true);
  assert.deepEqual(g.cabin, { light: 'NORMAL', air: 'GUST' });
  const h = game(3);
  begin(h); nextCase(h); good(h);
  playAll(h, p => ({ card: 0, prank: p.id === h.thiefId ? 'LIGHT' : 'NONE' }));
  assert.deepEqual(h.cabin, { light: 'RED', air: 'NORMAL' });
});

test('가족은 단서를 받을 수 있고 단서는 본인에게만 간다', () => {
  const g = game(3);
  begin(g);
  nextCase(g); good(g); playAll(g);
  const family = g.players.find(p => p.id !== g.thiefId);
  assert.match(g.playerView(family.id).clue, /냈어요/);
  assert.ok(!JSON.stringify(g.publicView()).includes(family.clue));
});

function toVote(g) { nextCase(g); good(g); playAll(g); g.next(); g.next(); assert.equal(g.phase, 'VOTE'); }

test('과반이 도둑을 지목하면 가족 승리, 차는 원래대로', () => {
  const g = game(3);
  begin(g); toVote(g);
  for (const p of g.players) g.vote(p.id, p.id === g.thiefId ? 'SKIP' : g.thiefId);
  assert.equal(g.verdict.caught, true);
  g.next();
  assert.equal(g.winner, 'FAMILY');
  assert.equal(g.publicView().thief, g.player(g.thiefId).name);
  assert.deepEqual(g.cabin, NORMAL);
});

test('억울한 체포는 퓨즈 하나로 치고, 과반이 안 되면 아무도 체포되지 않는다', () => {
  const g = game(4);
  begin(g); toVote(g);
  const innocents = g.players.filter(p => p.id !== g.thiefId);
  for (const p of g.players) g.vote(p.id, p.id === innocents[0].id ? innocents[1].id : innocents[0].id);
  assert.equal(g.verdict.arrested, innocents[0].name);
  assert.equal(g.blackouts, 1);
  g.next(); toVote(g);
  const [a, b, c, d] = g.players;
  g.vote(a.id, b.id); g.vote(b.id, a.id); g.vote(c.id, a.id); g.vote(d.id, b.id);
  assert.equal(g.verdict.arrested, null);
  assert.equal(g.blackouts, 1);
});

test('자기 자신은 지목할 수 없고 두 번 투표할 수 없다', () => {
  const g = game(3);
  begin(g); toVote(g);
  assert.throws(() => g.vote('p0', 'p0'), /BAD_VOTE/);
  g.vote('p0', 'SKIP');
  assert.throws(() => g.vote('p0', 'SKIP'), /ALREADY_VOTED/);
});

test('퓨즈 3개가 나가면 도둑 승리, 사건을 다 넘겨도 못 잡으면 도둑 승리', () => {
  const lost = game(3);
  begin(lost);
  for (let i = 0; i < 3; i++) {
    nextCase(lost); (i % 2 ? high : low)(lost); playAll(lost); lost.next(); lost.next();
    for (const p of lost.players) lost.vote(p.id, 'SKIP');
    lost.next();
  }
  assert.equal(lost.winner, 'THIEF');
  const late = game(3);
  begin(late);
  for (let i = 0; i < CASES; i++) {
    toVote(late);
    for (const p of late.players) late.vote(p.id, 'SKIP');
    late.next();
  }
  assert.equal(late.winner, 'THIEF');
});

test('2명은 도둑 없이 차가 몰래 −2~+2를 더하고, 투표 없이 버티면 승리', () => {
  const g = game(2, () => 0); // 차는 늘 −2
  begin(g);
  assert.equal(g.thiefId, null);
  for (let i = 0; i < CASES; i++) {
    nextCase(g); set(g, 2, 2); playAll(g, () => ({ card: 0 })); // 2+2−2 = 2
    assert.equal(g.result.carNoise, -2);
    assert.equal(g.result.sum, 2);
    assert.equal(g.result.success, true);
    g.next();
  }
  assert.equal(g.winner, 'FAMILY');
});

test('시간이 지나면 안 낸 사람은 첫 카드를 내고 투표는 기권이 된다', () => {
  const g = game(3);
  begin(g);
  nextCase(g);
  g.play('p0', { card: 1, watch: 'p1' });
  g.next();
  assert.equal(g.phase, 'RESULT');
  for (const p of g.players) assert.equal(p.hand.length, HAND - 1);
  g.next(); g.next();
  assert.equal(g.phase, 'VOTE');
  g.next();
  assert.deepEqual(g.verdict, { arrested: null, caught: false });
});

test('잘못된 입력은 거부', () => {
  const g = game(3);
  assert.throws(() => g.setSoc(200), /BAD_SOC/);
  begin(g); nextCase(g);
  assert.throws(() => g.play('p0', { card: 9 }), /BAD_CARD/);
  assert.throws(() => g.play('p0', { card: 0, watch: 'p0' }), /BAD_WATCH/);
  assert.throws(() => g.play(g.thiefId, { card: 0, prank: 'CLIMATE' }), /BAD_PRANK/);
  assert.throws(() => g.breaker(), /NO_FAULT/);
  assert.throws(() => game(1).start(), /NEED_PLAYERS/);
});

test('끝난 뒤 다시 하면 같은 사람으로 대기실, 배터리는 유지', () => {
  const g = game(3);
  begin(g); toVote(g);
  for (const p of g.players) g.vote(p.id, p.id === g.thiefId ? 'SKIP' : g.thiefId);
  g.next();
  const soc = g.soc;
  g.next();
  assert.equal(g.phase, 'LOBBY');
  assert.equal(g.soc, soc);
  assert.equal(g.players.length, 3);
  assert.deepEqual(g.playerView('p0').hand, []);
});

test('사건 수는 배터리 여유에 맞추고, 거의 다 찼으면 시작하지 않는다', () => {
  const g = game(3);
  g.setSoc(88);
  begin(g);
  assert.equal(g.publicView().cases, 2);
  const full = game(3);
  full.setSoc(97);
  assert.throws(() => full.start(), /BATTERY_FULL/);
});

test('시작하면 규칙 화면이 먼저 나오고, 모두 이해하면 충전을 기다린다', () => {
  const g = game(3);
  g.start();
  assert.equal(g.phase, 'BRIEFING');
  g.setSoc(60);
  assert.equal(g.phase, 'BRIEFING'); // 규칙을 읽는 동안에는 사건이 터지지 않는다
  g.confirm('p0');
  assert.equal(g.publicView().players[0].done, true);
  g.confirm('p1'); g.confirm('p2');
  assert.equal(g.phase, 'CHARGING');
  assert.equal(g.nextAt, 60 + STEP_SOC);
  assert.ok(['THIEF', 'FAMILY'].includes(g.playerView('p0').role));
});

test('진행자는 규칙 화면을 건너뛸 수 있다', () => {
  const g = game(2);
  g.start(); g.next();
  assert.equal(g.phase, 'CHARGING');
  assert.throws(() => g.confirm('p0'), /NOT_BRIEFING/);
});

test('살펴본 사람이 없으면 단서도 없다', () => {
  const g = game(3);
  begin(g); nextCase(g); good(g); playAll(g, () => ({ card: 0 }));
  assert.match(g.players[0].clue, /아무도/);
});

test('덱을 다 쓰면 버린 카드를 섞어 계속 뽑는다', () => {
  const g = game(4, Math.random);
  g.setSoc(0);
  begin(g);
  for (let i = 0; i < 40; i++) assert.ok(Number.isInteger(g.draw()));
});
