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

/* ================================ WORLD =================================
   The arena: a bounded disc with regenerating cover.

   Layout is a pure function of (seed, waveIndex). That matters more than it
   looks: it means a client that joins mid-match, or reconnects after a
   dropout, rebuilds the identical arena without the server shipping a single
   byte of geometry.

   Collision is kinematic circle push-out, never solver-driven. The player is
   always exactly where the simulation says they are. */

import { TAU, dist2, damp } from './math.js';
import { makeRng } from './rng.js';
import { T } from './constants.js';

export const PROP_TYPES = {
  block:   { minR: 1.2, maxR: 2.2, minH: 1.4, maxH: 3.4, cover: true },
  pillar:  { minR: 0.9, maxR: 1.5, minH: 2.6, maxH: 6.0, cover: true },
  crate:   { minR: 0.8, maxR: 1.3, minH: 0.9, maxH: 1.6, cover: true, breakable: true },
  ramp:    { minR: 1.8, maxR: 2.8, minH: 0.6, maxH: 1.1, cover: false }
};

export class World {
  constructor(seed = 1, opts = {}) {
    this.seed = seed >>> 0;
    this.radius = opts.radius ?? T.arena.radius;
    this.propCount = opts.propCount ?? T.arena.propCount;
    this.symmetric = !!opts.symmetric;   // PvP arenas mirror, so no team gets the good side
    this.props = [];
    for (let i = 0; i < this.propCount; i++) {
      this.props.push({
        i, type: 'block', x: 0, z: 0, r: 1, h: 1, rot: 0,
        y: 0, targetY: 0, hp: 0, maxHp: 0, alive: true
      });
    }
    this.layout(0, true);
  }

  /** Rebuild cover for a wave. `instant` skips the rise-from-the-floor animation.
   *  Regenerating between waves is the single biggest defence against an arena
   *  feeling memorised by wave 12. */
  layout(waveIndex = 0, instant = false) {
    const rng = makeRng((this.seed ^ (waveIndex * 0x9E3779B1)) >>> 0);
    const R = this.radius;
    const half = this.symmetric ? Math.ceil(this.props.length / 2) : this.props.length;

    for (let i = 0; i < half; i++) {
      const p = this.props[i];
      const kind = rng.f() < 0.18 ? 'ramp' : rng.f() < 0.32 ? 'crate' : rng.f() < 0.62 ? 'pillar' : 'block';
      const spec = PROP_TYPES[kind];
      p.type = kind;
      p.r = rng.range(spec.maxR, spec.minR);
      p.h = rng.range(spec.maxH, spec.minH);
      p.rot = rng.range(TAU);
      p.alive = true;
      p.maxHp = spec.breakable ? 60 : 0;
      p.hp = p.maxHp;

      let ok = false, tries = 0;
      while (!ok && tries++ < 48) {
        const a = rng.range(TAU);
        // Bias placement outward: a clear centre keeps the opening seconds legible.
        const d = rng.range(R - 6, this.symmetric ? 6 : 9);
        p.x = Math.cos(a) * d;
        p.z = Math.sin(a) * d;
        ok = dist2(p.x, p.z, 0, 0) > 49;
        if (ok) {
          for (let j = 0; j < i; j++) {
            const q = this.props[j];
            const need = (p.r + q.r + 2.2) ** 2;
            if (dist2(p.x, p.z, q.x, q.z) < need) { ok = false; break; }
          }
        }
      }
      p.targetY = 0;
      p.y = instant ? 0 : -p.h - 1;
    }

    // Mirror the second half through the origin so PvP spawns are fair.
    if (this.symmetric) {
      for (let i = half; i < this.props.length; i++) {
        const src = this.props[i - half], p = this.props[i];
        Object.assign(p, src, { i, x: -src.x, z: -src.z, rot: src.rot + Math.PI });
        p.y = instant ? 0 : -p.h - 1;
        p.targetY = 0;
      }
    }
  }

  sink() { for (const p of this.props) p.targetY = -p.h - 1; }
  rise() { for (const p of this.props) p.targetY = 0; }

  /** Cover animates independently of the simulation — safe to call at frame rate. */
  animate(dt) {
    for (const p of this.props) p.y = damp(p.y, p.targetY, 4.5, dt);
  }

  /** True while a prop is tall enough to block anything. */
  _solid(p) { return p.alive && p.y > -0.3; }

  /** Circle-vs-circle push-out against props and the arena wall.
   *  Returns true if the wall was the thing that stopped you. */
  collide(o, radius) {
    for (const p of this.props) {
      if (!this._solid(p)) continue;
      const rr = p.r + radius;
      const dx = o.x - p.x, dz = o.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2), push = (rr - d) / d;
        o.x += dx * push;
        o.z += dz * push;
      }
    }
    const d2c = o.x * o.x + o.z * o.z;
    const lim = this.radius - radius;
    if (d2c > lim * lim) {
      const d = Math.sqrt(d2c) || 1;
      o.x = (o.x / d) * lim;
      o.z = (o.z / d) * lim;
      return true;
    }
    return false;
  }

  /** First prop overlapping a circle. Used by projectiles. */
  hitProp(x, z, r) {
    for (const p of this.props) {
      if (!this._solid(p)) continue;
      const rr = p.r + r;
      if (dist2(x, z, p.x, p.z) < rr * rr) return p;
    }
    return null;
  }

  /** Line of sight, sampled. Cheap, and at these scales indistinguishable
   *  from an exact circle sweep. Cover only blocks if it is tall enough to
   *  hide a body — a knee-high ramp never gives false negatives. */
  lineOfSight(ax, az, bx, bz, minHeight = 1.2) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 0.001) return true;
    const steps = Math.min(28, Math.max(3, Math.ceil(len / 1.6)));
    for (const p of this.props) {
      if (!this._solid(p) || p.h < minHeight) continue;
      // Segment-circle rejection before sampling — most props exit here.
      const t = ((p.x - ax) * dx + (p.z - az) * dz) / (len * len);
      if (t < -0.1 || t > 1.1) continue;
      const cx = ax + dx * Math.max(0, Math.min(1, t)) - p.x;
      const cz = az + dz * Math.max(0, Math.min(1, t)) - p.z;
      if (cx * cx + cz * cz < p.r * p.r) return false;
    }
    void steps;
    return true;
  }

  damageProp(p, amount) {
    if (!p.maxHp || !p.alive) return false;
    p.hp -= amount;
    if (p.hp <= 0) { p.alive = false; return true; }
    return false;
  }

  /** Serialised layout, for a client that wants to verify rather than trust. */
  snapshot() {
    return this.props.map(p => [p.type, +p.x.toFixed(2), +p.z.toFixed(2), +p.r.toFixed(2), +p.h.toFixed(2), +p.rot.toFixed(2), p.alive ? 1 : 0]);
  }
}
