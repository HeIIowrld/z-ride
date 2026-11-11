import assert from 'node:assert/strict';
import { Sim } from '../packages/shared/src/sim.js';
import { Reader, encodeSnapshot, decodeSnapshot } from '../packages/shared/src/protocol.js';
import { DEFENSE_WAVES, TRUNK_Z } from '../packages/shared/src/vehicle-defense.js';
import { dashboardSnapshot } from '../packages/shared/src/zride.js';

const dt = 1 / 20;
function mission(partySize = 1) {
  const sim = new Sim({ seed: 19, mode: 'coop', vehicleDefense: true, partySize });
  const player = sim.addPlayer(1, { name: 'TEST' });
  sim.director.startWave();
  return { sim, player, defense: sim.defense };
}

const { sim, player, defense } = mission();
const pickup = sim.pickups.find(p => p.alive && p.kind === 'fuse');
Object.assign(player, { x: pickup.x, z: pickup.z });
sim.step(dt);
assert.deepEqual(defense.snapshot().carriers, [player.id]);
const packet = new Reader(encodeSnapshot(sim.snapshot()));
packet.u8();
const decoded = decodeSnapshot(packet);
assert.deepEqual(decoded.defense, defense.snapshot());
assert.ok(decoded.pickups.some(p => p.k === 'fuse'));
assert.equal(defense.use(player, 'headlights'), false, 'requires a fuse in the trunk and proximity');

Object.assign(player, { x: 0, z: TRUNK_Z });
sim.step(dt);
assert.equal(defense.fuses, 1);
assert.equal(defense.carriers.size, 0);
assert.equal(defense.use(player, 'repair'), false, 'repair at full health keeps the fuse');

const attacker = sim.spawnEnemy('rusher', 0, -3.25);
attacker.spawnT = attacker.atkCd = 0;
sim.step(dt);
assert.ok(defense.hp < defense.snapshot().maxHp, 'a melee zombie attacks the car');
assert.equal(defense.use(player, 'repair'), true);
assert.equal(defense.hp, defense.snapshot().maxHp);
assert.equal(defense.use(player, 'repair'), false, 'a second request cannot spend the same fuse');

const spare = sim.pickups.find(p => p.alive && p.kind === 'fuse');
Object.assign(player, { x: spare.x, z: spare.z });
sim.step(dt);
player.connected = false;
sim.step(dt);
assert.equal(defense.carriers.size, 0);
assert.ok(sim.pickups.some(p => p.alive && p.kind === 'fuse'), 'a disconnect drops the carried fuse');
player.connected = true;
sim.step(dt);
Object.assign(player, { x: 0, z: TRUNK_Z });
sim.step(dt);
assert.equal(defense.use(player, 'headlights'), true);
attacker.atkCd = 0;
sim.step(dt);
assert.ok(attacker.staggerT > 0);
assert.equal(defense.hp, defense.snapshot().maxHp);
const status = dashboardSnapshot({ code: 'TEST', state: 'playing', targetPlayers: 1 }, sim, [player]);
assert.deepEqual(status.defense, sim.snapshot().defense);
assert.equal(status.vehicle.parked, null);

const lost = mission();
lost.defense.hp = 1;
const breaker = lost.sim.spawnEnemy('rusher', 0, -3.25);
breaker.spawnT = breaker.atkCd = 0;
lost.sim.step(dt);
assert.equal(lost.sim.over?.reason, 'vehicle_destroyed');

for (let size = 1; size <= 4; size++) {
  const { sim } = mission(size);
  // Drive the director through its ordinary clear/choice flow.
  for (let i = 0; i < 2000 && !sim.over; i++) {
    sim.world.animate(dt);
    for (const e of sim.enemies) {
      if (e.alive) sim.hurtEnemy(e, 10000, e.x, e.z, 0, false, sim.players[0], true);
    }
    sim.step(dt);
    if (sim.director.phase === 'choice') sim.director.startWave();
    sim.events.drain(() => {});
  }
  assert.equal(sim.director.wave, DEFENSE_WAVES);
  assert.equal(sim.over?.reason, 'vehicle_defended');
}

const legacy = new Reader(encodeSnapshot(new Sim().snapshot()));
legacy.u8();
assert.equal(decodeSnapshot(legacy).defense, null);
console.log('PASS vehicle defense: carrying, delivery, repair, headlights, disconnect, loss, three-wave win for 1–4 and wire/dashboard compatibility');
