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

/* ================================ DIRECTOR ==============================
   There is no authored wave list. There is a credit budget, a composition
   weighting that reacts to what the players have built, and a sawtooth
   intensity curve with a real relief valley after every clear.

   The valley is what makes the next spike land. Never remove it.

   New in the multiplayer build: the director reads the *group*, not one
   player. Four people with four different builds get a wave composed against
   the union of their weaknesses, which is why co-op stays interesting after
   the point where a solo run has settled into a rhythm. */

import { TAU, clamp, damp } from './math.js';
import { T } from './constants.js';
import { ENEMY_TYPES } from './defs.js';
import { EV } from './events.js';

export const MODIFIERS = [
  {
    id: 'blackout', name: 'BLACKOUT', desc: 'Fewer of them. Much louder.',
    apply(d) { d.countMul = 0.55; d.hpMul = 1.7; d.fogBoost = 1; },
    clear(d) { d.countMul = 1; d.hpMul = 1; d.fogBoost = 0; }
  },
  {
    id: 'swarm', name: 'SWARM', desc: 'Everything, all at once.',
    apply(d) { d.countMul = 2.1; d.hpMul = 0.5; },
    clear(d) { d.countMul = 1; d.hpMul = 1; }
  },
  {
    id: 'glass', name: 'GLASS CANNON', desc: 'Triple damage. No shield.',
    apply(d) { for (const p of d.sim.players) p.mods.dmg *= 3; d.noShield = true; },
    clear(d) { for (const p of d.sim.players) p.mods.dmg /= 3; d.noShield = false; }
  },
  {
    id: 'hunt', name: 'ELITE HUNT', desc: 'Only champions remain.',
    apply(d) { d.eliteOnly = true; },
    clear(d) { d.eliteOnly = false; }
  },
  {
    id: 'frenzy', name: 'FRENZY', desc: 'They are faster. So are you.',
    apply(d) { d.speedMul = 1.35; for (const p of d.sim.players) { p.mods.moveSpeed *= 1.25; p.mods.rate *= 1.25; } },
    clear(d) { d.speedMul = 1; for (const p of d.sim.players) { p.mods.moveSpeed /= 1.25; p.mods.rate /= 1.25; } }
  },
  {
    id: 'ambush', name: 'AMBUSH', desc: 'They come from behind.',
    apply(d) { d.ambush = true; d.countMul = 0.85; },
    clear(d) { d.ambush = false; d.countMul = 1; }
  }
];

export class Director {
  constructor(sim) {
    this.sim = sim;
    this.reset();
  }

  reset() {
    this.wave = 0;
    this.credits = 0;
    this.spawnT = 0;
    this.pending = [];
    this.phase = 'idle';
    this.phaseT = 0;
    this.intensity = 0;
    this.countMul = 1; this.hpMul = 1; this.speedMul = 1;
    this.eliteOnly = false; this.noShield = false; this.ambush = false; this.fogBoost = 0;
    this.modifier = null;
    this.challenge = 1;
    this.perfT = 0;
    this.killsThisWave = 0;
    this.spawnedThisWave = 0;
    this.hazardT = 4;
  }

  startWave() {
    const sim = this.sim;
    this.wave++;
    this.killsThisWave = 0;
    this.spawnedThisWave = 0;
    if (this.modifier) { this.modifier.clear(this); this.modifier = null; }

    const isBoss = this.wave % T.director.bossEvery === 0;
    const isMod = !isBoss && this.wave % T.director.modifierEvery === 0;
    if (isMod) { this.modifier = sim.rng.pick(MODIFIERS); this.modifier.apply(this); }

    const headcount = sim.partySize || Math.max(1, sim.players.filter(p => p.connected !== false).length);
    const scale = sim.mode.creditScale(headcount);

    this.credits = (T.director.baseCredits + this.wave * T.director.creditsPerWave)
      * Math.pow(T.director.creditGrowth, this.wave)
      * this.countMul * this.challenge * scale;

    // Teach by doing: the first two waves are deliberately thin so a new
    // player learns movement before the arena starts asking questions.
    if (this.wave === 1) this.credits = 4 * scale;
    else if (this.wave === 2) this.credits = 9 * scale;

    this.phase = 'wave';
    this.spawnT = 0;

    if (isBoss) {
      const a = sim.rng.range(TAU), r = sim.arenaRadius - 8;
      this.queueSpawn('boss', Math.cos(a) * r, Math.sin(a) * r);
      this.credits *= 0.45;
      sim.events.push(EV.BANNER, { a: 'CHAMPION', b: 'WAVE ' + this.wave, big: true });
    } else if (isMod) {
      sim.events.push(EV.BANNER, { a: this.modifier.name, b: this.modifier.desc, mod: 1 });
    } else {
      sim.events.push(EV.BANNER, { a: 'WAVE ' + this.wave, b: this.wave === 1 ? 'MOVE. SHOOT. SURVIVE.' : '' });
    }
    sim.events.push(EV.WAVE, { wave: this.wave, modifier: this.modifier ? this.modifier.id : null });

    sim.world.layout(this.wave, false);
    sim.world.rise();
    sim.flow.bakeCost(sim.world);
  }

