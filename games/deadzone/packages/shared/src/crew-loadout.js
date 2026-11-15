import { ABILITY_BY_ID } from './abilities.js';
import { WEAPON_BY_ID } from './defs.js';

const VEHICLE_SKINS = { paint_rain_pattern: 10, paint_neon_grid: 13 };

export function applyCrewLoadout(sim, player, loadout) {
  if (!loadout) return;
  for (const [key, value] of Object.entries(loadout.mods ?? {})) {
    if (Object.hasOwn(player.mods, key)) player.mods[key] = value;
  }
  for (const name of loadout.startWeapons) {
    const weapon = WEAPON_BY_ID[name];
    if (weapon) sim.unlockWeapon(player, weapon.slot);
  }
  if (loadout.startAbility) sim.grantAbility(player, loadout.startAbility, 0);
  if (Object.hasOwn(VEHICLE_SKINS, loadout.skin)) player.skin = VEHICLE_SKINS[loadout.skin];
  player.shield = player.maxShield + player.mods.shieldBonus;
}

export function reinforceCrewVehicle(sim, loadout) {
  if (!sim.sharedVehicle || !loadout) return;
  const mods = loadout.mods ?? {};
  const vehicle = sim.sharedVehicle;
  vehicle.maxHp += (mods.shieldBonus ?? 0) + (mods.dashExtra ?? 0) * 15;
  vehicle.hp = vehicle.maxHp;
  vehicle.crewIFrameScale = Math.max(1, mods.moveSpeed ?? 1);
  vehicle.crewThorns = mods.thorns ?? 0;
  // Recovered power and spare parts improve the opening weapons' damage.
  for (const player of sim.players) player.mods.dmg *= 1 + (loadout.startCredits ?? 0) / 200;
}

function repairAmount(kind) {
  return kind === 'medkit' ? 35 : kind === 'shieldRefill' ? 45 : 0;
}

export function canUseCrewConsumable(sim, player, kind) {
  if (!sim?.sharedVehicle || sim.over || !player?.alive) return false;
  if (repairAmount(kind)) return sim.sharedVehicle.hp < sim.sharedVehicle.maxHp;
  return ['surge', 'bubble', 'flare'].includes(kind);
}

export function applyCrewConsumable(sim, player, kind) {
  if (!canUseCrewConsumable(sim, player, kind)) return false;
  const amount = repairAmount(kind);
  if (amount) {
    const vehicle = sim.sharedVehicle;
    vehicle.hp = Math.min(vehicle.maxHp, vehicle.hp + amount);
    for (const rider of sim.players) rider.hp = rider.maxHp * vehicle.hp / vehicle.maxHp;
  } else if (kind === 'flare') {
    for (const enemy of sim.enemies) {
      if (enemy.alive) enemy.staggerT = Math.max(enemy.staggerT ?? 0, 2);
    }
  } else {
    ABILITY_BY_ID[kind === 'surge' ? 'shock' : 'bubble'].cast(sim, player);
  }
  return true;
}
