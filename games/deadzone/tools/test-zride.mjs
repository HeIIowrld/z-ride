import assert from 'node:assert/strict';
import { Sim } from '../packages/shared/src/sim.js';
import { partySize, difficultyFor, dashboardSnapshot } from '../packages/shared/src/zride.js';
import { CABIN, HULL, VEHICLE_SEATS, hullImpact, vehiclePoint, vehiclePose, windowMuzzle } from '../packages/shared/src/vehicle.js';
import { MSG, Reader, decodeSnapshot, encodeSnapshot } from '../packages/shared/src/protocol.js';
for(const invalid of [0,5,1.5,NaN,undefined,'garbage'])assert.throws(()=>partySize(invalid));
for(let n=1;n<=4;n++){
 const sim=new Sim({seed:42,mode:'coop',partySize:n});
 sim.addPlayer(1,{name:'생존자'});sim.director.startWave();
 assert.equal(sim.director.credits,4*difficultyFor(n).spawnMultiplier);
 // Locked room difficulty must not drop when a teammate disconnects.
 sim.players[0].connected=false;sim.director.wave=0;sim.director.startWave();
 assert.equal(sim.director.credits,4*difficultyFor(n).spawnMultiplier);
 const s=dashboardSnapshot({code:'TEST22',state:'playing',targetPlayers:n},sim,[{id:1,name:'생존자',connected:false,ready:true}],123);
 assert.equal(s.targetPlayers,n);assert.equal(s.timestamp,123);assert.equal(s.connectedPlayers,0);
 assert.equal(s.vehicle.parked,null);assert.equal(s.vehicle.controlsEnabled,false);
 assert.equal(s.schema,'zride.dashboard.v1');
}
console.log('PASS: 1–4 players, fixed difficulty, invalid counts, dashboard projection, vehicle signal boundaries');

const vehicle = new Sim({seed:42,mode:'coop',partySize:3,authoritative:true,sharedVehicle:true});
for (const [index, seat] of Object.keys(VEHICLE_SEATS).entries()) {
  const rider = vehicle.addPlayer(index + 1, { name: seat });
  rider.partySeat = seat;
  vehicle.setInput(rider.id, { mx: 1, mz: 1, dash: true, ax: 0, az: 1 });
}
vehicle.step(1 / 60);
const pose = vehiclePose(vehicle.matchTime);
for (const rider of vehicle.players) {
  const seat = VEHICLE_SEATS[rider.partySeat];
  assert.deepEqual({ x: rider.x, z: rider.z }, vehiclePoint(pose, seat.x, seat.z));
}
const firingPose = vehiclePose(0);
const forward = windowMuzzle('FRONT_PASSENGER', 0, 0, 1);
assert.deepEqual(forward, vehiclePoint(firingPose, VEHICLE_SEATS.FRONT_PASSENGER.x, CABIN.halfLength + .08));
assert(windowMuzzle('REAR_LEFT', 0, .707, -.707));
assert(windowMuzzle('REAR_RIGHT', 0, -.707, -.707));
assert.equal(windowMuzzle('FRONT_PASSENGER', 0, 1, 0), null, 'Opposite side bodywork blocks a shot within the front sector');
assert.equal(windowMuzzle('FRONT_PASSENGER', 0, 0, -1), null, 'Rear shot is outside the front sector');
assert.equal(windowMuzzle('REAR_LEFT', 0, .48, -.62), null, 'Window frame blocks the corner');

vehicle.matchTime = 0;
const rider = vehicle.players[0];
rider.input.fire = true;
rider.aimA = 0;
vehicle.firePlayer(rider, .05);
assert.equal(rider.shotsFired, 0);
rider.aimA = Math.PI / 2;
vehicle.firePlayer(rider, .05);
assert(rider.shotsFired > 0);
assert(vehicle.projectiles.filter(p => p.alive).every(p => p.z > CABIN.halfLength));
assert.deepEqual(hullImpact(firingPose, 5, 4, 5, 0), { x: 5, z: HULL.halfLength });
assert.equal(hullImpact(firingPose, 7, 4, 7, 0), null);
vehicle.spawnProjectile({x:5,z:3,vx:0,vz:-10,def:{dmg:10},hostile:true});
vehicle.stepProjectiles(.2);
assert.equal(vehicle.sharedVehicle.hp, 290);
const frame = new Reader(encodeSnapshot(vehicle.snapshot()));
assert.equal(frame.u8(), MSG.SNAPSHOT);
assert.deepEqual(decodeSnapshot(frame).vehicle, { hp: 290, maxHp: 300 });
const foot = new Reader(encodeSnapshot(new Sim({seed:42,mode:'coop'}).snapshot()));
foot.u8();
assert.equal(decodeSnapshot(foot).vehicle, undefined);
console.log('PASS: mounted positions, window firing, bodywork occlusion and chassis damage');
