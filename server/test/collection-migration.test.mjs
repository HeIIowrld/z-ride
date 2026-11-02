import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDemoServer} from '../server.mjs';
test('legacy departed-member claims migrate into party-once ledger without changing inventory',async()=>{
  let saved=null,app;const store={kind:'fixture',load:()=>saved,save:value=>{saved=structuredClone(value);},close(){}};
  const start=async()=>{app=createDemoServer({stateStore:store});const a=await app.listen(0);return `http://127.0.0.1:${a.port}`;};let base=await start();
  const api=async(path,body,token)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  try{
    const host=(await api('/api/session',{role:'CAR_HOST',nickname:'Migration host'})).body,room=(await api('/api/rooms',{},host.token)).body;
    const join=async(name,code)=>{const phone=(await api('/api/session',{role:'PHONE',nickname:name})).body;const joined=(await api('/api/join',{joinCode:code,seat:'REAR_LEFT'},phone.token)).body;await api('/api/rooms/'+room.roomId+'/approve',{memberId:joined.memberId},host.token);return phone;};
    const first=await join('Old member',room.joinCode),query={latitude:37.5665,longitude:126.978,radiusM:500};
    const list=(await api('/api/world/nearby',query,first.token)).body,p=list.spawns[0];
    const claim={commandId:randomUUID(),spawnId:p.spawnId,scheduleId:list.scheduleId,version:p.version,spawnCycleId:p.spawnCycleId,passengerConfirmed:true,location:{latitude:p.latitude,longitude:p.longitude,accuracyM:5,measuredAgeMs:10,source:'EMULATOR_GPS',isMock:true}};
    assert.equal((await api('/api/world/claim',claim,first.token)).status,200);
    await api('/api/rooms/'+room.roomId+'/party/leave',{},first.token);await app.close();
    delete saved.rooms[0].partyWorldClaims;delete saved.rooms[0].partyPickupClaims;delete saved.rooms[0].collectionRevision;
    base=await start();const invite=(await api('/api/rooms',{},host.token)).body,second=await join('New member',invite.joinCode);
    const nearby=(await api('/api/world/nearby',query,second.token)).body;assert.ok(!nearby.spawns.some(s=>s.spawnId===p.spawnId));
    assert.equal((await api('/api/world/claim',{...claim,commandId:randomUUID()},second.token)).body.error.code,'ALREADY_CLAIMED');
    assert.equal(saved.rooms[0].collection.inventory.supplies,1);
  }finally{await app.close();}
});
