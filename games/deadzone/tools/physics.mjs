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

/* Measures the movement and impact model instead of taking its word for it.

   "Feel" is not unmeasurable. Every property below is a number you can hold a
   controller and recognise: how long to reach top speed, how long to stop,
   what a reversal costs you, how far a shotgun actually moves a rusher. This
   prints them and asserts the ones that have a defensible right answer, so a
   retune that quietly breaks the feel fails here rather than in someone's
   hands.                                                                    */

import { Sim } from '../packages/shared/src/sim.js';
import { T } from '../packages/shared/src/constants.js';
import { WEAPON_BY_ID } from '../packages/shared/src/defs.js';

const DT = 1 / 60;
const fmt = n => (Math.round(n * 1000) / 1000).toFixed(3);

function fresh(mode = 'coop') {
  const sim = new Sim({ seed: 99, mode });
  const p = sim.addPlayer(1, { name: 'P' });
  // Clear the arena so props and enemies cannot contaminate a measurement.
  sim.director.phase = 'idle';
  for (const e of sim.enemies) e.alive = false;
  sim.aliveEnemies = 0;
  p.x = 0; p.z = 0; p.vx = 0; p.vz = 0; p.ivx = 0; p.ivz = 0;
  return { sim, p };
}

const idle = { mx: 0, mz: 0, ax: 1, az: 0, fire: false, dash: false, ab0: false, ab1: false, weapon: 0 };

/* Sequence numbers must climb monotonically for the whole run. setInput drops
   anything at or below the last seq it saw — that is the anti-replay rule the
   netcode depends on — so a per-call counter silently drops every input after
   the first batch and makes the game look like it ignores your controls. */
let SEQ = 0;
function drive(sim, p, input, steps) {
  for (let i = 0; i < steps; i++) {
    sim.setInput(p.id, { ...idle, ...input, seq: ++SEQ });
    sim.stepPlayer(p, DT);
  }
}

