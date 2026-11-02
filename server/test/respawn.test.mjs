import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createWorldService} from '../world.mjs';
import {createDemoServer} from '../server.mjs';

test('party respawn crosses midnight, rejects stale cycles and replays old receipts without rewards',()=>{
  let now=Date.parse('2026-11-02T23:59:59.500Z');
  const world=createWorldService({clock:()=>now,respawnMs:1000});
  const room={partyWorldClaims:new Map(),partyPickupClaims:new Set(),partyPickupRespawns:new Map(),collectionRevision:0,collection:{inventory:{supplies:0}}};
  const a={memberId:'a'},b={memberId:'b'},query={latitude:37.5665,longitude:126.978,radiusM:500};
  const list=world.nearby(room,a,query),spawn=list.spawns[0];
  const body={commandId:randomUUID(),spawnId:spawn.spawnId,version:spawn.version,spawnCycleId:spawn.spawnCycleId,scheduleId:list.scheduleId,passengerConfirmed:true,location:{latitude:spawn.latitude,longitude:spawn.longitude,accuracyM:5,measuredAgeMs:10,source:'EMULATOR_GPS',isMock:true}};
  world.claim(room,a,body);world.consumeFixture(room,'DEMO_PICKUP_A');
  assert.ok(!world.nearby(room,b,query).spawns.some(p=>p.spawnId===spawn.spawnId));
  now+=600; // A new UTC schedule must not bypass the remaining cooldown.
  assert.throws(()=>world.claim(room,b,{...body,commandId:randomUUID(),scheduleId:world.nearby(room,b,query).scheduleId}),{code:'ALREADY_CLAIMED'});
  assert.equal(world.tick(room),false);
  now+=400;
  assert.equal(world.tick(room),true);assert.equal(world.tick(room),false);
  assert.equal(room.partyPickupClaims.has('DEMO_PICKUP_A'),false);
  const fresh=world.nearby(room,b,query),next=fresh.spawns.find(p=>p.spawnId===spawn.spawnId);
  assert.ok(next);assert.notEqual(next.spawnCycleId,body.spawnCycleId);
  assert.throws(()=>world.claim(room,b,{...body,commandId:randomUUID(),scheduleId:fresh.scheduleId}),{code:'SPAWN_CYCLE_CONFLICT'});
  assert.equal(world.claim(room,a,body).replayed,true);assert.equal(room.collection.inventory.supplies,1);
  world.claim(room,b,{...body,commandId:randomUUID(),scheduleId:fresh.scheduleId,spawnCycleId:next.spawnCycleId});
  assert.equal(room.collection.inventory.supplies,2);
  assert.throws(()=>world.claim(room,a,{...body,commandId:randomUUID(),scheduleId:fresh.scheduleId,spawnCycleId:next.spawnCycleId}),{code:'ALREADY_CLAIMED'});
  world.consumeFixture(room,'DEMO_PICKUP_A');assert.throws(()=>world.consumeFixture(room,'DEMO_PICKUP_A'),{code:'ALREADY_COLLECTED'});
});

test('server restart preserves respawn deadline and timer publishes one invalidation after expiry',async()=>{
  let now=Date.now(),saved=null,app,base;const messages=[];
  const store={kind:'fixture',load:()=>saved,save:v=>{saved=structuredClone(v);},close(){}};
  const start=async()=>{app=createDemoServer({stateStore:store,worldClock:()=>now,pickupRespawnMs:1000});const a=await app.listen(0);base=`http://127.0.0.1:${a.port}`;};
  const api=async(path,body,token)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return r.json();};
  await start();let ws;
  try{
    const host=await api('/api/session',{role:'CAR_HOST',nickname:'Respawn host'}),room=await api('/api/rooms',{},host.token);
    const phone=await api('/api/session',{role:'PHONE',nickname:'Respawn phone'}),joined=await api('/api/join',{joinCode:room.joinCode,seat:'REAR_LEFT'},phone.token);
    await api('/api/rooms/'+room.roomId+'/approve',{memberId:joined.memberId},host.token);
    const query={latitude:37.5665,longitude:126.978,radiusM:500},list=await api('/api/world/nearby',query,phone.token),p=list.spawns[0];
    const body={commandId:randomUUID(),spawnId:p.spawnId,version:p.version,spawnCycleId:p.spawnCycleId,scheduleId:list.scheduleId,passengerConfirmed:true,location:{latitude:p.latitude,longitude:p.longitude,accuracyM:5,measuredAgeMs:10,source:'EMULATOR_GPS',isMock:true}};
    await api('/api/world/claim',body,phone.token);const deadline=saved.rooms[0].partyWorldClaims[0][1].respawnAt;
    await app.close();now+=500;await start();
    const hidden=await api('/api/world/nearby',{...query,includeClaimed:true},phone.token);
    assert.equal(hidden.spawns.find(s=>s.spawnId===p.spawnId).respawnAt,deadline);
    assert.equal(hidden.spawns.find(s=>s.spawnId===p.spawnId).claimed,true);
    const {WebSocket}=await import('ws');ws=new WebSocket(base.replace('http','ws')+'/ws');
    ws.on('message',bytes=>messages.push(JSON.parse(bytes)));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
    ws.send(JSON.stringify({type:'auth',token:phone.token,roomId:room.roomId}));
    now=deadline;const end=Date.now()+3000;while(!messages.some(m=>m.type==='collection.changed')&&Date.now()<end)await new Promise(r=>setTimeout(r,20));
    assert.equal(messages.filter(m=>m.type==='collection.changed').length,1);
    const visible=await api('/api/world/nearby',query,phone.token);assert.ok(visible.spawns.some(s=>s.spawnId===p.spawnId));
    assert.equal(saved.rooms[0].collection.inventory.supplies,1);
  }finally{ws?.terminate();await app.close();}
});
