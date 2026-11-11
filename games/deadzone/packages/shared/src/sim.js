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

/* ============================ THE SIMULATION ============================

   One class, no rendering, no audio, no DOM. It runs identically in three
   places:

     • the browser, at 60Hz, when you are playing offline or in co-op;
     • the browser again, predicting only your own player, when you are online;
     • a Cloudflare Durable Object at 20Hz, where it is the sole authority on
       what actually happened.

   Everything it wants to tell the outside world goes through `events`.
   Everything the outside world tells it goes through `setInput`.               */

import { TAU, clamp, lerp, damp, dist2, angleDelta, segPointDist2 } from './math.js';
import { makeRng } from './rng.js';
import { T } from './constants.js';
import { COL, WEAPONS, ENEMY_TYPES, knockScale, armorMultiplier } from './defs.js';
import { SpatialHash } from './spatialHash.js';
import { World } from './world.js';
import { EV, EventQueue } from './events.js';
import { getMode, teamSpawn, balanceTeams } from './modes.js';
import { FlowField, ROLE, BEHAVIOR, perceive, shareIntel, assignRoles, chooseBehavior, steer, avoid } from './ai.js';
import { Director } from './director.js';
import { VehicleDefense } from './vehicle-defense.js';
import { ABILITIES, ABILITY_BY_ID } from './abilities.js';
import { UPGRADES, UPGRADE_BY_ID, freshMods } from './upgrades.js';

let ENTITY_SEQ = 1;

const steerOut = { x: 0, z: 0 };

export class Sim {
  constructor(opts = {}) {
    this.seed = (opts.seed ?? 12345) >>> 0;
    this.rng = makeRng(this.seed);
    this.fxRng = makeRng(this.seed ^ 0xA5A5A5);   // cosmetic rolls, never gameplay
    this.mode = getMode(opts.mode || 'coop');
    this.partySize = opts.partySize || null;
    this.authoritative = opts.authoritative !== false;

    const pvp = this.mode.pvp;
    this.arenaRadius = opts.radius ?? (pvp ? T.arena.pvpRadius : T.arena.radius);
    this.world = new World(this.seed, {
      radius: this.arenaRadius,
      propCount: pvp ? T.arena.pvpPropCount : T.arena.propCount,
      symmetric: this.mode.symmetricArena,
      vehicleDefense: !!opts.vehicleDefense && !pvp
    });

    this.hash = new SpatialHash(4.2);
    this.qbuf = new Array(320);
    this.flow = new FlowField(this.arenaRadius);
    this.flow.bakeCost(this.world);

    this.events = new EventQueue();
    this.players = [];
    this.playerMap = new Map();
    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];
    this.turrets = [];
    this.effects = [];

    this.enemyCap = opts.enemyCap ?? (pvp ? 90 : 260);
    this.projCap = 700;
    this.pickupCap = 160;

    for (let i = 0; i < this.enemyCap; i++) this.enemies.push(blankEnemy());
    for (let i = 0; i < this.projCap; i++) this.projectiles.push(blankProjectile());
    for (let i = 0; i < this.pickupCap; i++) this.pickups.push(blankPickup());
    for (let i = 0; i < 12; i++) this.turrets.push({ alive: false, id: 0, owner: 0, x: 0, z: 0, a: 0, t: 0, life: 0, cd: 0 });

    this.director = new Director(this);
    this.defense = this.world.vehicleDefense && this.authoritative ? new VehicleDefense(this.arenaRadius) : null;
    this.teamScore = new Array(this.mode.teams).fill(0);

    this.tick = 0;
    this.time = 0;
    this.matchTime = 0;
    this.dt = 1 / T.sim.hz;
    this.aliveEnemies = 0;
    this.over = null;
    this.shrinkRadius = this.arenaRadius;

