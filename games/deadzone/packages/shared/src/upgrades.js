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

/* =============================== UPGRADES ===============================
   Designed to multiply, not to add. The dopamine is in finding a broken
   synergy, never in "+5% damage". Every line reads in six words or fewer,
   because the player is reading it with adrenaline still in their hands. */

export function freshMods() {
  return {
    dmg: 1, rate: 1, projSpeed: 1, crit: 0.05, critMult: 2.0,
    pierce: 0, bounces: 0, explosive: 0, lifesteal: 0,
    dashExtra: 0, dashTrail: 0, slowAura: 0, magnet: 1,
    shieldBonus: 0, moveSpeed: 1, comboRamp: 1, split: 0,
    overkill: 0, stagger: 0, thorns: 0, burn: 0,
    // Handling multipliers. 1 is the weapon as designed; a brace upgrade
    // takes these below 1.
    spread: 1, recoil: 1, knock: 1
  };
}

export const UPGRADES = [
  { id: 'dmg',      name: 'HEAVY ROUNDS',  icon: '✦', type: 'pas', max: 6, desc: '+22% damage',              apply: (s, p) => { p.mods.dmg *= 1.22; } },
  { id: 'rate',     name: 'OVERCLOCK',     icon: '≋', type: 'pas', max: 6, desc: '+18% fire rate',           apply: (s, p) => { p.mods.rate *= 1.18; } },
  { id: 'crit',     name: 'WEAK POINTS',   icon: '◈', type: 'pas', max: 5, desc: '+9% crit chance',          apply: (s, p) => { p.mods.crit += 0.09; } },
  { id: 'critdmg',  name: 'EXECUTION',     icon: '☓', type: 'pas', max: 5, desc: '+70% crit damage',         apply: (s, p) => { p.mods.critMult += 0.7; } },
  { id: 'pierce',   name: 'PENETRATOR',    icon: '➤', type: 'pas', max: 3, desc: 'Shots pass through +1',    apply: (s, p) => { p.mods.pierce += 1; } },
  { id: 'bounce',   name: 'RICOCHET',      icon: '⤢', type: 'pas', max: 3, desc: 'Shots bounce +2',          apply: (s, p) => { p.mods.bounces += 2; } },
  { id: 'split',    name: 'FORK',          icon: 'Y', type: 'pas', max: 1, desc: 'Shots split on first hit', apply: (s, p) => { p.mods.split = 1; } },
  { id: 'boom',     name: 'DETONATOR',     icon: '✸', type: 'pas', max: 4, desc: 'Kills explode (+35)',      apply: (s, p) => { p.mods.explosive += 35; } },
  { id: 'overkill', name: 'PASS-THROUGH',  icon: '⇉', type: 'pas', max: 3, desc: 'Overkill carries onward',  apply: (s, p) => { p.mods.overkill += 0.5; } },
  { id: 'steal',    name: 'VAMPIRE',       icon: '♥', type: 'pas', max: 4, desc: 'Crits heal you (+3)',      apply: (s, p) => { p.mods.lifesteal += 3; } },
  { id: 'dash3',    name: 'THIRD WIND',    icon: '»', type: 'pas', max: 2, desc: '+1 dash charge',           apply: (s, p) => { p.mods.dashExtra += 1; p.dashCharge++; } },
  { id: 'dashdmg',  name: 'BURN TRAIL',    icon: '⌇', type: 'pas', max: 3, desc: 'Dash burns what it touches', apply: (s, p) => { p.mods.dashTrail += 1.6; } },
  { id: 'aura',     name: 'COLD FIELD',    icon: '❄', type: 'pas', max: 3, desc: 'Slow nearby enemies',      apply: (s, p) => { p.mods.slowAura += 5; } },
  { id: 'thorns',   name: 'SPIKED PLATE',  icon: '⌘', type: 'pas', max: 3, desc: 'Hurt what touches you',    apply: (s, p) => { p.mods.thorns += 30; } },
  { id: 'speed',    name: 'LIGHT FRAME',   icon: '↯', type: 'pas', max: 4, desc: '+12% move speed',          apply: (s, p) => { p.mods.moveSpeed *= 1.12; } },
  { id: 'shield',   name: 'HARD SHELL',    icon: '◘', type: 'pas', max: 5, desc: '+30 shield',               apply: (s, p) => { p.mods.shieldBonus += 30; p.shield += 30; } },
  { id: 'magnet',   name: 'COLLECTOR',     icon: '◍', type: 'pas', max: 3, desc: '+70% pickup range',        apply: (s, p) => { p.mods.magnet *= 1.7; } },
  { id: 'combo',    name: 'BLOODRUSH',     icon: '▲', type: 'pas', max: 3, desc: 'Combo ramps fire rate more', apply: (s, p) => { p.mods.comboRamp += 1; } },
  { id: 'stagger',  name: 'CONCUSSION',    icon: '◙', type: 'pas', max: 1, desc: 'Crits stagger enemies',    apply: (s, p) => { p.mods.stagger = 1; } },
  { id: 'projspd',  name: 'HOT LOADS',     icon: '→', type: 'pas', max: 3, desc: '+30% projectile speed',    apply: (s, p) => { p.mods.projSpeed *= 1.3; } },
  { id: 'brace',    name: 'STABILISER',    icon: '⊟', type: 'pas', max: 3, desc: '-25% spread and recoil',   apply: (s, p) => { p.mods.spread *= 0.75; p.mods.recoil *= 0.75; } },
  { id: 'impact',   name: 'IMPACT ROUNDS', icon: '⇱', type: 'pas', max: 3, desc: '+45% knockback',           apply: (s, p) => { p.mods.knock *= 1.45; } },

  // Weapons arrive as choices, so a build can commit to one.
  { id: 'w1', name: 'BREACHER',     icon: '⌂', type: 'act', max: 1, desc: 'Unlock: close-range shotgun', apply: (s, p) => s.unlockWeapon(p, 1) },
  { id: 'w2', name: 'LANCE',        icon: '⌁', type: 'act', max: 1, desc: 'Unlock: piercing railgun',    apply: (s, p) => s.unlockWeapon(p, 2) },
  { id: 'w3', name: 'RICOCHET GUN', icon: '⤨', type: 'act', max: 1, desc: 'Unlock: bouncing shots',      apply: (s, p) => s.unlockWeapon(p, 3) },
  { id: 'w4', name: 'TORCH',        icon: '♨', type: 'act', max: 1, desc: 'Unlock: burning short-range', apply: (s, p) => s.unlockWeapon(p, 4) },
  { id: 'w5', name: 'THUMPER',      icon: '☄', type: 'act', max: 1, desc: 'Unlock: arcing explosive',    apply: (s, p) => s.unlockWeapon(p, 5) },

  // Always available, so a deep run can never be offered an empty choice.
  { id: 'repair', name: 'FIELD REPAIR', icon: '+', type: 'pas', max: 99, desc: 'Restore 45 health', apply: (s, p) => s.healPlayer(p, 45) }
];

