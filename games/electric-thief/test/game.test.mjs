import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, CASES, STEP_SOC } from '../game.mjs';

function game(n, rng = () => 0) {
  const g = new Game({ rng, now: () => 1000 });
  for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i);
  return g;
}
const begin = g => { g.start(); g.next(); };
function nextCase(g) { g.setSoc(g.nextAt); assert.equal(g.phase, 'CASE'); }
function playAll(g, pick = p => ({ card: 0, watch: g.players.find(o => o.id !== p.id).id })) { for (const p of g.players) g.play(p.id, pick(p)); }
const good = g => { for (const p of g.players) p.hand = [3, 3, 3]; };
const bad = g => { for (const p of g.players) p.hand = [0, 0, 0]; };

test('배터리가 5% 오르기 전에는 사건이 터지지 않는다', () => {
  const g = game(3);
  begin(g);
  g.setSoc(30 + STEP_SOC - 1);
  assert.equal(g.phase, 'CHARGING');
  g.setSoc(30 + STEP_SOC);
  assert.equal(g.phase, 'CASE');
  assert.equal(g.caseNo, 1);
});

test('도둑은 한 명이고 손패에 마이너스가 있으며 공개 화면에 역할과 손패가 없다', () => {
  const g = game(4);
  begin(g);
  nextCase(g);
  const roles = g.players.map(p => g.playerView(p.id).role);
  assert.equal(roles.filter(r => r === 'THIEF').length, 1);
  const thief = g.player(g.thiefId);
  assert.ok(thief.hand.some(v => v < 0));
  for (const p of g.players) if (p !== thief) assert.ok(p.hand.every(v => v >= 0));
  const pub = JSON.stringify(g.publicView());
  assert.ok(!pub.includes('THIEF') && !pub.includes('"hand"') && !pub.includes('role'));
  assert.equal(g.publicView().thief, null);
});

test('합계만 공개하고, 실패하면 정전으로 차 실내가 바뀌며 다음 사건에서 돌아온다', () => {
  const g = game(3);
  begin(g);
  nextCase(g); bad(g); playAll(g);
  assert.deepEqual(g.result, { sum: 0, target: 4, success: false, carPenalty: 0 });
  assert.equal(g.blackouts, 1);
  assert.deepEqual(g.cabin, { light: 'OFF', climate: 'COLD' });
  assert.ok(!JSON.stringify(g.publicView()).includes('value'));
  g.next(); g.next();
  for (const p of g.players) g.vote(p.id, 'SKIP');
  g.next();
  assert.equal(g.phase, 'CHARGING');
  nextCase(g);
  assert.deepEqual(g.cabin, { light: 'NORMAL', climate: 'NORMAL' });
});

test('도둑의 점검은 몰래 차를 바꾸고, 가족의 점검은 바꾸지 않는다', () => {
  const g = game(3);
  begin(g);
  nextCase(g); good(g);
  const family = g.players.find(p => p.id !== g.thiefId);
  assert.throws(() => g.play(family.id, { card: 0, prank: 'LIGHT' }), /BAD_PRANK/);
  playAll(g, p => ({ card: 0, prank: p.id === g.thiefId ? 'LIGHT' : 'NONE' }));
  assert.equal(g.result.success, true);
  assert.equal(g.tampered, true);
  assert.deepEqual(g.cabin, { light: 'RED', climate: 'NORMAL' });
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
  assert.deepEqual(g.cabin, { light: 'NORMAL', climate: 'NORMAL' });
});

test('억울한 체포는 정전 한 번으로 치고, 과반이 안 되면 아무도 체포되지 않는다', () => {
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

test('정전 3번이면 도둑 승리, 사건을 다 넘겨도 못 잡으면 도둑 승리', () => {
  const lost = game(3);
  begin(lost);
  for (let i = 0; i < 3; i++) {
    nextCase(lost); bad(lost); playAll(lost); lost.next(); lost.next();
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

test('2명은 도둑 없이 차가 방해하고 투표 없이 버티면 승리', () => {
  const g = game(2, () => 0);
  begin(g);
  assert.equal(g.thiefId, null);
  for (let i = 0; i < CASES; i++) {
    nextCase(g); good(g); playAll(g);
    assert.equal(g.result.carPenalty, 1);
    g.next();
  }
  assert.equal(g.winner, 'FAMILY');
});

test('시간이 지나면 안 낸 사람은 첫 카드로 처리되고 투표는 기권이 된다', () => {
  const g = game(3);
  begin(g);
  nextCase(g);
  g.play('p0', { card: 1, watch: 'p1' });
  g.next();
  assert.equal(g.phase, 'RESULT');
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
  assert.throws(() => g.play('p0', { card: 0, prank: 'DOOR' }), /BAD_PRANK/);
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
