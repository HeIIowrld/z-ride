/*
 * Copyright 2026 Mohammad Mahdi Mortazavi
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* Headless simulation harness.

   Runs the shared simulation with no browser, no renderer, and no network so
   that a broken rule surfaces here in two seconds rather than in a live match.
   Also doubles as a balance probe: the summary it prints is the shape of a
   real run. */

import { Sim } from '../packages/shared/src/sim.js';
import { encodeSnapshot, decodeSnapshot, Reader, encodeInput, decodeInput } from '../packages/shared/src/protocol.js';
import { offerUpgrades } from '../packages/shared/src/upgrades.js';
import { ABILITIES } from '../packages/shared/src/abilities.js';
import { EV } from '../packages/shared/src/events.js';

function run(mode, players, seconds, opts = {}) {
  const sim = new Sim({ seed: opts.seed ?? 4242, mode });
  for (let i = 0; i < players; i++) {
    sim.addPlayer(i + 1, { name: 'P' + (i + 1), team: mode === 'coop' ? 0 : i % sim.mode.teams, bot: true });
  }
  if (mode !== 'coop') sim.rebalanceTeams();
  if (sim.mode.waves) sim.director.startWave();

  const dt = 1 / 60;
  const steps = Math.round(seconds / dt);
  const counts = {};
  let peakEnemies = 0, totalEvents = 0, maxStepMs = 0;
  const t0 = performance.now();

  for (let n = 0; n < steps; n++) {
    // Crude bot policy: strafe, always shoot at the nearest thing, dash when close.
    for (const p of sim.players) {
      if (!p.alive || p.down) continue;
      const target = sim.nearestEnemyInCone(p.x, p.z, 0, -1, 999)
        || sim.players.find(o => o !== p && o.alive && o.team !== p.team);
      let ax = 1, az = 0;
      if (target) {
        const dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz) || 1;
        ax = dx / d; az = dz / d;
      }
      const t = n * dt + p.id;
      sim.setInput(p.id, {
        seq: n + 1,
        mx: Math.cos(t * 0.9) * 0.9,
        mz: Math.sin(t * 1.3) * 0.9,
        ax, az, fire: true,
        dash: n % 180 === p.id * 7 % 180,
        ab0: n % 420 === 30, ab1: n % 540 === 90,
        weapon: p.weapon
      });
    }

    const s0 = performance.now();
    sim.step(dt);
    maxStepMs = Math.max(maxStepMs, performance.now() - s0);

    peakEnemies = Math.max(peakEnemies, sim.aliveEnemies);
    sim.events.drain(e => {
      totalEvents++;
      counts[e.t] = (counts[e.t] || 0) + 1;
    });

    // Auto-accept upgrades so co-op keeps advancing through waves.
    if (sim.director.phase === 'choice') {
      for (const p of sim.players) {
        const cards = offerUpgrades(sim.rng, p, ABILITIES, 3);
        const c = cards[0];
        if (c.kind === 'ability') sim.grantAbility(p, c.id, c.slot);
        else sim.applyUpgrade(p, c.id);
      }
      sim.director.startWave();
    }
    if (sim.over) break;
  }

  const wall = performance.now() - t0;
  const snap = sim.snapshot();
  const bytes = encodeSnapshot(snap);
  const round = decodeSnapshot(new Reader(bytes.subarray(1)));

  const evName = Object.fromEntries(Object.entries(EV).map(([k, v]) => [v, k]));
  return {
    mode, players,
    simSeconds: +(steps * dt).toFixed(1),
    wallMs: +wall.toFixed(0),
    realtimeFactor: +((steps * dt * 1000) / wall).toFixed(1),
    maxStepMs: +maxStepMs.toFixed(2),
    wave: sim.director.wave,
    peakEnemies,
    aliveEnemies: sim.aliveEnemies,
    teamScore: sim.teamScore,
    over: sim.over,
    snapshotBytes: bytes.length,
    roundTripOk: round.players.length === snap.players.length && round.enemies.length === snap.enemies.length,
    kills: sim.players.reduce((a, p) => a + p.kills, 0),
    deaths: sim.players.reduce((a, p) => a + p.deaths, 0),
    events: Object.fromEntries(Object.entries(counts).map(([k, v]) => [evName[k] || k, v]))
  };
}

// Protocol sanity first: an input that does not survive a round trip is a
// desync waiting to happen.
const inp = { mx: 0.42, mz: -0.87, ax: 0.6, az: 0.8, fire: true, dash: false, ab0: true, ab1: false, weapon: 2 };
const back = decodeInput(new Reader(encodeInput(1234, inp).subarray(1)));
console.log('input round trip:', {
  seq: back.seq === 1234,
  move: Math.abs(back.mx - inp.mx) < 0.02 && Math.abs(back.mz - inp.mz) < 0.02,
  aim: Math.abs(Math.atan2(back.az, back.ax) - Math.atan2(inp.az, inp.ax)) < 0.03,
  flags: back.fire === inp.fire && back.ab0 === inp.ab0 && back.dash === inp.dash,
  weapon: back.weapon === inp.weapon
});

for (const [mode, n, secs] of [['coop', 1, 120], ['coop', 4, 120], ['tdm', 8, 90], ['squad', 8, 90]]) {
  console.log('\n=== ' + mode + ' x' + n + ' ===');
  console.log(JSON.stringify(run(mode, n, secs), null, 2));
}
