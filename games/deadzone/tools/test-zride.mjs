import assert from 'node:assert/strict';
import { Sim } from '../packages/shared/src/sim.js';
import { partySize, difficultyFor, dashboardSnapshot } from '../packages/shared/src/zride.js';
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
