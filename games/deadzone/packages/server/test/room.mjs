/* Bot policy harness.

   The Durable Object cannot be imported outside workerd, so this test does the
   next most useful thing: it drives the exact same Sim, at the exact same
   20Hz, through the exact same `driveBots` the room calls, and asserts the
   bots actually play. A bot backfill that stands still is worse than no
   backfill at all — it turns a 3v4 into a 3v3 plus a scarecrow. */

import { Sim } from '../../shared/src/sim.js';
import { T } from '../../shared/src/constants.js';
import { driveBots } from '../src/bots.js';

const DT = 1 / T.sim.netHz;
const SECONDS = 30;
const STEPS = Math.round(SECONDS / DT);

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  console.log('  ok  ' + msg);
}

function run() {
  const sim = new Sim({ seed: 0xBADCAFE, mode: 'tdm', authoritative: true });
  for (let i = 1; i <= 8; i++) sim.addPlayer(i, { name: 'BOT-' + i, bot: true });
  sim.rebalanceTeams();

  let maxStepMs = 0, events = 0, thrown = null;
  const t0 = performance.now();

  try {
    for (let n = 0; n < STEPS; n++) {
      const s0 = performance.now();
      driveBots(sim, DT);
      sim.step(DT);
      maxStepMs = Math.max(maxStepMs, performance.now() - s0);
      sim.events.drain(() => { events++; });
      if (sim.over) break;
    }
  } catch (err) {
    thrown = err;
  }

  const wall = performance.now() - t0;
  const kills = sim.players.reduce((a, p) => a + p.kills, 0);
  const shots = sim.players.reduce((a, p) => a + p.shotsFired, 0);
  const hits = sim.players.reduce((a, p) => a + p.shotsHit, 0);
  const moved = sim.players.filter(p => Math.hypot(p.x, p.z) > 0.5).length;

  return { sim, thrown, kills, shots, hits, events, moved, wall, maxStepMs };
}

console.log('OVERRUN bot policy — tdm, 8 bots, ' + SECONDS + 's at ' + T.sim.netHz + 'Hz');
const r = run();

console.log(JSON.stringify({
  simSeconds: SECONDS,
  wallMs: +r.wall.toFixed(0),
  realtimeFactor: +((SECONDS * 1000) / r.wall).toFixed(1),
  maxStepMs: +r.maxStepMs.toFixed(2),
  shotsFired: r.shots,
  shotsHit: r.hits,
  accuracy: r.shots ? +(r.hits / r.shots).toFixed(3) : 0,
  kills: r.kills,
  deaths: r.sim.players.reduce((a, p) => a + p.deaths, 0),
  teamScore: r.sim.teamScore,
  events: r.events,
  aliveEnemies: r.sim.aliveEnemies,
  perBot: r.sim.players.map(p => ({ id: p.id, team: p.team, k: p.kills, d: p.deaths, hp: Math.round(p.hp) }))
}, null, 2));

assert(r.thrown === null, 'no exception thrown across ' + STEPS + ' ticks'
  + (r.thrown ? ' -> ' + (r.thrown.stack || r.thrown) : ''));
assert(r.kills > 0, 'bots produced kills (' + r.kills + ')');
assert(r.shots > 0, 'bots fired weapons (' + r.shots + ')');
assert(r.hits > 0, 'bots landed shots (' + r.hits + ')');
assert(r.moved === r.sim.players.length, 'every bot left its spawn point');
assert(r.maxStepMs < 50, 'worst tick stayed inside the 50ms budget (' + r.maxStepMs.toFixed(2) + 'ms)');

console.log('\nPASS');