  /** Composition weights shift with what the party has built, so the game
   *  keeps asking new questions instead of repeating one louder. */
  weights() {
    const w = this.wave;
    const sim = this.sim;

    // Aggregate the party's build. A group carrying heavy AoE gets spread-out
    // ranged pressure; a group built for single targets gets swarmed.
    let aoe = 0, single = 0, mobility = 0;
    for (const p of sim.players) {
      const m = p.mods;
      aoe += m.explosive + (m.split ? 20 : 0) + m.bounces * 10;
      single += m.crit * 100 + m.pierce * 12;
      mobility += m.dashExtra * 20 + (m.moveSpeed - 1) * 60;
    }
    const n = Math.max(1, sim.players.length);
    aoe /= n; single /= n; mobility /= n;

    const t = {
      rusher:   10 + Math.max(0, 10 - w),
      bruiser:  w >= 3 ? 3 + w * 0.25 : 0,
      spitter:  w >= 2 ? 3 + w * 0.40 : 0,
      splitter: w >= 4 ? 2.5 + w * 0.22 : 0,
      stalker:  w >= 5 ? 1.6 + w * 0.20 : 0,
      sapper:   w >= 7 ? 1.2 + w * 0.16 : 0,
      warden:   w >= 8 ? 1.0 + w * 0.14 : 0,
      elite:    w >= 6 ? 0.6 + w * 0.09 : 0
    };

    if (aoe > single) { t.spitter *= 1.7; t.bruiser *= 1.2; t.rusher *= 0.75; t.warden *= 1.4; }
    else { t.rusher *= 1.35; t.splitter *= 1.3; t.stalker *= 1.2; }
    // Very mobile parties get things that punish standing still less and
    // predicting badly more.
    if (mobility > 25) { t.sapper *= 1.5; t.stalker *= 1.4; }

    if (this.eliteOnly) return { elite: 1 };
    return t;
  }

  roll() {
    const t = this.weights();
    let total = 0;
    for (const k in t) total += t[k];
    let r = this.sim.rng.f() * total;
    for (const k in t) { r -= t[k]; if (r <= 0) return k; }
    return 'rusher';
  }

  /** Spawns arrive from the periphery, never inside your shoulder, and always
   *  with a telegraph you can react to. In co-op the check runs against every
   *  player, so nothing materialises behind the person who is reviving. */
  spawnPoint() {
    const sim = this.sim;
    const R = sim.shrinkRadius - 3.5;
    let bx = 0, bz = 0, bestScore = -1e9;

    for (let i = 0; i < 10; i++) {
      const a = sim.rng.range(TAU);
      const x = Math.cos(a) * R, z = Math.sin(a) * R;

      let minD = Infinity, facingPenalty = 0;
      for (const p of sim.players) {
        if (!p.alive || p.down) continue;
        const dx = x - p.x, dz = z - p.z;
        const d = Math.hypot(dx, dz);
        if (d < minD) minD = d;
        const inFront = (dx / d) * Math.cos(p.aimA) + (dz / d) * Math.sin(p.aimA);
        facingPenalty = Math.max(facingPenalty, inFront);
      }
      if (minD < T.director.safeSpawnDist) continue;

      // AMBUSH inverts the rule on purpose, and announces itself when it does.
      const front = this.ambush ? -facingPenalty : facingPenalty;
      const score = minD * 0.1 - front * 6 + sim.rng.range(2);
      if (score > bestScore) { bestScore = score; bx = x; bz = z; }
    }

    if (bestScore === -1e9) {
      const a = sim.rng.range(TAU);
      bx = Math.cos(a) * R; bz = Math.sin(a) * R;
    }
    return { x: bx, z: bz };
  }