    this._roleT = 0;
    this._flowT = 0;
    this.costDirty = false;
    this._projTag = 1;
  }

  /* ------------------------------------------------------------- PLAYERS */

  addPlayer(id, opts = {}) {
    let p = this.playerMap.get(id);
    if (p) { p.connected = true; return p; }
    p = {
      id, name: opts.name || 'RUNNER', bot: !!opts.bot, connected: true,
      team: opts.team ?? 0, skin: opts.skin ?? 0,
      x: 0, z: 0, px: 0, pz: 0, vx: 0, vz: 0,
      // Impulse velocity, integrated and drained separately from locomotion.
      ivx: 0, ivz: 0,
      aimA: 0, faceA: 0, moveA: 0,
      bloom: 0,             // accumulated fire inaccuracy, in radians
      hp: T.player.hp, maxHp: T.player.hp,
      shield: T.player.shield, maxShield: T.player.shield, shieldT: 0,
      iframe: 0, protectT: 0,
      dashT: 0, dashDirX: 0, dashDirZ: 0, dashCharge: T.dash.charges, dashTimer: 0,
      weapon: 0, unlocked: [0], cooldown: 0, chargeT: 0, recoil: 0, loudT: 0,
      combo: 0, comboT: 0, streak: 0,
      alive: true, down: false, downT: 0, reviveT: 0, respawnT: 0,
      kills: 0, deaths: 0, assists: 0, score: 0, damageDealt: 0, damageTaken: 0,
      shotsFired: 0, shotsHit: 0,
      abilities: [null, null],
      mods: freshMods(),
      taken: {},
      input: freshInput(),
      lastSeq: 0,
      burnT: 0, slowT: 0,
      isPlayer: true, r: T.player.radius
    };
    this.players.push(p);
    this.playerMap.set(id, p);
    this.spawnPlayer(p, true);
    return p;
  }

  removePlayer(id) {
    const p = this.playerMap.get(id);
    if (!p) return;
    this.playerMap.delete(id);
    const i = this.players.indexOf(p);
    if (i >= 0) this.players.splice(i, 1);
  }

  playerById(id) { return this.playerMap.get(id); }

  rebalanceTeams() {
    if (this.mode.teams <= 1) { for (const p of this.players) p.team = 0; return; }
    const map = balanceTeams(this.players.map(p => p.id), this.mode);
    for (const p of this.players) p.team = map.get(p.id) ?? 0;
  }

  spawnPlayer(p, initial = false) {
    if (this.mode.pvp) {
      const anchor = teamSpawn(p.team, this.mode.teams, this.arenaRadius, this.rng);
      // Nudge apart within the team so duo partners do not stack.
      const j = this.rng.range(TAU);
      p.x = anchor.x + Math.cos(j) * this.rng.range(4.5, 1);
      p.z = anchor.z + Math.sin(j) * this.rng.range(4.5, 1);
      p.aimA = p.faceA = anchor.facing;
      p.protectT = T.player.spawnProtect;
    } else {
      const a = this.rng.range(TAU);
      const d = initial && this.world.vehicleDefense ? this.rng.range(5.5, 4)
        : initial ? this.rng.range(4, 0) : this.rng.range(8, 3);
      p.x = Math.cos(a) * d;
      p.z = Math.sin(a) * d;
      p.aimA = p.faceA = -Math.PI / 2;
    }
    this.world.collide(p, T.player.radius);
    p.px = p.x; p.pz = p.z;
    p.vx = p.vz = 0;
    p.ivx = p.ivz = 0;
    p.bloom = 0;
    p.hp = p.maxHp;
    p.shield = p.maxShield + p.mods.shieldBonus;
    p.alive = true; p.down = false; p.downT = 0; p.reviveT = 0;
    p.dashCharge = T.dash.charges + p.mods.dashExtra;
    p.iframe = 0.4;
    if (!initial) this.events.push(EV.RESPAWN, { id: p.id, x: p.x, z: p.z });
  }

  setInput(id, input) {
    const p = this.playerMap.get(id);
    if (!p) return;
    if (input.seq !== undefined && input.seq <= p.lastSeq) return;   // stale or replayed
    if (input.seq !== undefined) p.lastSeq = input.seq;
    const i = p.input;
    i.mx = clamp(input.mx || 0, -1, 1);
    i.mz = clamp(input.mz || 0, -1, 1);
    const al = Math.hypot(input.ax || 1, input.az || 0) || 1;
    i.ax = (input.ax ?? 1) / al;
    i.az = (input.az ?? 0) / al;
    i.fire = !!input.fire;
    i.dash = !!input.dash;
    i.ab0 = !!input.ab0;
    i.ab1 = !!input.ab1;
    if (input.weapon !== undefined && input.weapon !== i.weapon) {
      i.weapon = input.weapon;
      this.selectWeapon(p, input.weapon);
    }
  }

  selectWeapon(p, index) {
    if (index < 0 || index >= WEAPONS.length) return;
    if (p.unlocked.indexOf(index) < 0 || index === p.weapon) return;
    p.weapon = index;
    p.chargeT = 0;
    p.cooldown = 0.12;
  }

  unlockWeapon(p, index) {
    if (p.unlocked.indexOf(index) < 0) { p.unlocked.push(index); this.selectWeapon(p, index); }
  }

  /* ---------------------------------------------------------------- STEP */

  step(dt) {
    this.dt = dt;
    this.tick++;
    this.time += dt;
    if (!this.over) this.matchTime += dt;

    // Rebuild the broad phase once, up front. Everything downstream reads it.
    this.hash.clear();
    this.aliveEnemies = 0;
    for (const e of this.enemies) if (e.alive) { this.hash.insert(e); this.aliveEnemies++; }
    for (const p of this.players) if (p.alive && !p.down) this.hash.insert(p);

    // Flow field: three rebuilds a second is imperceptible and nearly free.
    // Cover only changes when something breaks it. Rebaking is batched to at
    // most once per tick so a shotgun that shatters four crates in one frame
    // does not rebuild the navigation grid four times.
    if (this.costDirty) {
      this.costDirty = false;
      this.flow.bakeCost(this.world);
      this.defense?.rebuildPath(this.world);
    }

    this._flowT -= dt;
    if (this._flowT <= 0) {
      this._flowT = T.ai.gridRebuild;
      const targets = this.players.filter(p => p.alive && !p.down);
      if (targets.length) this.flow.build(targets);
    }

    this._roleT -= dt;
    if (this._roleT <= 0) {
      this._roleT = T.ai.roleRethink;
      shareIntel(this);
      assignRoles(this);
    }

    for (const p of this.players) this.stepPlayer(p, dt);
    this.stepEnemies(dt);
    this.stepProjectiles(dt);
    this.stepTurrets(dt);
    this.stepPickups(dt);
    this.defense?.step(this, dt);
    this.director.step(dt);
    this.stepShrink(dt);
    this.stepEffects(dt);

    if (!this.over) {
      const end = this.defense?.result(this.director) || this.mode.endCondition(this);
      if (end) {
        this.over = end;
        this.events.push(EV.MATCH_END, end);
      }
    }
  }

  stepEffects(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.t -= dt;
      e.fn(dt, 1 - e.t / e.max, this);
      if (e.t <= 0) { if (e.onEnd) e.onEnd(this); this.effects.splice(i, 1); }
    }
  }

  addEffect(duration, fn, onEnd) {
    this.effects.push({ t: duration, max: duration, fn, onEnd });
  }

  /** Squad Royale's closing ring. Damage is generous but relentless: the ring
   *  should move you, not kill you. */
  stepShrink(dt) {
    const s = this.mode.shrink;
    if (!s || !this.mode.timeLimit) { this.shrinkRadius = this.arenaRadius; return; }
    const f = this.matchTime / this.mode.timeLimit;
    if (f < s.startFrac) { this.shrinkRadius = this.arenaRadius; return; }
    const k = clamp((f - s.startFrac) / (1 - s.startFrac), 0, 1);
    this.shrinkRadius = lerp(this.arenaRadius, this.arenaRadius * s.endRadiusFrac, k);
    for (const p of this.players) {
      if (!p.alive || p.down) continue;
      const d = Math.hypot(p.x, p.z);
      if (d > this.shrinkRadius) this.damagePlayer(p, s.dps * dt, 0, 0, null, true);
    }
  }

  /* -------------------------------------------------------------- PLAYER */

  stepPlayer(p, dt) {
    p.px = p.x; p.pz = p.z;

    if (!p.alive) {
      if (this.mode.respawn) {
        p.respawnT -= dt;
        if (p.respawnT <= 0) this.spawnPlayer(p);
      }
      return;
    }

    if (p.down) {
      p.downT -= dt;
      p.vx *= 0.85; p.vz *= 0.85;
      p.x += p.vx * dt; p.z += p.vz * dt;
      // Bleed-out, unless someone is standing over you.
      let reviver = null;
      for (const o of this.players) {
        if (o === p || !o.alive || o.down) continue;
        if (this.mode.pvp && o.team !== p.team) continue;
        if (dist2(o.x, o.z, p.x, p.z) < this.mode.reviveRadius ** 2) { reviver = o; break; }
      }
      if (reviver) {
        p.reviveT += dt;
        if (p.reviveT >= this.mode.reviveTime) {
          p.down = false; p.reviveT = 0;
          p.hp = p.maxHp * 0.55;
          p.shield = 0; p.iframe = 1.2;
          reviver.score += 60;
          this.events.push(EV.REVIVE, { id: p.id, by: reviver.id, x: p.x, z: p.z });
        }
      } else {
        p.reviveT = Math.max(0, p.reviveT - dt * 0.6);
      }
      if (p.downT <= 0) this.killPlayer(p, null);
      return;
    }

    const m = p.mods;
    const inp = p.input;
    p.loudT = Math.max(0, p.loudT - dt);
    p.protectT = Math.max(0, p.protectT - dt);
    p.slowT = Math.max(0, p.slowT - dt);

    // Burn damage over time — TORCH and the sapper both leave it behind.
    if (p.burnT > 0) {
      p.burnT -= dt;
      this.damagePlayer(p, 9 * dt, p.x, p.z, null, true);
    }

    /* --- movement -------------------------------------------------------
       Friction every frame, then acceleration along the input direction only.
       See T.player for why this shape and not lerp-to-target. */
    const slowK = p.slowT > 0 ? 0.62 : 1;
    const speed = T.player.speed * m.moveSpeed * slowK;

    if (p.dashT > 0) {
      p.dashT -= dt;
      // Front-loaded so the dash leaves hard and eases out.
      const k = Math.max(0, p.dashT / T.dash.time);
      const burst = T.dash.speed * (T.dash.frontLoad - (T.dash.frontLoad - 1) * (1 - k) * 2);
      const dashSpeed = Math.max(T.dash.speed * 0.45, burst);
      p.x += p.dashDirX * dashSpeed * dt;
      p.z += p.dashDirZ * dashSpeed * dt;
      // Leave with momentum rather than stopping dead when the dash expires.
      p.vx = p.dashDirX * speed * T.dash.exitSpeed;
      p.vz = p.dashDirZ * speed * T.dash.exitSpeed;
      if (m.dashTrail > 0) {
        const n = this.hash.query(p.x, p.z, 3.4, this.qbuf);
        for (let i = 0; i < n; i++) {
          const e = this.qbuf[i];
          if (e.isEnemy && e.alive && dist2(e.x, e.z, p.x, p.z) < 10) {
            this.hurtEnemy(e, m.dashTrail * 60 * dt, p.x, p.z, 0, false, p);
          }
        }
      }
    } else {
      // Friction, with a floor near zero so the last of the drift snaps off.
      const sp = Math.hypot(p.vx, p.vz);
      if (sp > 0) {
        const ref = sp < T.player.stopSpeed ? T.player.stopSpeed : sp;
        const keep = Math.max(0, sp - ref * T.player.friction * dt) / sp;
        p.vx *= keep; p.vz *= keep;
      }
      // Accelerate only along the wish direction, and only up to the amount
      // still missing from wish speed. This is what makes a reversal cost
      // something while a standing start still bites immediately.
      const wish = Math.min(1, Math.hypot(inp.mx, inp.mz));
      if (wish > 1e-4) {
        const nx = inp.mx / (wish || 1), nz = inp.mz / (wish || 1);
        const wishSpeed = speed * wish;
        const cur = p.vx * nx + p.vz * nz;
        const add = Math.min(wishSpeed - cur, T.player.accel * m.moveSpeed * dt);
        if (add > 0) { p.vx += nx * add; p.vz += nz * add; }
      }
      // Safety clamp: locomotion alone can never exceed top speed, whatever
      // the tuning does. Impulses live outside this on purpose.
      const sp2 = Math.hypot(p.vx, p.vz);
      if (sp2 > speed) { p.vx = (p.vx / sp2) * speed; p.vz = (p.vz / sp2) * speed; }
      p.x += p.vx * dt; p.z += p.vz * dt;
    }

    // Impulse channel: recoil, knockback, blasts. Unclamped, self-draining.
    if (p.ivx !== 0 || p.ivz !== 0) {
      p.x += p.ivx * dt; p.z += p.ivz * dt;
      const k = Math.max(0, 1 - T.player.impulseDrag * dt);
      p.ivx *= k; p.ivz *= k;
      if (Math.abs(p.ivx) < 0.02) p.ivx = 0;
      if (Math.abs(p.ivz) < 0.02) p.ivz = 0;
    }

    this.world.collide(p, T.player.radius);

    // Aim. Assist is applied client-side before the input is sent, so the
    // server never has to guess what the player meant.
    p.aimA = Math.atan2(inp.az, inp.ax);
    // The body swings toward the aim at a finite rate. Shots always leave
    // along aimA, so this costs the player no accuracy — it only stops the
    // character reading as a weightless cursor.
    p.faceA += angleDelta(p.faceA, p.aimA) * Math.min(1, T.player.turnRate * dt);
    if (Math.hypot(p.vx, p.vz) > 0.5) p.moveA = Math.atan2(p.vz, p.vx);

    // Weapon bloom recovers whenever it is not being fed by fire.
    if (p.bloom > 0) p.bloom = Math.max(0, p.bloom - T.gun.bloomRecover * dt);

    // --- shield regen ---
    p.shieldT = Math.max(0, p.shieldT - dt);
    const maxSh = p.maxShield + m.shieldBonus;
    if (this.director.noShield) p.shield = 0;
    else if (p.shieldT <= 0 && p.shield < maxSh) {
      p.shield = Math.min(maxSh, p.shield + T.player.shieldRate * dt);
    }
    p.iframe = Math.max(0, p.iframe - dt);

    // --- dash charges ---
    const maxCharges = T.dash.charges + m.dashExtra;
    if (p.dashCharge < maxCharges) {
      p.dashTimer += dt;
      if (p.dashTimer >= T.dash.recharge) { p.dashTimer = 0; p.dashCharge++; }
    } else p.dashTimer = 0;

    if (inp.dash) { inp.dash = false; this.tryDash(p); }
    if (inp.ab0) { inp.ab0 = false; this.useAbility(p, 0); }
    if (inp.ab1) { inp.ab1 = false; this.useAbility(p, 1); }

    // --- combo decay ---
    if (p.comboT > 0) { p.comboT -= dt; if (p.comboT <= 0) { p.combo = 0; } }

    for (const a of p.abilities) if (a && a.cd > 0) a.cd = Math.max(0, a.cd - dt);

    // --- slow aura passive ---
    if (m.slowAura > 0) {
      const ar2 = m.slowAura * m.slowAura;
      const n = this.hash.query(p.x, p.z, m.slowAura, this.qbuf);
      for (let i = 0; i < n; i++) {
        const e = this.qbuf[i];
        if (e.isEnemy && e.alive && dist2(e.x, e.z, p.x, p.z) < ar2) e.slowT = Math.max(e.slowT, 0.2);
      }
    }

    this.firePlayer(p, dt);
    p.recoil = damp(p.recoil, 0, 14, dt);
  }

  tryDash(p) {
    if (!p.alive || p.down || p.dashCharge < 1 || p.dashT > 0) return;
    p.dashCharge--;
    let dx = p.input.mx, dz = p.input.mz;
    if (Math.hypot(dx, dz) < 0.15) { dx = Math.cos(p.aimA); dz = Math.sin(p.aimA); }
    const l = Math.hypot(dx, dz) || 1;
    p.dashDirX = dx / l; p.dashDirZ = dz / l;
    p.dashT = T.dash.time;
    p.iframe = Math.max(p.iframe, T.dash.iframes);
    this.events.push(EV.DASH, { id: p.id, x: p.x, z: p.z, dx: p.dashDirX, dz: p.dashDirZ });
  }

  useAbility(p, slot) {
    const a = p.abilities[slot];
    if (!a || a.cd > 0 || !p.alive || p.down) return;
    a.cd = a.def.cooldown;
    a.def.cast(this, p);
    this.events.push(EV.ABILITY, { id: p.id, ability: a.def.id, x: p.x, z: p.z, a: p.aimA });
  }

  firePlayer(p, dt) {
    const w = WEAPONS[p.weapon];
    const m = p.mods;
    p.cooldown -= dt;
    if (!p.input.fire) { if (p.chargeT > 0) p.chargeT = 0; return; }
    if (p.protectT > 0) p.protectT = 0;   // shooting drops spawn protection

    if (w.charge) {
      if (p.cooldown > 0) return;
      const before = p.chargeT;
      p.chargeT += dt;
      if (before === 0) this.events.push(EV.TELEGRAPH, { kind: 'charge', id: p.id, x: p.x, z: p.z, d: w.charge });
      if (p.chargeT < w.charge) return;
      p.chargeT = 0;
    }
    if (p.cooldown > 0) return;

    const comboRate = 1 + Math.min(p.combo, T.combo.maxRung * 2) * T.combo.fireRateBonus * m.comboRamp;
    p.cooldown = w.rate / (m.rate * comboRate);
    p.shotsFired += w.pellets;
    p.loudT = 0.5;   // gunfire is a perception event for every enemy nearby

    const mx = p.x + Math.cos(p.aimA) * 1.15;
    const mz = p.z + Math.sin(p.aimA) * 1.15;

    /* Bloom. The cone opens while the trigger is held and closes when it is
       not, so holding fire across a room is a choice with a price and tapping
       is always the accurate option. A weapon with no base spread — the rail —
       stays exact: opening a cone on a precision weapon just feels broken. */
    const bloom = w.spread > 0 ? Math.min(p.bloom, w.spread * (T.gun.bloomMax - 1)) : 0;
    const cone = (w.spread + bloom) * m.spread;

    for (let i = 0; i < w.pellets; i++) {
      const a = p.aimA + (cone > 0 ? this.rng.range(cone, -cone) : 0);
      this.spawnProjectile({
        x: mx, z: mz,
        vx: Math.cos(a) * w.speed * m.projSpeed,
        vz: Math.sin(a) * w.speed * m.projSpeed,
        def: w, owner: p, hostile: false
      });
    }
    if (w.spread > 0) {
      p.bloom = Math.min(w.spread * (T.gun.bloomMax - 1), p.bloom + w.spread * T.gun.bloomPerShot);
    }

    /* Recoil goes into the impulse channel, so it survives the top-speed
       clamp and is actually felt. A breacher fired while sprinting now
       genuinely checks your momentum, which is what makes it read as a
       shotgun rather than a sound effect. */
    const kick = w.recoil * T.gun.recoilScale * (m.recoil ?? 1);
    p.ivx -= Math.cos(p.aimA) * kick;
    p.ivz -= Math.sin(p.aimA) * kick;
    const ispd = Math.hypot(p.ivx, p.ivz);
    if (ispd > T.player.impulseMax) {
      p.ivx = (p.ivx / ispd) * T.player.impulseMax;
      p.ivz = (p.ivz / ispd) * T.player.impulseMax;
    }
    p.recoil = 1;
    this.events.push(EV.SHOT, { id: p.id, w: w.id, x: mx, z: mz, a: p.aimA, shake: w.shake, cone });
  }

  addCombo(p) {
    p.combo++;
    p.comboT = T.combo.window;
    if (p.combo === 5 || p.combo === 10 || p.combo === 20 || p.combo === 35) {
      this.events.push(EV.STREAK, { id: p.id, combo: p.combo });
    }
  }

  healPlayer(p, v) {
    if (p.hp >= p.maxHp) return;
    p.hp = Math.min(p.maxHp, p.hp + v);
    this.events.push(EV.HEAL, { id: p.id, v: Math.round(v), x: p.x, z: p.z });
  }

  damagePlayer(p, amount, srcX, srcZ, attacker, ignoreIframe = false) {
    if (!p.alive || p.down) return;
    if (!ignoreIframe && (p.iframe > 0 || p.protectT > 0)) return;
    if (attacker && this.mode.pvp && attacker.team === p.team && attacker !== p) return;

    if (!ignoreIframe) p.iframe = T.player.iframeOnHit;
    p.shieldT = T.player.shieldDelay;
    p.damageTaken += amount;

    let rest = amount;
    if (p.shield > 0) { const a = Math.min(p.shield, rest); p.shield -= a; rest -= a; }
    if (rest > 0) p.hp -= rest;

    // The combo ladder is a risk currency: getting hit costs you most of it.
    p.combo = Math.max(0, (p.combo * 0.4) | 0);
    if (attacker && attacker.isPlayer) attacker.damageDealt += amount;

    /* Being hit shoves you. Scaled by the size of the hit and capped, so a
       torch tick nudges and a bruiser slam genuinely moves you — but never so
       far that you lose control of where you end up. Damage you take through
       burn has no direction and is passed srcX/srcZ at your own feet, which
       the length check below filters out. */
    if (srcX !== undefined && srcZ !== undefined) {
      const dx = p.x - srcX, dz = p.z - srcZ, d = Math.hypot(dx, dz);
      if (d > 0.05) {
        const push = Math.min(11, 2.2 + amount * 0.16);
        p.ivx += (dx / d) * push;
        p.ivz += (dz / d) * push;
        const ispd = Math.hypot(p.ivx, p.ivz);
        if (ispd > T.player.impulseMax) {
          p.ivx = (p.ivx / ispd) * T.player.impulseMax;
          p.ivz = (p.ivz / ispd) * T.player.impulseMax;
        }
      }
    }

    this.events.push(EV.HURT, {
      id: p.id, dmg: Math.round(amount), x: p.x, z: p.z,
      sx: srcX, sz: srcZ, by: attacker ? attacker.id : null
    });

    if (p.hp <= 0) {
      p.hp = 0;
      if (this.mode.downState && !p.down && this.hasLivingAlly(p)) {
        p.down = true;
        p.downT = 18;
        p.reviveT = 0;
        p.shield = 0;
        this.events.push(EV.DOWN, { id: p.id, x: p.x, z: p.z, by: attacker ? attacker.id : null });
      } else {
        this.killPlayer(p, attacker);
      }
    }
  }

  hasLivingAlly(p) {
    for (const o of this.players) {
      if (o === p || !o.alive || o.down) continue;
      if (!this.mode.pvp || o.team === p.team) return true;
    }
    return false;
  }

  killPlayer(p, attacker) {
    if (!p.alive) return;
    p.alive = false;
    p.down = false;
    p.deaths++;
    p.streak = 0;
    p.combo = 0;
    p.respawnT = this.mode.respawnTime || 0;
    if (attacker && attacker.isPlayer && attacker !== p) {
      attacker.kills++;
      attacker.streak++;
      attacker.score += 100;
      this.addCombo(attacker);
      if (this.mode.pvp) this.teamScore[attacker.team]++;
      if (attacker.streak === 3 || attacker.streak === 5 || attacker.streak === 8) {
        this.events.push(EV.STREAK, { id: attacker.id, streak: attacker.streak });
      }
    } else if (this.mode.pvp) {
      // Environmental death still feeds the other teams, so the ring matters.
      for (let i = 0; i < this.teamScore.length; i++) if (i !== p.team) this.teamScore[i] += 0;
    }
    this.events.push(EV.DIE, { id: p.id, x: p.x, z: p.z, by: attacker ? attacker.id : null });
  }

  /* ------------------------------------------------------------- ENEMIES */

  spawnEnemy(key, x, z, opts = {}) {
    const def = ENEMY_TYPES[key];
    if (!def) return null;
    let e = null;
    for (let i = 0; i < this.enemies.length; i++) if (!this.enemies[i].alive) { e = this.enemies[i]; break; }
    if (!e) return null;

    const hpScale = (1 + this.director.wave * T.director.hpScale) * this.director.hpMul;
    e.alive = true;
    e.eid = ENTITY_SEQ++;
    e.key = key; e.def = def;
    e.x = e.px = x; e.z = e.pz = z;
    e.vx = e.vz = 0;
    e.ivx = e.ivz = 0;
    e.maxHp = e.hp = def.hp * hpScale * (opts.hpMul || 1);
    e.r = def.r * def.scale;
    e.scale = def.scale;
    e.speed = def.speed * this.rng.range(1.1, 0.9) * this.director.speedMul;
    e.bias = this.rng.bool() ? -1 : 1;
    e.wobble = this.rng.range(TAU);
    e.spin = this.rng.range(1.4, -1.4);
    e.flash = 0;
    e.atkCd = this.rng.range(1.2, 0.3);
    e.windup = 0; e.windupKind = '';
    e.slowT = 0; e.staggerT = 0; e.burnT = 0;
    e.elite = !!def.elite;
    e.buffed = 0; e.phase = 0;
    e.spawnT = 0.28;
    e.faceA = this.rng.range(TAU);
    e.tag = -1;
    e.role = ROLE.PRESSURE;
    e.behavior = BEHAVIOR.SEARCH;
    e.flankSide = 1; e.flankArc = T.ai.flankArc;
    e.searchA = e.faceA;
    e.lungeT = 0; e.lungeCd = 0; e.fuse = 0;
    e.team = -1;
    e.isEnemy = true;
    e.targetsVehicle = this.defense?.assignTarget(key) || false;
    e.mem = { target: null, x, z, vx: 0, vz: 0, seen: false, confidence: 0, t: 99 };
    // A brand-new enemy is not blind: it starts pointed at whoever it spawned near.
    const near = this.nearestPlayer(x, z);
    if (near) {
      e.faceA = Math.atan2(near.z - z, near.x - x);
      e.mem.target = near.id; e.mem.x = near.x; e.mem.z = near.z; e.mem.confidence = 0.5; e.mem.t = 1.5;
    }
    this.events.push(EV.SPAWN, { eid: e.eid, key, x, z, elite: e.elite });
    return e;
  }

  nearestPlayer(x, z, team = null) {
    let best = null, bd = Infinity;
    for (const p of this.players) {
      if (!p.alive || p.down) continue;
      if (team !== null && p.team === team) continue;
      const d = dist2(p.x, p.z, x, z);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  stepEnemies(dt) {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      e.px = e.x; e.pz = e.z;
      const def = e.def;

      e.flash = Math.max(0, e.flash - dt);
      e.slowT = Math.max(0, e.slowT - dt);
      e.staggerT = Math.max(0, e.staggerT - dt);
      e.spawnT = Math.max(0, e.spawnT - dt);
      e.buffed = Math.max(0, e.buffed - dt);
      e.lungeCd = Math.max(0, e.lungeCd - dt);
      e.wobble += dt * 3;

      if (e.burnT > 0) {
        e.burnT -= dt;
        this.hurtEnemy(e, 14 * dt, e.x, e.z, 0, false, e.burnBy || null, true);
        if (!e.alive) continue;
      }

      this.defense?.stun(e);
      const target = e.targetsVehicle ? null : perceive(e, this);
      if (!e.targetsVehicle) e.behavior = chooseBehavior(e, this);

      // Lunge: a stalker's whole identity. Committed, telegraphed, and it
      // overrides steering entirely while it runs.
      if (e.lungeT > 0) {
        e.lungeT -= dt;
        e.x += Math.cos(e.faceA) * def.lunge.speed * dt;
        e.z += Math.sin(e.faceA) * def.lunge.speed * dt;
        this.world.collide(e, e.r);
        this.enemyContact(e, dt);
        continue;
      }

      let speedMul = 1;
      if (e.staggerT > 0 || e.spawnT > 0 || e.windup > 0) {
        steerOut.x = 0; steerOut.z = 0;
        speedMul = e.windup > 0 ? 0.12 : 0;
      } else {
        if (e.targetsVehicle) this.defense.steer(e, this.world, steerOut);
        else speedMul = steer(e, this, steerOut);
        avoid(e, this, steerOut);
      }

      const slowK = e.slowT > 0 ? 0.35 : 1;
      const spd = e.speed * slowK * speedMul * (1 + e.buffed * 0.25) * (e.spawnT > 0 ? 0.15 : 1);
      e.vx = damp(e.vx, steerOut.x * spd, 7, dt);
      e.vz = damp(e.vz, steerOut.z * spd, 7, dt);
      e.x += e.vx * dt;
      e.z += e.vz * dt;

      // Impulse channel — knockback and blasts, outside the steering damp.
      if (e.ivx !== 0 || e.ivz !== 0) {
        e.x += e.ivx * dt; e.z += e.ivz * dt;
        const k = Math.max(0, 1 - T.ai.impulseDrag * dt);
        e.ivx *= k; e.ivz *= k;
        if (Math.abs(e.ivx) < 0.03) e.ivx = 0;
        if (Math.abs(e.ivz) < 0.03) e.ivz = 0;
      }

      this.world.collide(e, e.r);

      // Facing: toward what it believes, not toward what is true.
      const wantA = e.targetsVehicle ? Math.atan2(-e.z, -e.x) : e.mem.confidence > 0
        ? Math.atan2(e.mem.z - e.z, e.mem.x - e.x)
        : Math.atan2(e.vz, e.vx);
      if (Number.isFinite(wantA)) e.faceA += angleDelta(e.faceA, wantA) * Math.min(1, dt * 9);

      if (e.targetsVehicle) this.defense.attack(e, dt);
      else if (e.staggerT <= 0 || !this.defense) this.enemyAttacks(e, target, dt);
      this.enemyAura(e);
      if (def.boss) this.bossLogic(e, dt);
    }
  }

  enemyAttacks(e, target, dt) {
    const def = e.def;
    e.atkCd -= dt;

    if (e.windup > 0) {
      e.windup -= dt;
      if (e.windup <= 0) this.releaseAttack(e);
      return;
    }
    if (e.spawnT > 0 || e.staggerT > 0) return;

    const mem = e.mem;
    if (mem.confidence <= 0) return;
    const d = Math.hypot(mem.x - e.x, mem.z - e.z);

    // Suicide bomber: fuse starts, and the fuse is the fair part.
    if (def.suicide) {
      if (d < def.suicide.trigger && mem.seen) {
        e.windup = Math.max(T.ai.minTelegraph, def.suicide.fuse);
        e.windupKind = 'suicide';
        this.events.push(EV.TELEGRAPH, { kind: 'suicide', eid: e.eid, x: e.x, z: e.z, r: def.suicide.radius, d: e.windup });
      }
      return;
    }

    if (def.lunge && e.lungeCd <= 0 && d < def.lunge.range && d > 2.4 && mem.seen) {
      e.windup = Math.max(T.ai.minTelegraph, def.lunge.windup);
      e.windupKind = 'lunge';
      this.events.push(EV.TELEGRAPH, { kind: 'lunge', eid: e.eid, x: e.x, z: e.z, a: e.faceA, r: def.lunge.range, d: e.windup });
      return;
    }

    if (e.atkCd > 0) return;

    if (def.slam && d < def.slamRadius * 0.92) {
      e.windup = Math.max(T.ai.minTelegraph, def.windup);
      e.windupKind = 'slam';
      e.atkCd = 2.4;
      this.events.push(EV.TELEGRAPH, { kind: 'slam', eid: e.eid, x: e.x, z: e.z, r: def.slamRadius, d: e.windup });
    } else if (def.ranged && d < def.range && d > 3 && mem.seen) {
      e.windup = Math.max(T.ai.minTelegraph, def.windup);
      e.windupKind = 'shoot';
      e.atkCd = def.boss ? 2.0 : this.rng.range(2.6, 1.5);
      this.events.push(EV.TELEGRAPH, { kind: 'shoot', eid: e.eid, x: e.x, z: e.z, a: e.faceA, d: e.windup });
    } else if (def.contact) {
      this.enemyContact(e, dt);
    }
  }

  enemyContact(e, dt) {
    const def = e.def;
    if (e.atkCd > 0) return;
    for (const p of this.players) {
      if (!p.alive || p.down) continue;
      const rr = e.r + T.player.radius + 0.35;
      if (dist2(e.x, e.z, p.x, p.z) > rr * rr) continue;
      this.damagePlayer(p, def.dmg, e.x, e.z, null);
      e.atkCd = 0.85;
      const dx = e.x - p.x, dz = e.z - p.z, d = Math.hypot(dx, dz) || 1;
      e.vx += (dx / d) * 9; e.vz += (dz / d) * 9;
      if (p.mods.thorns) this.hurtEnemy(e, p.mods.thorns, p.x, p.z, 4, false, p);
      return;
    }
    void dt;
  }

  releaseAttack(e) {
    const def = e.def;
    const kind = e.windupKind;
    e.windupKind = '';

    if (kind === 'suicide') {
      this.explode(e.x, e.z, def.suicide.radius, def.dmg, true, null);
      e.alive = false;
      this.events.push(EV.KILL, { eid: e.eid, key: e.key, x: e.x, z: e.z, silent: true });
      return;
    }
    if (kind === 'lunge') {
      e.lungeT = def.lunge.range / def.lunge.speed;
      e.lungeCd = def.lunge.cd;
      e.atkCd = 0.4;
      return;
    }
    if (kind === 'slam' || def.slam) {
      this.explode(e.x, e.z, def.slamRadius, def.dmg, true, null);
      return;
    }
    if (def.ranged) {
      const shots = def.boss ? 12 : e.elite ? 3 : 1;
      const base = e.faceA;
      for (let i = 0; i < shots; i++) {
        const a = def.boss
          ? (i / shots) * TAU + this.rng.range(0.2)
          : base + (shots > 1 ? (i - (shots - 1) / 2) * 0.16 : 0);
        this.spawnProjectile({
          x: e.x + Math.cos(a) * (e.r + 0.4),
          z: e.z + Math.sin(a) * (e.r + 0.4),
          vx: Math.cos(a) * (def.projSpeed || 26),
          vz: Math.sin(a) * (def.projSpeed || 26),
          def: { dmg: def.dmg, size: 0.34, life: 3.2, color: COL.rose },
          owner: null, hostile: true
        });
      }
      this.events.push(EV.SHOT, { eid: e.eid, w: 'enemy', x: e.x, z: e.z, a: base });
    }
  }

  enemyAura(e) {
    const def = e.def;
    if (!def.aura || (this.tick & 7) !== 0) return;
    const n = this.hash.query(e.x, e.z, def.aura, this.qbuf);
    for (let i = 0; i < n; i++) {
      const o = this.qbuf[i];
      if (o !== e && o.isEnemy && o.alive && dist2(o.x, o.z, e.x, e.z) < def.aura * def.aura) o.buffed = 0.4;
    }
  }

  bossLogic(e, dt) {
    const frac = e.hp / e.maxHp;
    const phase = frac > 0.66 ? 0 : frac > 0.33 ? 1 : 2;
    if (phase !== e.phase) {
      e.phase = phase;
      e.speed = e.def.speed * (1 + phase * 0.28);
      this.events.push(EV.BANNER, { a: 'PHASE ' + (phase + 1), b: 'THE CHAMPION ADAPTS', big: true });
      for (let i = 0; i < 4 + phase * 3; i++) {
        const a = this.rng.range(TAU), r = this.rng.range(30, 20);
        this.director.queueSpawn('rusher', Math.cos(a) * r, Math.sin(a) * r);
      }
    }
    void dt;
  }

  hurtEnemy(e, amount, fromX, fromZ, knock, canCrit, attacker, silent = false) {
    if (!e.alive) return 0;
    const m = attacker && attacker.mods ? attacker.mods : null;
    let crit = false;
    let dmg = amount * (m ? 1 : 1);
    if (canCrit && m && this.rng.f() < m.crit) { crit = true; dmg *= m.critMult; }
    dmg *= armorMultiplier(e, fromX, fromZ);
    dmg = Math.max(1, Math.round(dmg));

    e.hp -= dmg;
    e.flash = 0.12;
    if (attacker && attacker.isPlayer) attacker.damageDealt += dmg;

    /* Knockback goes into the impulse channel, never into e.vx.

       Steering damps velocity toward the desired heading every frame, so a
       knockback written into e.vx was gone in about one frame — a breacher
       fired into a rusher's face moved it by nothing at all. Integrated
       separately, the shove is visible, and it still cannot make an enemy
       outrun its own steering once the impulse drains. */
    if (knock) {
      const dx = e.x - fromX, dz = e.z - fromZ, d = Math.hypot(dx, dz) || 1;
      const k = knockScale(e.def, knock * (m && m.knock ? m.knock : 1));
      e.ivx += (dx / d) * k; e.ivz += (dz / d) * k;
      const ispd = Math.hypot(e.ivx, e.ivz);
      if (ispd > T.ai.impulseMax) {
        e.ivx = (e.ivx / ispd) * T.ai.impulseMax;
        e.ivz = (e.ivz / ispd) * T.ai.impulseMax;
      }
      // A big enough hit interrupts. Poise is already folded into k, so a
      // warden shrugs off what staggers a rusher without a second rule.
      const stagger = Math.min(T.ai.staggerMax, k * T.ai.staggerPerKnock);
      if (stagger > 0.04) e.staggerT = Math.max(e.staggerT, stagger);
      if (crit && m && m.stagger) e.staggerT = Math.max(e.staggerT, 0.4);
    }

    if (!silent) {
      this.events.push(EV.HIT, {
        eid: e.eid, x: e.x, y: 1.4 + e.r, z: e.z, dmg, crit: crit ? 1 : 0,
        by: attacker && attacker.isPlayer ? attacker.id : null,
        armored: armorMultiplier(e, fromX, fromZ) < 1 ? 1 : 0
      });
    }
    if (crit && m && m.lifesteal && attacker) this.healPlayer(attacker, m.lifesteal);

    if (e.hp <= 0) {
      const over = -e.hp;
      this.killEnemy(e, fromX, fromZ, attacker);
      return over;
    }
    return 0;
  }

  killEnemy(e, fromX, fromZ, attacker) {
    e.alive = false;
    const def = e.def;

    if (attacker && attacker.isPlayer) {
      attacker.kills++;
      this.addCombo(attacker);
      attacker.score += Math.round(def.score * (1 + attacker.combo * 0.05));
      if (this.mode.pvp) this.teamScore[attacker.team] += 0;   // AI kills do not score in PvP
      const m = attacker.mods;
      if (m.explosive > 0) this.explode(e.x, e.z, 5.2, m.explosive, false, attacker);
    }

    this.events.push(EV.KILL, {
      eid: e.eid, key: e.key, x: e.x, z: e.z, r: e.r,
      elite: e.elite ? 1 : 0, boss: def.boss ? 1 : 0,
      by: attacker && attacker.isPlayer ? attacker.id : null,
      combo: attacker && attacker.isPlayer ? attacker.combo : 0
    });

    if (def.splits) {
      for (let i = 0; i < def.splits; i++) {
        const a = this.rng.range(TAU);
        this.spawnEnemy('shard', e.x + Math.cos(a) * 1.4, e.z + Math.sin(a) * 1.4);
      }
    }
    this.dropFor(e, attacker);
    this.director.onKill(e);
    void fromX; void fromZ;
  }

  explode(x, z, radius, dmg, hostile, attacker) {
    this.events.push(EV.EXPLODE, { x, z, r: radius, hostile: hostile ? 1 : 0 });
    const r2 = radius * radius;
    if (hostile) {
      for (const p of this.players) {
        if (p.alive && !p.down && dist2(x, z, p.x, p.z) < r2) this.damagePlayer(p, dmg, x, z, attacker || null);
      }
      return;
    }
    for (const e of this.enemies) {
      if (e.alive && dist2(e.x, e.z, x, z) < r2) this.hurtEnemy(e, dmg, x, z, 6, false, attacker);
    }
    if (this.mode.pvp) {
      for (const p of this.players) {
        if (!p.alive || p.down || p === attacker) continue;
        if (attacker && p.team === attacker.team) continue;
        if (dist2(x, z, p.x, p.z) < r2) this.damagePlayer(p, dmg * 0.8, x, z, attacker || null);
      }
    }
    for (const prop of this.world.props) {
      if (prop.maxHp && prop.alive && dist2(x, z, prop.x, prop.z) < r2) {
        if (this.world.damageProp(prop, dmg)) {
          this.events.push(EV.PROP_BREAK, { i: prop.i, x: prop.x, z: prop.z });
          this.costDirty = true;
        }
      }
    }
  }

  /* --------------------------------------------------------- PROJECTILES */

  spawnProjectile(o) {
    let p = null;
    for (let i = 0; i < this.projectiles.length; i++) if (!this.projectiles[i].alive) { p = this.projectiles[i]; break; }
    if (!p) return null;
    const w = o.def;
    const m = o.owner && o.owner.mods ? o.owner.mods : null;
    p.alive = true;
    p.eid = ENTITY_SEQ++;
    p.x = o.x; p.z = o.z; p.vx = o.vx; p.vz = o.vz;
    p.life = w.life || 1.2;
    p.size = w.size || 0.2;
    p.color = w.color || COL.amber;
    p.hostile = !!o.hostile;
    p.owner = o.owner || null;
    p.team = o.owner ? o.owner.team : -1;
    p.dmg = o.hostile ? w.dmg : w.dmg * (m ? m.dmg : 1);
    p.pierce = o.hostile ? 0 : (w.pierce || 0) + (m ? m.pierce : 0);
    p.bounces = o.hostile ? 0 : (w.bounces || 0) + (m ? m.bounces : 0);
    p.knock = w.knock || 0;
    p.stop = w.stop || 0;
    p.split = o.hostile ? 0 : (m ? m.split : 0);
    p.burn = w.burn || 0;
    p.detonate = w.detonate || null;
    p.wid = w.id || '';
    p.tag = this._projTag++;
    return p;
  }

  stepProjectiles(dt) {
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) {
        if (p.detonate) this.explode(p.x, p.z, p.detonate.radius, p.detonate.dmg * (p.owner ? p.owner.mods.dmg : 1), false, p.owner);
        p.alive = false;
        continue;
      }

      const nx = p.x + p.vx * dt, nz = p.z + p.vz * dt;
      const stepLen = Math.hypot(nx - p.x, nz - p.z);
      const midX = (p.x + nx) * 0.5, midZ = (p.z + nz) * 0.5;
      const searchR = stepLen * 0.5 + p.size + 3.0;

      let consumed = false;
      const n = this.hash.query(midX, midZ, searchR, this.qbuf);
      for (let i = 0; i < n && !consumed; i++) {
        const o = this.qbuf[i];
        if (!o.alive || o.tag === p.tag) continue;

        if (o.isEnemy) {
          if (p.hostile) continue;
          const rr = o.r + p.size;
          if (segPointDist2(p.x, p.z, nx, nz, o.x, o.z) > rr * rr) continue;
          o.tag = p.tag;
          if (p.owner) p.owner.shotsHit++;
          if (p.burn) { o.burnT = Math.max(o.burnT, p.burn); o.burnBy = p.owner; }
          const over = this.hurtEnemy(o, p.dmg, p.x, p.z, p.knock, true, p.owner);
          consumed = this.afterProjectileHit(p, o, over);
        } else if (o.isPlayer) {
          const friendly = p.owner === o || (p.team >= 0 && o.team === p.team && this.mode.pvp);
          if (!p.hostile && (!this.mode.pvp || friendly)) continue;
          if (p.hostile && false) continue;
          const rr = T.player.radius + p.size;
          if (segPointDist2(p.x, p.z, nx, nz, o.x, o.z) > rr * rr) continue;
          o.tag = p.tag;
          if (p.owner) p.owner.shotsHit++;
          if (p.burn) o.burnT = Math.max(o.burnT, p.burn);
          this.damagePlayer(o, p.dmg, p.x, p.z, p.owner);
          consumed = true;
        }
      }
      if (consumed || !p.alive) {
        if (p.alive && p.detonate) this.explode(p.x, p.z, p.detonate.radius, p.detonate.dmg * (p.owner ? p.owner.mods.dmg : 1), false, p.owner);
        p.alive = false;
        continue;
      }

      // World collision: bounce or die.
      const prop = this.world.hitProp(nx, nz, p.size);
      const lim = this.shrinkRadius - 0.4;
      const outside = nx * nx + nz * nz > lim * lim;
      if (prop || outside) {
        if (prop && prop.maxHp) {
          if (this.world.damageProp(prop, p.dmg)) {
            this.events.push(EV.PROP_BREAK, { i: prop.i, x: prop.x, z: prop.z });
            this.costDirty = true;
          }
        }
        if (p.bounces > 0 && !p.hostile) {
          p.bounces--;
          let rx, rz;
          if (outside) { const d = Math.hypot(nx, nz) || 1; rx = nx / d; rz = nz / d; }
          else { const dx = nx - prop.x, dz = nz - prop.z, d = Math.hypot(dx, dz) || 1; rx = dx / d; rz = dz / d; }
          const dot = p.vx * rx + p.vz * rz;
          p.vx -= 2 * dot * rx; p.vz -= 2 * dot * rz;
          p.tag = this._projTag++;   // a bounced shot may hit the same target again
          this.events.push(EV.BOUNCE, { x: p.x, z: p.z, c: p.color });
        } else {
          if (p.detonate) this.explode(p.x, p.z, p.detonate.radius, p.detonate.dmg * (p.owner ? p.owner.mods.dmg : 1), false, p.owner);
          p.alive = false;
          continue;
        }
      }
      p.x += p.vx * dt;
      p.z += p.vz * dt;
    }
  }

  afterProjectileHit(p, e, over) {
    const m = p.owner ? p.owner.mods : null;
    if (p.detonate) {
      this.explode(p.x, p.z, p.detonate.radius, p.detonate.dmg * (m ? m.dmg : 1), false, p.owner);
      return true;
    }
    if (p.split > 0) {
      const a0 = Math.atan2(p.vz, p.vx);
      for (let s = 0; s < 2; s++) {
        const a = a0 + (s ? 0.5 : -0.5);
        const q = this.spawnProjectile({
          x: e.x, z: e.z, vx: Math.cos(a) * 60, vz: Math.sin(a) * 60,
          def: { dmg: p.dmg * 0.5, size: p.size * 0.8, life: 0.6, color: p.color, knock: 1 },
          owner: p.owner, hostile: false
        });
        if (q) q.split = 0;
      }
      p.split = 0;
    }
    if (over > 0 && m && m.overkill > 0) {
      const next = this.nearestEnemyInCone(e.x, e.z, Math.atan2(p.vz, p.vx), 0.2, 12);
      if (next) this.hurtEnemy(next, over * m.overkill, e.x, e.z, 2, false, p.owner);
    }
    if (p.pierce > 0) { p.pierce--; return false; }
    return true;
  }

  nearestEnemyInCone(x, z, angle, minDot, range) {
    let best = null, bd = range * range;
    const cx = Math.cos(angle), cz = Math.sin(angle);
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dx = e.x - x, dz = e.z - z, d2 = dx * dx + dz * dz;
      if (d2 > bd) continue;
      const d = Math.sqrt(d2) || 1;
      if ((dx / d) * cx + (dz / d) * cz < minDot) continue;
      bd = d2; best = e;
    }
    return best;
  }

  /* ------------------------------------------------------------- TURRETS */

  addTurret(owner, x, z, life) {
    let t = this.turrets.find(t => !t.alive);
    if (!t) { t = this.turrets[0]; }
    t.alive = true; t.eid = ENTITY_SEQ++; t.owner = owner.id; t.team = owner.team;
    t.x = x; t.z = z; t.t = 0; t.life = life; t.cd = 0; t.a = owner.aimA;
    return t;
  }

  stepTurrets(dt) {
    for (const t of this.turrets) {
      if (!t.alive) continue;
      t.t += dt; t.life -= dt;
      if (t.life <= 0) { t.alive = false; continue; }
      t.cd -= dt;
      const owner = this.playerById(t.owner);
      let target = this.nearestEnemyInCone(t.x, t.z, t.a, -1, 26);
      if (!target && this.mode.pvp) {
        let bd = 26 * 26;
        for (const p of this.players) {
          if (!p.alive || p.down || p.team === t.team) continue;
          const d = dist2(p.x, p.z, t.x, t.z);
          if (d < bd) { bd = d; target = p; }
        }
      }
      if (!target) continue;
      t.a = Math.atan2(target.z - t.z, target.x - t.x);
      if (t.cd > 0) continue;
      t.cd = 0.16;
      this.spawnProjectile({
        x: t.x + Math.cos(t.a) * 0.8, z: t.z + Math.sin(t.a) * 0.8,
        vx: Math.cos(t.a) * 70, vz: Math.sin(t.a) * 70,
        def: { dmg: 7, size: 0.13, life: 0.8, color: COL.amber, knock: 1 },
        owner, hostile: false
      });
    }
  }

  /* ------------------------------------------------------------- PICKUPS */

  dropFor(e, attacker) {
    const def = e.def;
    const n = def.boss ? 14 : e.elite ? 6 : this.rng.f() < 0.34 ? 1 : 0;
    for (let i = 0; i < n; i++) this.addPickup('score', e.x, e.z, Math.round(def.score * 0.4));
    if (def.boss || e.elite || this.rng.f() < 0.035) this.addPickup('health', e.x, e.z, e.elite ? 30 : 15);
    void attacker;
  }

  addPickup(kind, x, z, value) {
    for (const p of this.pickups) {
      if (p.alive) continue;
      p.alive = true; p.eid = ENTITY_SEQ++;
      p.kind = kind; p.x = x; p.z = z; p.value = value; p.t = 0;
      const a = this.rng.range(TAU), s = this.rng.range(7, 3);
      p.vx = Math.cos(a) * s; p.vz = Math.sin(a) * s;
      return p;
    }
    return null;
  }

  stepPickups(dt) {
    for (const p of this.pickups) {
      if (!p.alive) continue;
      p.t += dt;
      if (p.kind === 'fuse') {
        const carrier = this.players.find(pl => pl.connected && pl.alive && !pl.down && !pl.bot &&
          !this.defense.carriers.has(pl.id) && dist2(pl.x, pl.z, p.x, p.z) <= 1.45 ** 2);
        if (carrier) {
          p.alive = false;
          this.defense.carriers.add(carrier.id);
          this.events.push(EV.PICKUP, { id: carrier.id, kind: 'fuse', x: p.x, z: p.z });
        }
        continue;
      }

      let claimer = null, cd = Infinity;
      for (const pl of this.players) {
        if (!pl.alive || pl.down) continue;
        const d = dist2(pl.x, pl.z, p.x, p.z);
        if (d < cd) { cd = d; claimer = pl; }
      }
      if (claimer) {
        const mag = T.player.magnet * claimer.mods.magnet;
        const dx = claimer.x - p.x, dz = claimer.z - p.z;
        const d = Math.sqrt(cd) || 1;
        if (d < mag) {
          const pull = lerp(26, 78, 1 - d / mag);
          p.vx = damp(p.vx, (dx / d) * pull, 9, dt);
          p.vz = damp(p.vz, (dz / d) * pull, 9, dt);
        } else { p.vx *= 1 - Math.min(1, 3 * dt); p.vz *= 1 - Math.min(1, 3 * dt); }
        p.x += p.vx * dt; p.z += p.vz * dt;
        if (d < 1.3) {
          p.alive = false;
          if (p.kind === 'health') this.healPlayer(claimer, p.value);
          else if (p.kind === 'surge') { claimer.mods.dmg *= 1.5; this.addEffect(8, () => {}, () => { claimer.mods.dmg /= 1.5; }); }
          else claimer.score += p.value;
          this.events.push(EV.PICKUP, { id: claimer.id, kind: p.kind, x: p.x, z: p.z, v: p.value });
          continue;
        }
      }
      if (p.t > 26) p.alive = false;
    }
  }

  /* ------------------------------------------------------------ UPGRADES */

  applyUpgrade(p, id) {
    const u = UPGRADE_BY_ID[id];
    if (!u) return false;
    const have = p.taken[id] || 0;
    if (have >= u.max) return false;
    p.taken[id] = have + 1;
    u.apply(this, p);
    this.events.push(EV.UPGRADE, { id: p.id, upgrade: id });
    return true;
  }

  grantAbility(p, abilityId, slot) {
    const def = ABILITY_BY_ID[abilityId];
    if (!def) return false;
    const s = slot ?? p.abilities.indexOf(null);
    if (s < 0) return false;
    p.abilities[s] = { def, cd: 0 };
    return true;
  }

  /* ------------------------------------------------------------ SNAPSHOT */

  /** Compact state for the wire. Only what a client cannot derive itself. */
  snapshot() {
    return {
      tick: this.tick,
      time: +this.time.toFixed(3),
      matchTime: +this.matchTime.toFixed(2),
      shrink: +this.shrinkRadius.toFixed(2),
      wave: this.director.wave,
      phase: this.director.phase,
      intensity: +this.director.intensity.toFixed(3),
      teamScore: this.teamScore.slice(),
      over: this.over,
      defense: this.defense?.snapshot() ?? null,
      players: this.players.map(p => ({
        id: p.id, x: +p.x.toFixed(2), z: +p.z.toFixed(2),
        vx: +p.vx.toFixed(2), vz: +p.vz.toFixed(2),
        a: +p.aimA.toFixed(3), hp: Math.round(p.hp), sh: Math.round(p.shield),
        w: p.weapon, alive: p.alive ? 1 : 0, down: p.down ? 1 : 0,
        rev: +p.reviveT.toFixed(2), dash: p.dashCharge, combo: p.combo,
        k: p.kills, d: p.deaths, sc: p.score, team: p.team, seq: p.lastSeq,
        st: p.streak, prot: p.protectT > 0 ? 1 : 0
      })),
      enemies: this.enemies.filter(e => e.alive).map(e => ({
        e: e.eid, k: e.key, x: +e.x.toFixed(2), z: +e.z.toFixed(2),
        a: +e.faceA.toFixed(2), hp: Math.round((e.hp / e.maxHp) * 100),
        w: e.windup > 0 ? 1 : 0, b: e.buffed > 0 ? 1 : 0, s: e.spawnT > 0 ? 1 : 0
      })),
      projectiles: this.projectiles.filter(p => p.alive).map(p => ({
        e: p.eid, x: +p.x.toFixed(2), z: +p.z.toFixed(2),
        vx: +p.vx.toFixed(1), vz: +p.vz.toFixed(1),
        s: +p.size.toFixed(2), c: p.color, h: p.hostile ? 1 : 0
      })),
      pickups: this.pickups.filter(p => p.alive).map(p => ({
        e: p.eid, k: p.kind, x: +p.x.toFixed(2), z: +p.z.toFixed(2)
      })),
      turrets: this.turrets.filter(t => t.alive).map(t => ({
        e: t.eid, x: +t.x.toFixed(2), z: +t.z.toFixed(2), a: +t.a.toFixed(2), l: +t.life.toFixed(1)
      }))
    };
  }
}

