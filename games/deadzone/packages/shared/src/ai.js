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

/* ============================== ENEMY AI ================================

   The old brain was one line: run at the player. It produced a crowd that
   moved as a single blob, walked into pillars, and never surprised anyone.

   This one has four layers, cheapest first:

     1. PERCEPTION  — line of sight, hearing, and a memory of where you were.
        Enemies no longer know your position by divine right; they have to
        have seen you, heard you shoot, or been told by a squadmate.

     2. FLOW FIELD  — one multi-source BFS from every living target across a
        2.4m grid, rebuilt three times a second. Gives every enemy a route
        around cover for the cost of two array reads. Scales to 250 enemies
        because the cost does not depend on enemy count at all.

     3. UTILITY     — each enemy scores six behaviours against its situation
        and commits to the winner with hysteresis, so it decides rather than
        dithers.

     4. SQUAD       — a virtual commander hands out roles inside a radius:
        someone pressures, someone flanks wide, ranged units hang back and
        punish the retreat. This is what makes a group feel coordinated
        instead of merely numerous.

   Fairness is a hard constraint, not a tuning value: every attack telegraphs
   for at least T.ai.minTelegraph seconds, and nothing spawns inside your
   shoulder. Difficulty comes from better decisions, never from cheating. */

import { TAU, clamp, dist2, angleDelta } from './math.js';
import { T } from './constants.js';

export const ROLE = {
  PRESSURE: 0,   // close the distance, be the problem the player must answer
  FLANK: 1,      // arc wide, arrive from a direction the player is not facing
  SUPPORT: 2,    // hold at range, punish repositioning
  ANCHOR: 3,     // hold ground, deny an approach lane
  REGROUP: 4     // isolated — rejoin before dying alone
};

export const BEHAVIOR = {
  ENGAGE: 'engage',
  FLANK: 'flank',
  KITE: 'kite',
  SEARCH: 'search',
  HUNT: 'hunt',
  HOLD: 'hold',
  RETREAT: 'retreat'
};

/* ---------------------------------------------------------------- FLOW FIELD */

export class FlowField {
  constructor(radius, cell = T.ai.gridCell) {
    this.cell = cell;
    this.radius = radius;
    this.n = Math.ceil((radius * 2) / cell) + 2;
    this.half = this.n / 2;
    const size = this.n * this.n;
    this.cost = new Uint8Array(size);      // 255 = impassable
    this.dist = new Uint16Array(size);     // BFS depth, 65535 = unreached
    this.dirX = new Int8Array(size);       // gradient, quantised to -100..100
    this.dirZ = new Int8Array(size);
    this.queue = new Int32Array(size);
    this.rebuildT = 0;
    this.dirty = true;
  }

  idx(gx, gz) { return gz * this.n + gx; }
  toGrid(x) { return Math.round(x / this.cell + this.half); }
  toWorld(g) { return (g - this.half) * this.cell; }

  /** Bake static cost from the arena. Only needs redoing when cover changes. */
  bakeCost(world) {
    this.cost.fill(0);
    const n = this.n, c = this.cell;
    for (const p of world.props) {
      if (!p.alive || p.y < -0.3 || p.h < 0.9) continue;
      const pad = p.r + 0.9;                       // enemy radius margin
      const g0x = Math.max(0, this.toGrid(p.x - pad));
      const g1x = Math.min(n - 1, this.toGrid(p.x + pad));
      const g0z = Math.max(0, this.toGrid(p.z - pad));
      const g1z = Math.min(n - 1, this.toGrid(p.z + pad));
      for (let gz = g0z; gz <= g1z; gz++) {
        for (let gx = g0x; gx <= g1x; gx++) {
          const wx = this.toWorld(gx), wz = this.toWorld(gz);
          const d2 = dist2(wx, wz, p.x, p.z);
          if (d2 < pad * pad) this.cost[this.idx(gx, gz)] = 255;
          else if (d2 < (pad + c) ** 2) {
            // Soft ring around cover: enemies prefer not to hug walls, which
            // stops the "sliding along a pillar forever" failure mode.
            const i = this.idx(gx, gz);
            if (this.cost[i] < 3) this.cost[i] = 3;
          }
        }
      }
    }
    // Outside the arena disc is impassable.
    const lim = (this.radius - 0.8) ** 2;
    for (let gz = 0; gz < n; gz++) {
      for (let gx = 0; gx < n; gx++) {
        const wx = this.toWorld(gx), wz = this.toWorld(gz);
        if (wx * wx + wz * wz > lim) this.cost[this.idx(gx, gz)] = 255;
      }
    }
    this.dirty = true;
  }