const results = [];
const check = (name, value, ok, detail) => {
  results.push({ name, value, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`);
};

/* --- 1. time to reach 95% of top speed from a standing start ------------ */
{
  const { sim, p } = fresh();
  const top = T.player.speed;
  let t = 0;
  for (let i = 0; i < 600; i++) {
    drive(sim, p, { mx: 1, mz: 0 }, 1);
    t += DT;
    if (Math.hypot(p.vx, p.vz) >= top * 0.95) break;
  }
  // Snappy means well under a fifth of a second. Floaty starts above that.
  check('accelerate to 95% top speed', t, t > 0 && t <= 0.2, `${fmt(t)}s (top ${fmt(top)} m/s)`);
}

/* --- 2. time to stop from full speed ------------------------------------ */
{
  const { sim, p } = fresh();
  drive(sim, p, { mx: 1, mz: 0 }, 120);
  let t = 0;
  for (let i = 0; i < 600; i++) {
    drive(sim, p, { mx: 0, mz: 0 }, 1);
    t += DT;
    if (Math.hypot(p.vx, p.vz) < 0.4) break;
  }
  // Long enough to feel like a body, short enough not to feel like ice.
  check('decelerate to a stop', t, t >= 0.12 && t <= 0.55, `${fmt(t)}s`);
}

/* --- 3. a reversal has to pay for the speed it already had -------------- */
{
  const { sim, p } = fresh();
  drive(sim, p, { mx: 1, mz: 0 }, 120);
  const before = p.vx;
  drive(sim, p, { mx: -1, mz: 0 }, 6);   // 100ms of counter-input
  const after = p.vx;
  const scrub = (before - after) / before;
  check('100ms reversal scrubs speed', scrub, scrub > 0.35 && after < before,
    `${Math.round(scrub * 100)}% of forward speed gone`);
}

/* --- 4. turning is not free, but input still bites on frame one --------- */
{
  const { sim, p } = fresh();
  drive(sim, p, { mx: 1, mz: 0 }, 120);
  const v0 = Math.hypot(p.vx, p.vz);
  drive(sim, p, { mx: 0, mz: 1 }, 1);    // one frame of perpendicular input
  const moved = Math.abs(p.vz);
  check('perpendicular input bites in 1 frame', moved, moved > 0.5,
    `${fmt(moved)} m/s sideways after 16ms (was ${fmt(v0)} forward)`);
}

/* --- 5. recoil actually moves the shooter ------------------------------- */
{
  for (const id of ['smg', 'shotgun']) {
    const { sim, p } = fresh();
    p.weapon = WEAPON_BY_ID[id].slot;
    p.unlocked.push(p.weapon);
    const x0 = p.x;
    drive(sim, p, { fire: true, ax: 1, az: 0 }, 1);
    // Let the impulse play out without any input to mask it.
    drive(sim, p, { fire: false }, 30);
    const pushed = x0 - p.x;
    const min = id === 'shotgun' ? 0.6 : 0.05;
    check(`${id} recoil displaces shooter`, pushed, pushed > min,
      `${fmt(pushed)}m backwards`);
  }
}

/* --- 6. knockback survives enemy steering ------------------------------- */
{
  const { sim, p } = fresh();
  const e = sim.spawnEnemy('rusher', 6, 0);
  const d0 = Math.hypot(e.x - p.x, e.z - p.z);
  sim.hurtEnemy(e, 1, p.x, p.z, WEAPON_BY_ID.shotgun.knock * 9, false, p);
  for (let i = 0; i < 18; i++) sim.stepEnemies(DT);
  const d1 = Math.hypot(e.x - p.x, e.z - p.z);
  // Before the impulse channel existed this was ~0: steering ate it whole.
  check('shotgun knocks a rusher back', d1 - d0, d1 - d0 > 1.0,
    `pushed ${fmt(d1 - d0)}m in 300ms`);
}

/* --- 7. a heavy shrugs off what staggers a light ------------------------ */
{
  const { sim, p } = fresh();
  const light = sim.spawnEnemy('rusher', 6, 0);
  const heavy = sim.spawnEnemy('warden', -6, 0);
  const knock = WEAPON_BY_ID.shotgun.knock * 9;
  sim.hurtEnemy(light, 1, p.x, p.z, knock, false, p);
  sim.hurtEnemy(heavy, 1, p.x, p.z, knock, false, p);
  const ok = light.staggerT > heavy.staggerT;
  check('poise separates light from heavy', light.staggerT - heavy.staggerT, ok,
    `rusher ${fmt(light.staggerT)}s vs warden ${fmt(heavy.staggerT)}s of stagger`);
}

/* --- 8. bloom opens under sustained fire and recovers ------------------- */
{
  const { sim, p } = fresh();
  drive(sim, p, { fire: true }, 90);      // 1.5s on the trigger
  const hot = p.bloom;
  drive(sim, p, { fire: false }, 90);
  const cool = p.bloom;
  check('bloom opens then recovers', hot, hot > 0 && cool === 0,
    `${fmt(hot)} rad held, ${fmt(cool)} rad after 1.5s off`);
}

/* --- 9. locomotion alone can never exceed top speed --------------------- */
{
  const { sim, p } = fresh();
  let peak = 0;
  for (let i = 0; i < 600; i++) {
    drive(sim, p, { mx: Math.cos(i * 0.11), mz: Math.sin(i * 0.11) }, 1);
    peak = Math.max(peak, Math.hypot(p.vx, p.vz));
  }
  const cap = T.player.speed * 1.001;
  check('top speed is a hard ceiling', peak, peak <= cap, `peak ${fmt(peak)} m/s, cap ${fmt(cap)}`);
}

/* --- 10. impulses drain to nothing; nobody drifts forever --------------- */
{
  const { sim, p } = fresh();
  p.ivx = T.player.impulseMax; p.ivz = T.player.impulseMax;
  drive(sim, p, {}, 180);                 // 3 seconds
  const left = Math.hypot(p.ivx, p.ivz);
  check('impulse fully drains', left, left === 0, `${fmt(left)} m/s left after 3s`);
}

const failed = results.filter(r => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} failed` : `\nall ${results.length} physics checks pass`);
process.exit(failed.length ? 1 : 0);