  queueSpawn(key, x, z) {
    this.pending.push({ key, x, z, t: T.director.warnTime });
    this.sim.events.push(EV.TELEGRAPH, { kind: 'spawn', x, z, d: T.director.warnTime, key });
  }

  onKill() { this.killsThisWave++; }

  step(dt) {
    const sim = this.sim;

    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      p.t -= dt;
      if (p.t <= 0) { sim.spawnEnemy(p.key, p.x, p.z); this.pending.splice(i, 1); }
    }

    if (sim.mode.waves) this.stepWaves(dt);
    else if (sim.mode.hazards) this.stepHazards(dt);

    // Rolling read of how the party is coping -> a gentle challenge multiplier.
    this.perfT += dt;
    if (this.perfT > 5) {
      this.perfT = 0;
      let acc = 0, healthy = 0, n = 0;
      for (const p of sim.players) {
        if (p.bot) continue;
        acc += p.shotsFired > 20 ? Math.min(1, p.shotsHit / p.shotsFired) : 0.5;
        healthy += (p.hp + p.shield) / (p.maxHp + p.maxShield + p.mods.shieldBonus);
        n++;
      }
      if (n) {
        acc /= n; healthy /= n;
        const target = clamp(0.85 + acc * 0.3 + healthy * 0.25, 0.8, 1.35);
        this.challenge = damp(this.challenge, target, 0.5, 5);
      }
    }
  }

  stepWaves(dt) {
    const sim = this.sim;
    if (this.phase === 'wave') {
      const alive = sim.aliveEnemies;
      const capAlive = Math.min(160, 26 + this.wave * 2.4 + sim.players.length * 8);
      this.spawnT -= dt;
      if (this.credits > 0 && this.spawnT <= 0 && alive < capAlive) {
        const key = this.roll();
        const cost = ENEMY_TYPES[key].credits;
        const pt = this.spawnPoint();
        this.queueSpawn(key, pt.x, pt.z);
        this.credits -= cost;
        this.spawnedThisWave++;
        // Bursts, not a metronome: a cluster then a pause reads as an assault.
        this.spawnT = T.director.spawnRate / clamp(0.6 + this.wave * 0.05, 0.6, 2.6) * sim.rng.range(1.5, 0.35);
      }
      this.intensity = clamp(
        (alive / capAlive) * 0.7 + (1 - Math.max(0, this.credits) / (this.credits + 40)) * 0.3, 0, 1
      );
      if (this.credits <= 0 && alive === 0 && this.pending.length === 0) {
        this.phase = 'valley';
        this.phaseT = T.director.valleyTime;
        sim.events.push(EV.BANNER, { a: 'CLEAR', b: 'WAVE ' + this.wave + ' DOWN', clear: 1 });
      }
    } else if (this.phase === 'valley') {
      this.intensity = damp(this.intensity, 0.05, 3, dt);
      this.phaseT -= dt;
      if (this.phaseT <= 0) {
        this.phase = 'choice';
        sim.world.sink();
        sim.events.push(EV.WAVE, { wave: this.wave, choice: true });
      }
    }
  }

  /** PvP keeps a thin PvE presence: neutral hazards that punish camping and
   *  give the arena something to do while two squads circle each other. */
  stepHazards(dt) {
    const sim = this.sim;
    this.hazardT -= dt;
    this.intensity = clamp(sim.aliveEnemies / 12, 0, 1) * 0.6 + 0.2;
    if (this.hazardT > 0) return;
    this.hazardT = sim.rng.range(16, 9);
    if (sim.aliveEnemies > 10) return;

    const burst = 2 + sim.rng.int(3);
    for (let i = 0; i < burst; i++) {
      const pt = this.spawnPoint();
      this.queueSpawn(sim.rng.f() < 0.25 ? 'spitter' : 'rusher', pt.x, pt.z);
    }
    // Something worth fighting over, dropped where both teams can see it.
    const a = sim.rng.range(TAU), r = sim.rng.range(sim.shrinkRadius * 0.4, 4);
    sim.addPickup('surge', Math.cos(a) * r, Math.sin(a) * r, 0);
  }
}
