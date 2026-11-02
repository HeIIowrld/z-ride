import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createEventLedger} from '../event-ledger.mjs';
import {createGameStateService} from '../game-state.mjs';

function room(id){return {roomId:id,state:'READY',roomEpoch:1,collection:{inventory:{supplies:0}},stats:{kills:0},
  members:new Map([['h',{memberId:id+'h',role:'CAR_HOST',seat:'DRIVER',approved:true}],['a',{memberId:id+'a',role:'REAR_LEFT',seat:'REAR_LEFT',approved:true}],['b',{memberId:id+'b',role:'REAR_RIGHT',seat:'REAR_RIGHT',approved:true}]]),
  game:createGameStateService().initial('signal-puzzle-v1')};}
function complete(ledger,r){
  const service=createGameStateService();r.state='PLAYING';
  const ctx=member=>({roomId:r.roomId,roomEpoch:r.roomEpoch,state:r.state,gate:{allowed:true},connectionId:'host',role:member.role,memberId:member.memberId,members:[...r.members.values()]});
  const body=()=>({commandId:randomUUID(),roomEpoch:r.roomEpoch,expectedGameRevision:r.game.revision});
  while(!r.game.completed){
    for(const m of [...r.members.values()].filter(m=>m.role!=='CAR_HOST')){service.interact(r.game,ctx(m),{...body(),objectiveId:r.game.objectiveState.objectiveId,action:'INTERACT'});ledger.observe(r);}
    service.advance(r.game,ctx(r.members.get('h')),body());if(r.game.completed)r.state='CLEARED';ledger.observe(r);
  }
}
test('non-zombie results, party contributions, reward settlement and fresh cycles are durable and idempotent',()=>{
  let now=100000;const options={clock:()=>now,durationMs:5000,respawnMs:1000,target:2};let s=createEventLedger(options);
  const a=room('a'),b=room('b'),c=room('c');
  const joined=s.join(a,{commandId:'join-a',spotId:'p',expectedInstanceId:null}),id=joined.instance.instanceId;
  s.join(b,{commandId:'join-b',spotId:'p',expectedInstanceId:id});s.join(c,{commandId:'join-c',spotId:'p',expectedInstanceId:id});complete(s,a);complete(s,b);
  const result=s.results(a).results[0];assert.equal(result.outcome,'SUCCEEDED');assert.equal(result.contributions.length,4);assert.equal(result.participants.length,3);
  const body={commandId:'contrib-a',spotId:'p',instanceId:id,expectedInstanceRevision:0};s.contribute(a,body,true);
  assert.throws(()=>s.contribute(b,{...body,commandId:'contrib-b'},true),{code:'INSTANCE_REVISION_CONFLICT'});
  const finished=s.contribute(b,{...body,commandId:'contrib-b',expectedInstanceRevision:1},true);
  assert.equal(finished.instance.outcome,'SUCCEEDED');assert.equal(finished.instance.phase,'COOLDOWN');
  s.observe(c);assert.equal(s.results(c).results[0].outcome,'CANCELLED');assert.equal(s.rewards(c).awards.length,0);assert.throws(()=>s.assertPlayable(c),{code:'EVENT_NOT_ACTIVE'});
  assert.equal(s.rewards(a).awards.length,2);
  const claims=s.rewards(a).awards.map((award,i)=>({commandId:'reward-'+i,awardId:award.awardId}));
  for(const claim of claims)s.claim(a,claim);assert.equal(a.collection.inventory.supplies,3);
  assert.equal(s.claim(a,claims[0]).replayed,true);assert.equal(a.collection.inventory.supplies,3);
  assert.throws(()=>s.claim(a,{...claims[0],commandId:'new-id'}),{code:'REWARD_ALREADY_CLAIMED'});
  assert.throws(()=>s.claim(b,{...claims[0],commandId:'foreign'}),{code:'REWARD_NOT_FOUND'});
  const saved=s.durable();s=createEventLedger(options);s.restore(saved);
  assert.equal(s.results(a).results[0].resultId,result.resultId);assert.equal(s.claim(a,claims[0]).replayed,true);
  now+=1000;assert.equal(s.due(),true);assert.equal(s.tick(),true);assert.equal(s.tick(),false);
  const fresh=s.current('p');assert.notEqual(fresh.instanceId,id);assert.equal(fresh.cycle,2);assert.equal(fresh.contributions.length,0);
  assert.equal(s.contribute(a,body,false).replayed,true); // old successful receipt never becomes a new contribution
  assert.throws(()=>s.contribute(a,{...body,commandId:'delayed'},true),{code:'EVENT_INSTANCE_CONFLICT'});
  assert.throws(()=>s.join(a,{commandId:'old-clear',spotId:'p',expectedInstanceId:fresh.instanceId}),{code:'EVENT_MISSION_REQUIRED'});
  assert.equal(s.durable().instances[id].completed,true);
  assert.equal(s.rewards(a).awards.filter(a=>a.status==='CLAIMED').length,2);
});

test('expiry, cancellation, downtime and legacy migration cannot mint completion rewards',()=>{
  let now=10000;const options={clock:()=>now,durationMs:1000,respawnMs:1000,target:1};let s=createEventLedger(options);const a=room('a');
  const old=s.join(a,{commandId:'join',spotId:'p',expectedInstanceId:null}).instance;
  now+=1000;s.tick();assert.equal(s.results(a).results[0].outcome,'EXPIRED');assert.equal(s.rewards(a).awards.length,0);
  assert.throws(()=>s.assertPlayable(a),{code:'EVENT_NOT_ACTIVE'});
  now+=100000;s.tick();assert.equal(s.current('p').cycle,2);assert.equal(s.current('p').expiresAt,now+1000);
  a.game=createGameStateService().initial('supply-run-v1');s.observe(a);a.game=createGameStateService().initial('generic-coop-v1');s.observe(a);
  assert.ok(s.results(a).results.some(r=>r.outcome==='CANCELLED'));assert.equal(s.rewards(a).awards.length,0);
  s=createEventLedger(options);s.restore(null,{p:{instanceId:'legacy',spotId:'p',revision:3,target:3,contributions:[{partyId:'a'}],completed:true}});
  assert.equal(s.current('p').outcome,'SUCCEEDED');assert.equal(s.rewards(a).awards.length,0);
  now+=1000;s.tick();assert.notEqual(s.current('p').instanceId,'legacy');assert.equal(s.current('p').cycle,2);
  const oldRoom=room('legacy-room');oldRoom.closedAt=now;oldRoom.game.completed=true;oldRoom.game.stageId='COMPLETE';s.restoreRoom(oldRoom);assert.equal(s.results(oldRoom).results[0].outcome,'SUCCEEDED');assert.equal(s.rewards(oldRoom).awards.length,0);
});