  /** Multi-source BFS from every target, then a one-pass gradient.
   *  O(cells), independent of how many enemies read it. */
  build(targets) {
    const n = this.n, size = n * n;
    this.dist.fill(65535);
    let head = 0, tail = 0;
    for (const t of targets) {
      const gx = clamp(this.toGrid(t.x), 0, n - 1);
      const gz = clamp(this.toGrid(t.z), 0, n - 1);
      const i = this.idx(gx, gz);
      if (this.cost[i] === 255) continue;
      this.dist[i] = 0;
      this.queue[tail++] = i;
    }
    if (tail === 0) return;

    while (head < tail) {
      const i = this.queue[head++];
      const d = this.dist[i] + 1;
      const gx = i % n, gz = (i / n) | 0;
      for (let k = 0; k < 8; k++) {
        const ox = NEI_X[k], oz = NEI_Z[k];
        const nx = gx + ox, nz = gz + oz;
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const j = nz * n + nx;
        if (this.cost[j] === 255) continue;
        // Diagonals cost slightly more; the extra step keeps paths from
        // cutting corners into geometry.
        const step = d + (k > 3 ? 1 : 0) + (this.cost[j] > 0 ? 2 : 0);
        if (step < this.dist[j]) {
          this.dist[j] = step;
          this.queue[tail++] = j;
          if (tail >= size) { tail = size - 1; break; }
        }
      }
    }

    // Gradient: point at the cheapest neighbour.
    for (let i = 0; i < size; i++) {
      if (this.cost[i] === 255 || this.dist[i] === 65535) { this.dirX[i] = 0; this.dirZ[i] = 0; continue; }
      const gx = i % n, gz = (i / n) | 0;
      let best = this.dist[i], bx = 0, bz = 0;
      for (let k = 0; k < 8; k++) {
        const nx = gx + NEI_X[k], nz = gz + NEI_Z[k];
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const d = this.dist[nz * n + nx];
        if (d < best) { best = d; bx = NEI_X[k]; bz = NEI_Z[k]; }
      }
      const l = Math.hypot(bx, bz) || 1;
      this.dirX[i] = (bx / l) * 100;
      this.dirZ[i] = (bz / l) * 100;
    }
  }

  /** Steering direction at a world position. Zero vector when unreachable. */
  sample(x, z, out) {
    const gx = clamp(this.toGrid(x), 0, this.n - 1);
    const gz = clamp(this.toGrid(z), 0, this.n - 1);
    const i = this.idx(gx, gz);
    out.x = this.dirX[i] / 100;
    out.z = this.dirZ[i] / 100;
    return this.dist[i];
  }
}

const NEI_X = [1, -1, 0, 0, 1, 1, -1, -1];
const NEI_Z = [0, 0, 1, -1, 1, -1, 1, -1];

/* ---------------------------------------------------------------- PERCEPTION */

/** Update what an enemy believes about the world. Belief, not truth — the
 *  gap between the two is where the game stops feeling scripted. */
