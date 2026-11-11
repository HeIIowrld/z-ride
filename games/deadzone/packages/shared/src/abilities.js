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

/* ============================== ABILITIES ===============================
   Actives define a build's shape. Each one is a verb the player did not have
   a second ago, with a cooldown short enough to be a rhythm rather than a
   ritual.

   All of them run inside the simulation, so an ability used online resolves
   on the server and every client sees the same result. */

import { TAU, lerp, dist2 } from './math.js';
import { T } from './constants.js';
import { COL } from './defs.js';
import { EV } from './events.js';

export const ABILITIES = [
  {
    id: 'shock', name: 'SHOCKWAVE', icon: '◎', cooldown: 7,
    desc: 'Blast everything away',
    cast(sim, p) {
      const R = 13;
      for (const e of sim.enemies) {
        if (!e.alive || dist2(e.x, e.z, p.x, p.z) > R * R) continue;
        sim.hurtEnemy(e, 55 * p.mods.dmg, p.x, p.z, 34, false, p);
        e.staggerT = 0.5;
      }
      if (sim.mode.pvp) {
        for (const o of sim.players) {
          if (o === p || !o.alive || o.down || o.team === p.team) continue;
          if (dist2(o.x, o.z, p.x, p.z) > R * R) continue;
          sim.damagePlayer(o, 34, p.x, p.z, p);
          const dx = o.x - p.x, dz = o.z - p.z, d = Math.hypot(dx, dz) || 1;
          o.vx += (dx / d) * 26; o.vz += (dz / d) * 26;
        }
      }
      sim.events.push(EV.EXPLODE, { x: p.x, z: p.z, r: R, hostile: 0, ring: 1, c: COL.ice });
    }
  },

  {
    id: 'bubble', name: 'TIME BUBBLE', icon: '◷', cooldown: 13,
    desc: 'Slow everything nearby',
    cast(sim, p) {
      const R = 15, x = p.x, z = p.z;
      sim.addEffect(4.2, () => {
        for (const e of sim.enemies) if (e.alive && dist2(e.x, e.z, x, z) < R * R) e.slowT = 0.25;
        if (sim.mode.pvp) {
          for (const o of sim.players) {
            if (!o.alive || o.team === p.team) continue;
            if (dist2(o.x, o.z, x, z) < R * R) o.slowT = 0.25;
          }
        }
      });
      sim.events.push(EV.ABILITY, { id: p.id, ability: 'bubble', x, z, r: R, dur: 4.2 });
    }
  },

  {
    id: 'blink', name: 'BLINK STRIKE', icon: '⇢', cooldown: 6,
    desc: 'Teleport, cut a line',
    cast(sim, p) {
      const dx = Math.cos(p.aimA), dz = Math.sin(p.aimA), D = 15;
      const sx = p.x, sz = p.z;
      p.x += dx * D; p.z += dz * D;
      sim.world.collide(p, T.player.radius);
      p.iframe = Math.max(p.iframe, 0.3);
      const marked = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const x = lerp(sx, p.x, t), z = lerp(sz, p.z, t);
        for (const e of sim.enemies) {
          if (!e.alive || marked.indexOf(e) >= 0) continue;
          if (dist2(e.x, e.z, x, z) < 7) { marked.push(e); }
        }
      }
      for (const e of marked) sim.hurtEnemy(e, 85 * p.mods.dmg, sx, sz, 12, true, p);
      if (sim.mode.pvp) {
        for (const o of sim.players) {
          if (o === p || !o.alive || o.team === p.team) continue;
          for (let i = 0; i <= 12; i++) {
            const t = i / 12;
            if (dist2(o.x, o.z, lerp(sx, p.x, t), lerp(sz, p.z, t)) < 6) {
              sim.damagePlayer(o, 48, sx, sz, p); break;
            }
          }
        }
      }
      sim.events.push(EV.ABILITY, { id: p.id, ability: 'blink', x: sx, z: sz, tx: p.x, tz: p.z });
    }
  },

  {
    id: 'turret', name: 'TURRET', icon: '⌸', cooldown: 16,
    desc: 'It shoots for you, 14s',
    cast(sim, p) { sim.addTurret(p, p.x, p.z, 14); }
  },

  {
    id: 'chain', name: 'CHAIN BOLT', icon: '⌁', cooldown: 8,
    desc: 'Arcs through 8 enemies',
    cast(sim, p) {
      let x = p.x, z = p.z, hops = 8, dmg = 60 * p.mods.dmg;
      const hit = [], path = [[x, z]];
      while (hops-- > 0) {
        let best = null, bd = 900;
        for (const e of sim.enemies) {
          if (!e.alive || hit.indexOf(e) >= 0) continue;
          const d = dist2(e.x, e.z, x, z);
          if (d < bd) { bd = d; best = e; }
        }
        if (!best) break;
        hit.push(best);
        path.push([best.x, best.z]);
        sim.hurtEnemy(best, dmg, x, z, 6, true, p);
        x = best.x; z = best.z; dmg *= 0.88;
      }
      sim.events.push(EV.ABILITY, { id: p.id, ability: 'chain', path });
    }
  },

  {
    id: 'well', name: 'GRAVITY WELL', icon: '◉', cooldown: 14,
    desc: 'Clump them, then punish',
    cast(sim, p) {
      const gx = p.x + Math.cos(p.aimA) * 12;
      const gz = p.z + Math.sin(p.aimA) * 12;
      sim.addEffect(2.6, (dt) => {
        for (const e of sim.enemies) {
          if (!e.alive) continue;
          const dx = gx - e.x, dz = gz - e.z, d = Math.hypot(dx, dz) || 1;
          if (d > 14) continue;
          e.vx += (dx / d) * 46 * dt;
          e.vz += (dz / d) * 46 * dt;
        }
      }, () => sim.explode(gx, gz, 9, 110 * p.mods.dmg, false, p));
      sim.events.push(EV.ABILITY, { id: p.id, ability: 'well', x: gx, z: gz, dur: 2.6 });
    }
  },

  {
    id: 'ward', name: 'BULWARK', icon: '⊓', cooldown: 15,
    desc: 'A wall only you can shoot through',
    cast(sim, p) {
      // Deploys three short-lived barricades in an arc ahead of the player.
      // The most valuable thing in a firefight is a place to stand.
      const a0 = p.aimA;
      for (let i = -1; i <= 1; i++) {
        const a = a0 + i * 0.42;
        const x = p.x + Math.cos(a) * 5.5, z = p.z + Math.sin(a) * 5.5;
        const prop = sim.world.props.find(q => !q.alive);
        if (!prop) continue;
        prop.alive = true; prop.type = 'crate';
        prop.x = x; prop.z = z; prop.r = 1.1; prop.h = 2.0; prop.rot = a;
        prop.y = -2; prop.targetY = 0; prop.maxHp = 140; prop.hp = 140; prop.temp = 12;
        sim.addEffect(12, () => {}, () => { prop.alive = false; sim.flow.bakeCost(sim.world); });
      }
      sim.flow.bakeCost(sim.world);
      sim.events.push(EV.ABILITY, { id: p.id, ability: 'ward', x: p.x, z: p.z, a: a0 });
    }
  },

  {
    id: 'overdrive', name: 'OVERDRIVE', icon: '⧗', cooldown: 20,
    desc: 'Six seconds of everything',
    cast(sim, p) {
      // The pure dopamine button: fire rate, move speed, and infinite dash
      // charges, for exactly long enough to turn a losing fight around.
      p.mods.rate *= 2.1;
      p.mods.moveSpeed *= 1.3;
      const before = p.dashCharge;
      sim.addEffect(6, () => { p.dashCharge = Math.max(p.dashCharge, 2); }, () => {
        p.mods.rate /= 2.1;
        p.mods.moveSpeed /= 1.3;
        p.dashCharge = Math.min(p.dashCharge, before + 1);
      });
      sim.events.push(EV.ABILITY, { id: p.id, ability: 'overdrive', dur: 6 });
    }
  },

  {
    id: 'mark', name: 'HUNTER MARK', icon: '⊗', cooldown: 11,
    desc: 'Marked targets take double',
    cast(sim, p) {
      const R = 18;
      const marked = [];
      for (const e of sim.enemies) {
        if (!e.alive || dist2(e.x, e.z, p.x, p.z) > R * R) continue;
        e.marked = 6;
        marked.push(e.eid);
      }
      sim.addEffect(6, (dt) => {
        for (const e of sim.enemies) if (e.marked > 0) e.marked -= dt;
      });
      sim.events.push(EV.ABILITY, { id: p.id, ability: 'mark', x: p.x, z: p.z, r: R, marked });
      void TAU;
    }
  }
];

export const ABILITY_BY_ID = Object.fromEntries(ABILITIES.map(a => [a.id, a]));