export const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map(u => [u.id, u]));

/** Offer three, weighted so a build gets deeper instead of wider.
 *  `rng` must be the simulation's seeded generator when this runs online, so
 *  every client is offered the same cards. */
export function offerUpgrades(rng, player, abilities, count = 3) {
  const taken = player.taken || {};
  const pool = UPGRADES.filter(u => (taken[u.id] || 0) < u.max && u.id !== 'repair');

  // Synergy weighting: something you already own is more likely to appear
  // again, which is how a run develops an identity instead of a shopping list.
  const weighted = [];
  for (const u of pool) {
    const owned = taken[u.id] || 0;
    const w = 1 + owned * 0.6;
    for (let i = 0; i < Math.ceil(w * 2); i++) weighted.push(u);
  }

  const out = [];
  const seen = new Set();
  let guard = 0;
  while (out.length < count && guard++ < 200) {
    const u = rng.pick(weighted);
    if (!u || seen.has(u.id)) continue;
    seen.add(u.id);
    out.push({ kind: 'upgrade', id: u.id, name: u.name, icon: u.icon, type: u.type, desc: u.desc, owned: taken[u.id] || 0 });
  }
  while (out.length < count) {
    out.push({ kind: 'upgrade', id: 'repair', name: 'FIELD REPAIR', icon: '+', type: 'pas', desc: 'Restore 45 health', owned: 0 });
  }

  // Offer an ability while a slot is free — actives define a build's shape.
  const freeSlot = player.abilities.indexOf(null);
  if (freeSlot >= 0) {
    const owned = player.abilities.filter(Boolean).map(a => a.def.id);
    const avail = abilities.filter(a => owned.indexOf(a.id) < 0);
    if (avail.length) {
      const ab = rng.pick(avail);
      out[0] = { kind: 'ability', id: ab.id, name: ab.name, icon: ab.icon, type: 'act', desc: ab.desc, owned: 0, slot: freeSlot };
    }
  }
  return rng.shuffled(out);
}