/* ------------------------------------------------------------- FACTORIES */

function freshInput() {
  return { mx: 0, mz: 0, ax: 1, az: 0, fire: false, dash: false, ab0: false, ab1: false, weapon: 0 };
}

function blankEnemy() {
  return {
    alive: false, eid: 0, key: 'rusher', def: null, isEnemy: true,
    x: 0, z: 0, px: 0, pz: 0, vx: 0, vz: 0,
    ivx: 0, ivz: 0,
    hp: 1, maxHp: 1, r: 0.6, speed: 1, scale: 1,
    flash: 0, atkCd: 0, windup: 0, windupKind: '',
    slowT: 0, staggerT: 0, burnT: 0, burnBy: null,
    wobble: 0, bias: 1, spin: 0, tag: -1, elite: false,
    buffed: 0, phase: 0, spawnT: 0, faceA: 0, team: -1,
    role: 0, behavior: 'search', flankSide: 1, flankArc: 1, searchA: 0,
    lungeT: 0, lungeCd: 0, fuse: 0,
    mem: { target: null, x: 0, z: 0, vx: 0, vz: 0, seen: false, confidence: 0, t: 99 }
  };
}

function blankProjectile() {
  return {
    alive: false, eid: 0, x: 0, z: 0, vx: 0, vz: 0, life: 0, dmg: 0, size: 0.2,
    pierce: 0, bounces: 0, hostile: false, color: 0xffffff, tag: 0, split: 0,
    knock: 0, stop: 0, owner: null, team: -1, burn: 0, detonate: null, wid: ''
  };
}

function blankPickup() {
  return { alive: false, eid: 0, kind: 'score', x: 0, z: 0, vx: 0, vz: 0, t: 0, value: 0 };
}

export { ABILITIES, UPGRADES };
