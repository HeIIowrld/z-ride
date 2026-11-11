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

/* ========================= CONTENT DEFINITIONS =========================
   Weapons, enemy archetypes, drop tables. Pure data + pure functions, so the
   authoritative server and the predicting client read exactly the same rules.

   Colour constants live here too because on this game colour is information:
   amber = you, rose = it can kill you, ice = utility, and nothing decorative
   is ever allowed to be rose. */

export const COL = {
  ink: 0x0A0F14,
  petrol: 0x0C1D26,
  steel: 0x6E8798,
  bone: 0xE6EDF1,
  amber: 0xFFB53D,
  rose: 0xFF2D6B,
  ice: 0x6FE3FF,
  lime: 0xB4FF6F,
  concrete: 0xC8CFD4,
  rust: 0xB4653A,
  sky: 0x9FC6E8
};

/* =============================== WEAPONS ================================
   `rate` is seconds between shots. `stop` is hitstop milliseconds — the
   single biggest contributor to a weapon feeling heavy. */
export const WEAPONS = [
  {
    id: 'smg', name: 'SMG', slot: 0, unlock: 0,
    rate: 0.082, dmg: 9, spread: 0.055, speed: 82, pellets: 1, size: 0.16, life: 1.05,
    shake: 0.075, stop: 0, sfx: 'smg', knock: 1.6, recoil: 1.1, color: COL.amber,
    blurb: 'Forgiving. Always enough.'
  },
  {
    id: 'shotgun', name: 'BREACHER', slot: 1, unlock: 3,
    rate: 0.60, dmg: 8, spread: 0.20, speed: 66, pellets: 9, size: 0.15, life: 0.42,
    shake: 0.40, stop: 46, sfx: 'shot', knock: 9, recoil: 9, color: COL.amber,
    blurb: 'Nine reasons to get close.'
  },
  {
    id: 'rail', name: 'LANCE', slot: 2, unlock: 6,
    rate: 0.92, charge: 0.32, dmg: 96, spread: 0, speed: 175, pellets: 1, size: 0.34, life: 1.1,
    pierce: 99, shake: 0.55, stop: 72, sfx: 'rail', knock: 7, recoil: 6, color: COL.ice,
    blurb: 'Draws a line. Everything on it dies.'
  },
  {
    id: 'arc', name: 'RICOCHET', slot: 3, unlock: 9,
    rate: 0.27, dmg: 21, spread: 0.05, speed: 60, pellets: 1, size: 0.22, life: 2.6,
    bounces: 4, shake: 0.15, stop: 24, sfx: 'arc', knock: 3, recoil: 2, color: COL.lime,
    blurb: 'Corners are only suggestions.'
  },
  {
    id: 'beam', name: 'TORCH', slot: 4, unlock: 12,
    rate: 0.045, dmg: 4.2, spread: 0.10, speed: 46, pellets: 1, size: 0.20, life: 0.34,
    shake: 0.03, stop: 0, sfx: 'beam', knock: 0.5, recoil: 0.4, color: 0xFF8A3D,
    burn: 2.4, continuous: true,
    blurb: 'Short reach. Nothing survives it.'
  },
  {
    id: 'launcher', name: 'THUMPER', slot: 5, unlock: 15,
    rate: 1.05, dmg: 34, spread: 0.02, speed: 42, pellets: 1, size: 0.30, life: 2.2,
    shake: 0.5, stop: 60, sfx: 'thump', knock: 6, recoil: 7, color: COL.rust,
    detonate: { radius: 6.2, dmg: 62 },
    blurb: 'Arrives late. Arrives loud.'
  }
];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map(w => [w.id, w]));

/* =============================== ENEMIES ================================
   Ten archetypes over one AI core. Every one of them exists to ask a
   different question of the player:

     rusher   — can you keep moving?
     shard    — can you keep moving when there are more of them?
     bruiser  — can you read a telegraph under pressure?
     spitter  — can you close distance while being shot at?
     splitter — does your build handle a problem that multiplies?
     stalker  — are you watching the flanks or only the front?
     sapper   — can you make a decision in 900 milliseconds?
     warden   — will you reposition, or keep shooting a wall?
     elite    — can you do all of that at once?
     boss     — for two minutes?                                        */