export function perceive(e, sim) {
  const mem = e.mem;
  mem.t += sim.dt;

  let best = null, bestD2 = Infinity;
  for (const p of sim.players) {
    if (!p.alive || (sim.mode.pve && p.down)) continue;
    if (sim.mode.pvp && p.team === e.team) continue;
    const d2 = dist2(e.x, e.z, p.x, p.z);
    if (d2 > T.ai.sightRange * T.ai.sightRange) continue;

    // Facing cone. Enemies genuinely cannot see behind themselves, which is
    // what makes flanking the player's tool as well as theirs.
    const a = Math.atan2(p.z - e.z, p.x - e.x);
    const inCone = Math.abs(angleDelta(e.faceA, a)) < T.ai.sightHalfAngle;
    const heard = p.loudT > 0 && d2 < T.ai.hearRadius * T.ai.hearRadius;
    if (!inCone && !heard) continue;
    if (!sim.world.lineOfSight(e.x, e.z, p.x, p.z)) continue;

    if (d2 < bestD2) { bestD2 = d2; best = p; }
  }

  if (best) {
    mem.target = best.id;
    mem.x = best.x; mem.z = best.z;
    mem.vx = best.vx; mem.vz = best.vz;
    mem.seen = true;
    mem.t = 0;
    mem.confidence = 1;
  } else {
    mem.seen = false;
    mem.confidence = Math.max(0, 1 - mem.t / T.ai.memory);
    // Dead reckoning: it keeps chasing where you were going, not where you were.
    if (mem.confidence > 0) {
      mem.x += mem.vx * sim.dt * 0.5;
      mem.z += mem.vz * sim.dt * 0.5;
    }
  }
  return best;
}

/** Squadmates shout. A single enemy seeing you compromises the whole group,
 *  which is the difference between "they found me" and "they all found me". */
export function shareIntel(sim) {
  const list = sim.enemies;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.alive || !a.mem.seen) continue;
    const n = sim.hash.query(a.x, a.z, T.ai.squadRadius, sim.qbuf);
    for (let k = 0; k < n; k++) {
      const b = sim.qbuf[k];
      if (b === a || !b.alive || !b.isEnemy) continue;
      if (b.mem.confidence >= 0.9) continue;
      b.mem.target = a.mem.target;
      b.mem.x = a.mem.x; b.mem.z = a.mem.z;
      b.mem.vx = a.mem.vx; b.mem.vz = a.mem.vz;
      b.mem.confidence = 0.85;   // second-hand information, deliberately worse
      b.mem.t = Math.min(b.mem.t, 0.6);
    }
  }
}

/* ------------------------------------------------------------------ COMMAND */

/** Assign roles inside each cluster. Runs a few times a second, not per tick. */
export function assignRoles(sim) {
  const byTarget = new Map();
  for (const e of sim.enemies) {
    if (!e.alive || e.mem.confidence <= 0) { if (e.alive) e.role = ROLE.REGROUP; continue; }
    const k = e.mem.target;
    let arr = byTarget.get(k);
    if (!arr) { arr = []; byTarget.set(k, arr); }
    arr.push(e);
  }

  for (const [tid, group] of byTarget) {
    const target = sim.playerById(tid);
    if (!target) continue;
    group.sort((a, b) => dist2(a.x, a.z, target.x, target.z) - dist2(b.x, b.z, target.x, target.z));

    let flankers = 0;
    const maxFlank = Math.min(T.ai.maxFlankers, Math.ceil(group.length * 0.4));
    for (let i = 0; i < group.length; i++) {
      const e = group[i];
      const def = e.def;

      if (def.brain === 'anchor') { e.role = ROLE.ANCHOR; continue; }
      if (def.ranged && !def.contact) { e.role = ROLE.SUPPORT; continue; }

      if ((def.prefersFlank || i >= 2) && flankers < maxFlank) {
        e.role = ROLE.FLANK;
        // Alternate sides so a flank is a pincer, not a conga line.
        e.flankSide = (flankers % 2 === 0) ? 1 : -1;
        // Stagger the arc so they do not arrive as one clump.
        e.flankArc = T.ai.flankArc * (0.6 + (flankers / Math.max(1, maxFlank)) * 0.8);
        flankers++;
      } else {
        e.role = ROLE.PRESSURE;
      }
    }
  }
}

/* ------------------------------------------------------------------ UTILITY */

const scratch = { x: 0, z: 0 };

/** Score every behaviour and commit to the best, with hysteresis so an enemy
 *  never flip-flops between two nearly-equal options mid-stride. */
