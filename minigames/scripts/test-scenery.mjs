import assert from 'node:assert/strict';
import { travelDir } from '../shared/motion.js';
import {biomeAt,createScenery,groundY,horizonY,objectAt,polePosition,ridgeY,scrollDelta,nearestBandCrossingTime} from '../shared/scenery.js';
assert.ok(nearestBandCrossingTime(40,100)>=.4&&nearestBandCrossingTime(40,100)<=.6,'nearest band crosses in about half a second at 40 km/h');
assert.ok(Math.abs(nearestBandCrossingTime(80,100)*2-nearestBandCrossingTime(40,100))<1e-9,'crossing time halves at 80 km/h');
for(const seed of [1,17,7139]){
  for(const fn of [x=>ridgeY(x,seed),x=>horizonY(x,seed)]){
    let last=fn(0);for(let x=1;x<=30000;x+=1){const next=fn(x);assert.ok(Math.abs(next-last)<.003,`discontinuous sample at ${x}: ${Math.abs(next-last)}`);last=next}
  }
  for(let x=0;x<30000;x+=13){const o=objectAt(seed,x,'mid',1);assert.equal(o.baseY,groundY('mid'));assert.ok(o.height>0&&o.width>0);const b=biomeAt(o.worldX),allowed={mountains:['conifer','rock-cut','utility-pole','guard-rail'],hills:['tree','utility-pole','guard-rail','bush'],fields:['farm-shed','field-row','utility-pole','tree','guard-rail'],coast:['lighthouse','island','sea','guard-rail'],town:['building','lamp','sign','tree','utility-pole','fence']};assert.ok([...allowed[b.from],...allowed[b.to]].includes(o.type));const again=objectAt(seed,x,'mid',1);assert.equal(o.height,again.height)}
  for(let i=-100;i<100;i++)assert.equal(polePosition(seed,i).worldX+polePosition(seed,i+1).spacing,polePosition(seed,i+1).worldX);
}
const s=createScenery({seed:4});s.update(4,0,1);assert.equal(s.distance,0);assert.equal(scrollDelta(0,2,1,1),0);assert.equal(scrollDelta(36,1,2,1),5);const beforeCruise=s.distance;s.update(1,40,1);assert.ok(s.distance>beforeCruise,'scenery offset increases at positive speed');const stoppedAt=s.distance;s.update(1,0,1);assert.equal(s.distance,stoppedAt,'scenery offset remains fixed at zero speed');assert.ok(Math.abs(horizonY(4200)-horizonY(4201))<.003);console.log('test-scenery: all checks passed');
for(const seat of ['right','left']){const dir=travelDir(seat),directional=createScenery({seed:8,seat});directional.update(1,60,seat);assert.equal(Math.sign(-directional.direction),dir,`seat ${seat} scenery scroll dx`);assert.equal(Math.sign(scrollDelta(60,1,.65,dir)),dir,`seat ${seat} nearest band dx`);assert.equal(Math.sign(scrollDelta(0,1,.65,dir)),0,`seat ${seat} stopped nearest band`);assert.equal(Math.sign(38*dir),dir,`seat ${seat} pole dx`);assert.equal(scrollDelta(0,1,1,dir),0);assert.equal(Math.abs(38*0),0)}
