import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {createDemoServer} from '../server.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){const end=Date.now()+4000;while(Date.now()<end){const value=check();if(value)return value;await sleep(10);}throw new Error('Snapshot timeout');}
test('party-once moving claims disappear for everyone, race safely, survive reconnect and remain isolated',async()=>{
  const app=createDemoServer(),clients=[];const address=await app.listen(0),base=`http://127.0.0.1:${address.port}`;
  async function api(path,body,token,method='POST'){const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
  async function connect(token,roomId){
    const ws=new WebSocket(base.replace(/^http/,'ws')+'/ws'),messages=[];const c={ws,messages,room:null};clients.push(c);ws.on('error',()=>{});
    ws.on('message',bytes=>{const m=JSON.parse(bytes);messages.push(m);if(m.type==='snapshot')c.room=m.room;});
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});ws.send(JSON.stringify({type:'auth',token,roomId}));
    await until(()=>c.room);c.send=async fields=>{const commandId=randomUUID();ws.send(JSON.stringify({commandId,...fields}));return until(()=>messages.find(m=>m.commandId===commandId));};return c;
  }
  async function party(name,seats){
    const host=(await api('/api/session',{role:'CAR_HOST',nickname:name})).body,room=(await api('/api/rooms',{},host.token)).body;
    const car=await connect(host.token,room.roomId),phones=[];
    for(const [i,seat]of seats.entries()){
      const phone=(await api('/api/session',{role:'PHONE',nickname:name+i})).body;
      const invite=i?(await api('/api/rooms',{},host.token)).body:room;
      const joined=(await api('/api/join',{joinCode:invite.joinCode,seat},phone.token)).body;
      await api('/api/rooms/'+room.roomId+'/approve',{memberId:joined.memberId,allowManualUnknown:true},host.token);
      phones.push({...phone,client:await connect(phone.token,room.roomId)});
    }return {host,car,phones,roomId:room.roomId};
  }
  try{
    const a=await party('A',['REAR_LEFT','REAR_RIGHT']),b=await party('B',['FRONT_PASSENGER']);
    await a.car.send({type:'vehicle.report',reportSeq:1,ux:'RESTRICTED',gear:'D',foreground:false,seats:[],source:'SIMULATED_NO_SDK'});
    const first=a.phones[0],second=a.phones[1];
    const nearby=(await api('/api/world/nearby',{latitude:37.5665,longitude:126.978,radiusM:500},first.token)).body,spawn=nearby.spawns[0];
    const body={commandId:randomUUID(),spawnId:spawn.spawnId,scheduleId:nearby.scheduleId,version:spawn.version,spawnCycleId:spawn.spawnCycleId,passengerConfirmed:true,location:{latitude:spawn.latitude,longitude:spawn.longitude,accuracyM:5,measuredAgeMs:100,source:'EMULATOR_GPS',isMock:true}};
    assert.equal((await api('/api/world/claim',{...body,location:{...body.location,latitude:spawn.latitude+.01}},first.token)).body.error.code,'OUTSIDE_SPAWN');
    assert.equal(a.car.room.collection.inventory.supplies,0);
    const started=performance.now();
    const claimed=await Promise.all([1,2,3].map(()=>api('/api/world/claim',body,first.token)));
    assert.ok(claimed.every(r=>r.status===200));assert.equal(claimed.filter(r=>r.body.replayed===false).length,1);
    await until(()=>[a.car,...a.phones.map(p=>p.client)].every(c=>c.room.collection.inventory.supplies===1));
    assert.ok(performance.now()-started<4000);
    assert.equal(b.car.room.collection.inventory.supplies,0);assert.equal(b.phones[0].client.room.collection.inventory.supplies,0);
    assert.equal((await api('/api/world/claim',{...body,commandId:randomUUID()},first.token)).body.error.code,'ALREADY_CLAIMED');
    const otherList=(await api('/api/world/nearby',{latitude:37.5665,longitude:126.978,radiusM:500},second.token)).body;
    assert.ok(!otherList.spawns.some(p=>p.spawnId===spawn.spawnId));
    assert.equal((await api('/api/world/claim',{...body,commandId:randomUUID()},second.token)).body.error.code,'ALREADY_CLAIMED');
    const nextSpawn=otherList.spawns[0];
    const nextBody={...body,spawnId:nextSpawn.spawnId,spawnCycleId:nextSpawn.spawnCycleId,location:{...body.location,latitude:nextSpawn.latitude,longitude:nextSpawn.longitude}};
    const raced=await Promise.all([first,second].map(p=>api('/api/world/claim',{...nextBody,commandId:randomUUID()},p.token)));
    assert.equal(raced.filter(r=>r.status===200).length,1);assert.equal(raced.filter(r=>r.body.error?.code==='ALREADY_CLAIMED').length,1);
    await until(()=>a.car.room.collection.inventory.supplies===2&&first.client.room.collection.inventory.supplies===2);
    const before=second.client;before.ws.terminate();const reconnected=await connect(second.token,a.roomId);
    assert.equal(reconnected.room.collection.inventory.supplies,2);
    const mine=(await api('/api/world/nearby',{latitude:37.5665,longitude:126.978,radiusM:500,includeClaimed:true},second.token)).body;
    assert.equal(mine.spawns.find(p=>p.spawnId===spawn.spawnId).claimed,true);
    assert.equal(reconnected.room.vehicle.playAllowed,false);
    const shot=await reconnected.send({type:'command',roomEpoch:reconnected.room.roomEpoch,action:'fire',angleDeg:140});assert.equal(shot.ok,false);
    const pickupResults=await Promise.all([first.client,reconnected].map(c=>c.send({type:'command',roomEpoch:c.room.roomEpoch,action:'mobile.collect',pickupId:'DEMO_PICKUP_A',passengerConfirmed:true})));
    assert.equal(pickupResults.filter(r=>r.ok).length,1);assert.equal(pickupResults.filter(r=>r.error?.code==='ALREADY_COLLECTED').length,1);
    await until(()=>[a.car,first.client,reconnected].every(c=>c.room.collection.inventory.supplies===3&&c.room.collection.collectedPickupIds.includes('DEMO_PICKUP_A')));
    assert.ok(first.client.messages.some(m=>m.type==='collection.changed'&&m.refreshNearby===true));
    assert.equal(b.car.room.collection.inventory.supplies,0);
    for(const c of [a.car,first.client,reconnected]){
      const shared=JSON.stringify(c.room);assert.ok(!shared.includes('latitude'));assert.ok(!shared.includes(spawn.spawnId));
    }
  }finally{for(const c of clients)c.ws.terminate();await app.close();}
});