export function chooseBehavior(e, sim) {
  const def = e.def;
  const mem = e.mem;
  if (mem.confidence <= 0.001) return BEHAVIOR.HUNT;

  const d = Math.hypot(mem.x - e.x, mem.z - e.z);
  const hpFrac = e.hp / e.maxHp;
  const prefRange = def.ranged ? def.range * 0.72 : def.r + 1.2;

  const s = e._scores || (e._scores = {});
  // ENGAGE: the default. Wants to be at preferred range.
  s[BEHAVIOR.ENGAGE] = 0.55 + clamp((d - prefRange) / 30, 0, 1) * 0.5 + (e.role === ROLE.PRESSURE ? 0.35 : 0);

  // FLANK: only worth it when there is room and someone else is holding attention.
  s[BEHAVIOR.FLANK] = (e.role === ROLE.FLANK ? 0.85 : 0.05) * clamp(d / 24, 0.2, 1);

  // KITE: ranged units backing off when the player closes.
  s[BEHAVIOR.KITE] = def.ranged && d < prefRange * 0.7 ? 0.9 + (1 - d / prefRange) * 0.5 : 0;

  // SEARCH: memory going cold.
  s[BEHAVIOR.SEARCH] = (1 - mem.confidence) * 1.4;

  // HOLD: an anchor with line of sight has no reason to move.
  s[BEHAVIOR.HOLD] = e.role === ROLE.ANCHOR && mem.seen && d < def.range ? 1.1 : 0;

  // RETREAT: badly hurt, non-elite, and there is somewhere to go. Wounded
  // enemies breaking off is what makes a fight read as a fight.
  s[BEHAVIOR.RETREAT] = (!def.elite && hpFrac < 0.25 && d < 12) ? 0.7 + (0.25 - hpFrac) * 3 : 0;

  let bestKey = BEHAVIOR.ENGAGE, bestVal = -Infinity;
  for (const k in s) if (s[k] > bestVal) { bestVal = s[k]; bestKey = k; }

  // Hysteresis: the incumbent gets a 15% bonus, so ties do not oscillate.
  if (e.behavior && e.behavior !== bestKey && s[e.behavior] > bestVal * 0.85) return e.behavior;
  return bestKey;
}

/** Turn the chosen behaviour into a desired velocity direction.
 *  Writes into `out` and returns a speed multiplier. */
