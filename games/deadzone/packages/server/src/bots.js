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

/* ================================ BOTS ==================================

   Backfill for a PvP match that started 3v4. A bot is not an AI project — it
   is a body that shoots back, so the seven people who did show up get a real
   game instead of a walkover.

   Everything here goes through `sim.setInput`, exactly like a human. A bot has
   no privileged access: the same weapon cooldowns, the same dash charges, the
   same damage rules. That is not politeness, it is the only way to be sure a
   bot cannot become a cheat vector if a future refactor lets a client claim
   `bot: true`.

   Deliberately *not* using `sim.rng`: that generator is part of the shared
   deterministic state, and a bot burning draws from it would desync a client
   that rebuilds the world from the seed. Where a bot needs variation it uses a
   hash of its own id against `sim.time`, which is reproducible and costs
   nothing.                                                                   */

import { WEAPONS } from '../../shared/src/defs.js';
import { angleDelta, clamp } from '../../shared/src/math.js';

/* Keyed on the player object, so a fresh Sim (rematch, or the room waking up
   after hibernation) starts every bot from a clean slate with no bookkeeping. */
const brains = new WeakMap();

const ENGAGE = 26;        // metres — inside this a bot commits to the fight
const PREFERRED = 13;     // where it wants to stand while committed
const TURN_RATE = 6.5;    // rad/s. A bot that snaps to target is unbeatable.
const AIM_TOLERANCE = 0.13;
const DASH_COOLDOWN = 2.2;
const RETREAT_HP = 0.30;

export function driveBots(sim, dt) {
  for (const p of sim.players) {
    if (!p.bot) continue;
    if (!p.alive || p.down) continue;

    let b = brains.get(p);
    if (!b) {
      b = { seq: 0, aim: p.aimA, strafe: (p.id & 1) ? 1 : -1, flipT: 0, dashT: 0, wasHurt: 0, lastHp: p.hp };
      brains.set(p, b);
    }

    b.flipT -= dt;
    b.dashT -= dt;
    if (p.hp < b.lastHp) b.wasHurt = 1.2;
    b.lastHp = p.hp;
    b.wasHurt = Math.max(0, b.wasHurt - dt);

    // Strafe direction flips on an id-dependent period so a squad of bots does
    // not orbit in lockstep and read as one organism.
    if (b.flipT <= 0) {
      b.flipT = 0.8 + ((p.id * 37) % 13) * 0.09;
      b.strafe = -b.strafe;
    }

    const target = pickTarget(sim, p);
    const maxEhp = p.maxHp + p.maxShield + p.mods.shieldBonus;
    const retreating = (p.hp + p.shield) / maxEhp < RETREAT_HP;

    let mx = 0, mz = 0, fire = false, dash = false, ab0 = false, ab1 = false;
    let wantA = b.aim;

    if (target) {
      const dx = target.x - p.x, dz = target.z - p.z;
      const d = Math.hypot(dx, dz) || 1;
      const ux = dx / d, uz = dz / d;

      // Lead the shot by time-of-flight. Without this a bot never lands a hit
      // on anything strafing, which is what every other bot is doing.
      const w = WEAPONS[p.weapon] || WEAPONS[0];
      const tof = Math.min(0.6, d / Math.max(1, w.speed * p.mods.projSpeed));
      const px = target.x + (target.vx || 0) * tof - p.x;
      const pz = target.z + (target.vz || 0) * tof - p.z;
      wantA = Math.atan2(pz, px);

      // A sine wobble instead of noise: bounded error, no accumulating drift,
      // and it makes the miss pattern feel like a shaky hand rather than dice.
      wantA += Math.sin(sim.time * 2.7 + p.id * 1.9) * 0.05;

      // Radial term: close the gap, or open it when hurt or too close.
      const want = retreating ? ENGAGE + 8 : PREFERRED;
      const radial = clamp((d - want) / 6, -1, 1);
      const tangent = b.strafe * (retreating ? 0.35 : 0.85);
      mx = ux * radial - uz * tangent;
      mz = uz * radial + ux * tangent;

      const aimed = Math.abs(angleDelta(b.aim, Math.atan2(dz, dx))) < AIM_TOLERANCE;
      const clear = sim.world.lineOfSight(p.x, p.z, target.x, target.z);
      fire = aimed && clear && d < ENGAGE + 6;

      // Dash for exactly two reasons: to break contact when bleeding, and to
      // cross the open ground where standing still gets you shot.
      if (b.dashT <= 0 && p.dashCharge > 0 && p.dashT <= 0) {
        if ((retreating && b.wasHurt > 0) || d > ENGAGE + 4) {
          dash = true;
          b.dashT = DASH_COOLDOWN;
        }
      }

      // Actives fire on cooldown at a target that is actually in front of it.
      if (!retreating && d < 16 && aimed) {
        ab0 = !!(p.abilities[0] && p.abilities[0].cd <= 0);
        ab1 = !!(p.abilities[1] && p.abilities[1].cd <= 0);
      }
    } else {
      // Nothing to shoot: drift toward the middle where the fights happen.
      const d = Math.hypot(p.x, p.z) || 1;
      mx = -p.x / d; mz = -p.z / d;
      wantA = Math.atan2(mz, mx);
    }

    // The closing ring and the arena wall both hurt. Steer inward before they
    // become a problem rather than after.
    const fromCentre = Math.hypot(p.x, p.z);
    const edge = sim.shrinkRadius - 6;
    if (fromCentre > edge) {
      const pull = clamp((fromCentre - edge) / 5, 0, 1.4);
      mx -= (p.x / (fromCentre || 1)) * pull;
      mz -= (p.z / (fromCentre || 1)) * pull;
    }

    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }

    // Rate-limited turn, so a bot that gets flanked pays the same cost a human
    // does for having been looking the wrong way.
    b.aim += clamp(angleDelta(b.aim, wantA), -TURN_RATE * dt, TURN_RATE * dt);

    sim.setInput(p.id, {
      seq: ++b.seq,
      mx, mz,
      ax: Math.cos(b.aim), az: Math.sin(b.aim),
      fire, dash, ab0, ab1,
      weapon: p.weapon
    });
  }
}

/** Enemy players first, hazard enemies as a fallback — but only if the player
 *  is meaningfully further away, otherwise a bot walks past the person
 *  shooting it to punch a drone. */
function pickTarget(sim, p) {
  const foe = sim.mode.pvp ? sim.nearestPlayer(p.x, p.z, p.team) : null;
  const mob = sim.nearestEnemyInCone(p.x, p.z, 0, -1, ENGAGE + 14);
  if (!foe) return mob;
  if (!mob) return foe;
  const df = Math.hypot(foe.x - p.x, foe.z - p.z);
  const dm = Math.hypot(mob.x - p.x, mob.z - p.z);
  return df <= dm + 10 ? foe : mob;
}
