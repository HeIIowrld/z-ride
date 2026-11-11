// Z-RIDE vehicle defense mission. Apache-2.0.
import { FlowField } from './ai.js';
import { EV } from './events.js';

export const DEFENSE_WAVES = 3;
export const VEHICLE_HALF_WIDTH = 1.45;
export const VEHICLE_HALF_LENGTH = 2.65;
export const TRUNK_Z = 3.75;
const MAX_HP = 200;
const REPAIR_HP = 40;
const FLASH_SECONDS = 3;
const CENTER = [{ x: 0, z: 0 }];

export function nearTrunk(p) {
  return Math.hypot(p.x, p.z - TRUNK_Z) <= 2;
}

export function keepOutOfVehicle(p, radius) {
  const dx = VEHICLE_HALF_WIDTH + radius - Math.abs(p.x);
  const dz = VEHICLE_HALF_LENGTH + radius - Math.abs(p.z);
  if (dx <= 0 || dz <= 0) return;
  if (dx < dz) p.x += p.x < 0 ? -dx : dx;
  else p.z += p.z < 0 ? -dz : dz;
}

function inHeadlights(e) {
  const forward = -e.z - VEHICLE_HALF_LENGTH;
  return forward >= 0 && forward <= 15 && Math.abs(e.x) <= 2.2 + forward * 0.62;
}

export class VehicleDefense {
  constructor(radius) {
    this.hp = MAX_HP;
    this.fuses = 0;
    this.carriers = new Set();
    this.flash = 0;
    this.flow = new FlowField(radius);
    this.meleeSpawns = 0;
  }

  startWave(sim) {
    this.meleeSpawns = 0;
    this.pathRefresh = 0.85;
    this.rebuildPath(sim.world);
    const count = sim.partySize >= 3 ? 3 : 2;
    for (let i = 0; i < count; i++) {
      const angle = (i + (sim.director.wave - 1) / DEFENSE_WAVES) * Math.PI * 2 / count;
      // The center is clear of cover. Keep the supplies outside the parking bay.
      this.dropFuse(sim, Math.cos(angle) * 6.4, Math.sin(angle) * 6.4);
    }
  }

  dropFuse(sim, x, z) {
    const pickup = sim.addPickup('fuse', x, z, 0);
    if (pickup) pickup.vx = pickup.vz = 0;
  }

  assignTarget(key) {
    return (key === 'rusher' || key === 'bruiser') && this.meleeSpawns++ % 2 === 0;
  }

  rebuildPath(world) {
    this.flow.bakeCost(world);
    this.flow.build(CENTER);
  }

  steer(e, world, out) {
    if (Math.hypot(e.x, e.z) > 7 || !world.lineOfSight(e.x, e.z, 0, 0)) {
      this.flow.sample(e.x, e.z, out);
      if (out.x || out.z) return;
    }
    const distance = Math.hypot(e.x, e.z) || 1;
    out.x = -e.x / distance;
    out.z = -e.z / distance;
  }

  attack(e, dt) {
    e.atkCd -= dt;
    if (e.atkCd > 0 || e.spawnT > 0 || e.staggerT > 0) return;
    const edgeX = Math.max(0, Math.abs(e.x) - VEHICLE_HALF_WIDTH);
    const edgeZ = Math.max(0, Math.abs(e.z) - VEHICLE_HALF_LENGTH);
    if (Math.hypot(edgeX, edgeZ) > e.r + 0.45) return;
    e.atkCd = 0.95;
    this.hp = Math.max(0, this.hp - e.def.dmg);
  }

  step(sim, dt) {
    if (this.pathRefresh > 0) {
      this.pathRefresh -= dt;
      if (this.pathRefresh <= 0) this.rebuildPath(sim.world);
    }
    this.flash = Math.max(0, this.flash - dt);
    for (const id of this.carriers) {
      const p = sim.playerById(id);
      if (!p || !p.connected || !p.alive || p.down) {
        this.carriers.delete(id);
        this.dropFuse(sim, p?.x ?? 0, p?.z ?? TRUNK_Z);
      } else if (nearTrunk(p)) {
        this.carriers.delete(id);
        this.fuses++;
        sim.events.push(EV.PICKUP, { id, kind: 'fuse_stored', x: p.x, z: p.z });
      }
    }
  }

  use(p, action) {
    if (!p?.connected || !p.alive || p.down || !nearTrunk(p) || this.fuses === 0 || this.hp <= 0) return false;
    if (action === 'repair' && this.hp < MAX_HP) this.hp = Math.min(MAX_HP, this.hp + REPAIR_HP);
    else if (action === 'headlights' && this.flash <= 0) this.flash = FLASH_SECONDS;
    else return false;
    this.fuses--;
    return true;
  }

  stun(e) {
    if (this.flash > 0 && inHeadlights(e)) e.staggerT = Math.max(e.staggerT, 0.15);
  }

  result(director) {
    if (this.hp <= 0) return { winner: null, reason: 'vehicle_destroyed' };
    if (director.wave === DEFENSE_WAVES && director.phase === 'valley') {
      return { winner: 0, reason: 'vehicle_defended' };
    }
    return null;
  }

  snapshot() {
    return {
      hp: Math.ceil(this.hp), maxHp: MAX_HP, fuses: this.fuses,
      flash: Math.ceil(this.flash * 10) / 10, carriers: [...this.carriers]
    };
  }
}