export const ENEMY_TYPES = {
  rusher: {
    hp: 26, speed: 9.0, r: 0.62, dmg: 9, credits: 1, score: 10,
    color: 0xD8E6EE, geo: 'ico', model: 'drone_light', scale: 1.0, contact: true,
    brain: 'charge'
  },
  shard: {
    hp: 20, speed: 9.4, r: 0.48, dmg: 7, credits: 0, score: 8,
    color: 0xE6EDF1, geo: 'tetra', model: 'drone_light', scale: 0.55, contact: true,
    brain: 'charge'
  },
  bruiser: {
    hp: 165, speed: 3.6, r: 1.25, dmg: 24, credits: 5, score: 55,
    color: 0x92A9B8, geo: 'box', model: 'walker_heavy', scale: 1.0,
    slam: true, slamRadius: 5.4, windup: 0.62, brain: 'bruiser', poise: 0.6
  },
  spitter: {
    hp: 44, speed: 4.6, r: 0.72, dmg: 14, credits: 3, score: 30,
    color: 0xB9CBD6, geo: 'octa', model: 'drone_ranged', scale: 1.0,
    ranged: true, range: 21, windup: 0.5, projSpeed: 26, brain: 'skirmish'
  },
  splitter: {
    hp: 68, speed: 5.4, r: 0.92, dmg: 12, credits: 3, score: 35,
    color: 0xC9D8E2, geo: 'tetra', model: 'drone_light', scale: 1.0,
    contact: true, splits: 2, brain: 'charge'
  },
  stalker: {
    hp: 52, speed: 7.4, r: 0.68, dmg: 18, credits: 4, score: 45,
    color: 0xA8BFCC, geo: 'octa', model: 'drone_fast', scale: 0.92,
    contact: true, lunge: { range: 9.5, speed: 34, windup: 0.34, cd: 3.4 },
    brain: 'flank', prefersFlank: true
  },
  sapper: {
    hp: 38, speed: 8.2, r: 0.75, dmg: 46, credits: 4, score: 50,
    color: 0xE0A07A, geo: 'ico', model: 'drone_light', scale: 1.05,
    suicide: { radius: 5.6, fuse: 0.9, trigger: 3.4 }, brain: 'charge'
  },
  warden: {
    hp: 210, speed: 3.1, r: 1.15, dmg: 16, credits: 6, score: 80,
    color: 0x8FA6B4, geo: 'box', model: 'walker_heavy', scale: 1.1,
    frontArmor: { arc: 0.62, reduce: 0.78 },   // shots into the shield do 22%
    ranged: true, range: 15, windup: 0.55, projSpeed: 22,
    brain: 'anchor', poise: 0.85
  },
  elite: {
    hp: 460, speed: 4.8, r: 1.35, dmg: 20, credits: 11, score: 220,
    color: 0xFFD9A8, geo: 'dodeca', model: 'walker_elite', scale: 1.0,
    contact: true, aura: 9, ranged: true, range: 17, windup: 0.55, projSpeed: 30,
    elite: true, brain: 'commander', poise: 0.75
  },
  boss: {
    hp: 2600, speed: 3.4, r: 2.6, dmg: 30, credits: 0, score: 900,
    color: 0xFFC98A, geo: 'dodeca', model: 'walker_elite', scale: 2.0,
    slam: true, slamRadius: 8.5, windup: 0.75, ranged: true, range: 30, projSpeed: 26,
    boss: true, elite: true, brain: 'boss', poise: 1.0
  }
};

export const ENEMY_KEYS = Object.keys(ENEMY_TYPES);

/* ============================== PICKUPS ================================= */
export const PICKUP_KINDS = {
  score:  { color: COL.amber, r: 0.34 },
  health: { color: COL.ice,   r: 0.38 },
  ammo:   { color: COL.lime,  r: 0.32 },
  // PvP only: the arena hands out reasons to leave cover.
  surge:  { color: COL.rose,  r: 0.46, duration: 8 }
};

/* ============================ HIT REACTIONS =============================
   Poise decides whether a hit interrupts. Without this, heavies get
   stun-locked and the fight stops being a fight. */
export function knockScale(def, knock) {
  const poise = def.poise || 0;
  return (knock * (1 - poise)) / Math.max(0.6, def.r * (def.scale || 1));
}

/** Directional armour: a warden facing you eats almost nothing.
 *  Returns the damage multiplier for a shot arriving from (fromX, fromZ). */
export function armorMultiplier(e, fromX, fromZ) {
  const fa = e.def.frontArmor;
  if (!fa) return 1;
  const dx = fromX - e.x, dz = fromZ - e.z;
  const d = Math.hypot(dx, dz) || 1;
  const dot = (dx / d) * Math.cos(e.faceA) + (dz / d) * Math.sin(e.faceA);
  return dot > fa.arc ? 1 - fa.reduce : 1;
}