export function steer(e, sim, out) {
  const def = e.def;
  const mem = e.mem;
  const dx = mem.x - e.x, dz = mem.z - e.z;
  const d = Math.hypot(dx, dz) || 1;
  const nx = dx / d, nz = dz / d;
  let speedMul = 1;

  // Base direction from the flow field when the target is far or occluded,
  // straight-line when it is close and visible. The field is for navigation;
  // the straight line is for the kill.
  let bx, bz;
  if (mem.seen && d < 14) { bx = nx; bz = nz; }
  else {
    sim.flow.sample(e.x, e.z, scratch);
    if (scratch.x === 0 && scratch.z === 0) { bx = nx; bz = nz; }
    else { bx = scratch.x; bz = scratch.z; }
  }

  switch (e.behavior) {
    case BEHAVIOR.FLANK: {
      // Arc around the target's facing rather than around the target: the
      // point is to arrive where they are not looking.
      const tgt = sim.playerById(mem.target);
      const base = tgt ? tgt.aimA : Math.atan2(-nz, -nx);
      const want = base + Math.PI + e.flankSide * e.flankArc;
      const wx = mem.x + Math.cos(want) * (def.ranged ? def.range * 0.8 : 7);
      const wz = mem.z + Math.sin(want) * (def.ranged ? def.range * 0.8 : 7);
      const fx = wx - e.x, fz = wz - e.z, fd = Math.hypot(fx, fz) || 1;
      // Blend toward the direct approach as the flank position is reached.
      const k = clamp(fd / 8, 0, 1);
      bx = (fx / fd) * k + nx * (1 - k);
      bz = (fz / fd) * k + nz * (1 - k);
      speedMul = 1.08;
      break;
    }
    case BEHAVIOR.KITE: {
      // Back off along an arc, not straight back — retreating in a line into
      // a wall is the classic ranged-AI failure.
      bx = -nx * 0.8 - nz * e.bias * 0.7;
      bz = -nz * 0.8 + nx * e.bias * 0.7;
      speedMul = 0.95;
      break;
    }
    case BEHAVIOR.RETREAT: {
      bx = -nx; bz = -nz;
      speedMul = 1.25;
      break;
    }
    case BEHAVIOR.HOLD: {
      bx = 0; bz = 0;
      speedMul = 0;
      break;
    }
    case BEHAVIOR.SEARCH: {
      // Walk the last known position, then sweep. Never stand still: a frozen
      // enemy reads as a bug even when it is correct behaviour.
      if (d > 3) { speedMul = 0.8; }
      else {
        e.searchA = (e.searchA || 0) + sim.dt * 1.4 * e.bias;
        bx = Math.cos(e.searchA); bz = Math.sin(e.searchA);
        speedMul = 0.55;
      }
      break;
    }
    case BEHAVIOR.HUNT: {
      // Memory has run out entirely. It does not know where you are, but it
      // knows roughly where the fight is, so it closes on the flow field at a
      // deliberate pace. This is the difference between an arena that keeps
      // applying pressure and one that goes quiet the moment you break line
      // of sight — without giving anything wallhacks.
      sim.flow.sample(e.x, e.z, scratch);
      if (scratch.x === 0 && scratch.z === 0) {
        e.searchA = (e.searchA || 0) + sim.dt * 1.2 * e.bias;
        bx = Math.cos(e.searchA); bz = Math.sin(e.searchA);
      } else { bx = scratch.x; bz = scratch.z; }
      speedMul = 0.72;
      break;
    }
    default: {
      // ENGAGE — approach, with an orbit bias so a pack does not stack into
      // a single-file queue behind the player.
      const goal = def.ranged && d < def.range ? 0.1 : 1;
      const ox = bx, oz = bz;
      bx = ox * goal - oz * e.bias * 0.26;
      bz = oz * goal + ox * e.bias * 0.26;
      if (def.ranged && d < def.range * 0.9 && d > def.range * 0.6) speedMul = 0.6;
    }
  }

  const l = Math.hypot(bx, bz);
  if (l > 0.001) { out.x = bx / l; out.z = bz / l; }
  else { out.x = 0; out.z = 0; }
  return speedMul;
}

/** Local avoidance: separation from neighbours plus a short whisker cast
 *  against cover. Applied on top of steering, never instead of it. */
export function avoid(e, sim, out) {
  let ax = 0, az = 0;
  const n = sim.hash.query(e.x, e.z, e.r * 2.4 + 2, sim.qbuf);
  for (let i = 0; i < n; i++) {
    const o = sim.qbuf[i];
    if (o === e || !o.alive) continue;
    const ox = e.x - o.x, oz = e.z - o.z;
    const od2 = ox * ox + oz * oz;
    const rr = e.r + (o.r || 0.6);
    if (od2 < rr * rr && od2 > 1e-4) {
      const od = Math.sqrt(od2);
      const push = (rr - od) / rr;
      ax += (ox / od) * push * T.ai.separation;
      az += (oz / od) * push * T.ai.separation;
    }
  }
  // Whisker: if the desired direction runs into cover within a stride, slide.
  const look = T.ai.avoidLookahead * (1 + e.speed * 0.06);
  const px = e.x + out.x * look, pz = e.z + out.z * look;
  const prop = sim.world.hitProp(px, pz, e.r * 0.8);
  if (prop) {
    const wx = px - prop.x, wz = pz - prop.z, wd = Math.hypot(wx, wz) || 1;
    // Tangent, chosen on the side the enemy is already drifting toward.
    const tx = -wz / wd, tz = wx / wd;
    const sign = (tx * out.x + tz * out.z) >= 0 ? 1 : -1;
    ax += tx * sign * 1.6;
    az += tz * sign * 1.6;
  }
  out.x += ax; out.z += az;
  const l = Math.hypot(out.x, out.z);
  if (l > 0.001) { out.x /= l; out.z /= l; }
}
