import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { createDemoServer } from '../server.mjs';

test('vehicle and passenger room, sector, safety, duplicate and reconnect integration', async () => {
  const evidence = [];
  const app = createDemoServer({ leaseMs: 700 });
  const address = await app.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}/ws`;
  const clients = [];
  async function request(path, body, credential, method = 'POST') {
    const response = await fetch(base + path, { method, headers: { 'content-type':'application/json', ...(credential ? { authorization:'Bearer '+credential } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(JSON.stringify(value)), { response, value });
    return value;
  }
  async function connect(credential, roomId) {
    const ws = new WebSocket(wsBase); const queue = []; const waiters = [];
    ws.on('message', bytes => {
      const message = JSON.parse(bytes);
      queue.push(message);
      for (const waiter of [...waiters]) if (waiter.check(message)) { waiters.splice(waiters.indexOf(waiter),1); clearTimeout(waiter.timer); waiter.resolve(message); }
    });
    const wait = check => {
      const found = queue.find(check);
      if (found) return Promise.resolve(found);
      return new Promise((resolve,reject) => {
        const waiter={check,resolve,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(waiter),1);reject(new Error('WebSocket wait timeout'));},2500)};
        waiters.push(waiter);
      });
    };
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    ws.send(JSON.stringify({type:'auth',token:credential,roomId}));
    await wait(m=>m.type==='auth.ok');
    const client={ws,queue,wait,async send(message){ws.send(JSON.stringify(message));return wait(m=>m.type==='result'&&m.commandId===message.commandId);}};
    clients.push(client); return client;
  }
  const id=()=>randomUUID();
  const cmd=(epoch,action,extra={})=>({type:'command',commandId:id(),roomEpoch:epoch,action,...extra});
  let reportSeq=0;
  const report=(ux='ALLOWED',gear='P',occupancy='UNKNOWN')=>({type:'vehicle.report',commandId:id(),reportSeq:++reportSeq,ux,gear,seats:[{seat:'FRONT_PASSENGER',occupancy}],source:'TEST_ADAPTER',charge:{state:'UNKNOWN',portConnection:'UNKNOWN',source:'TEST_ADAPTER'}});
  const snap=async token=>(await request('/api/rooms/'+room.roomId,undefined,token,'GET')).room;
  let room;
  try {
    const host=await request('/api/session',{role:'CAR_HOST',nickname:'Test car'});
    const phone=await request('/api/session',{role:'PHONE',nickname:'Test passenger'});
    room=await request('/api/rooms',{},host.token);
    const car=await connect(host.token,room.roomId);
    await assert.rejects(request('/api/join',{joinCode:room.joinCode,seat:'toString'},phone.token), e=>e.value.error.code==='INVALID_JOIN');
    await assert.rejects(request('/api/join',{joinCode:room.joinCode,seat:'__proto__'},phone.token), e=>e.value.error.code==='INVALID_JOIN'); evidence.push('inherited object keys cannot become passenger seats');
    const joined=await request('/api/join',{joinCode:room.joinCode,seat:'FRONT_PASSENGER'},phone.token);
    const passenger=await connect(phone.token,room.roomId);
    assert.equal(joined.room.vehicle.source,'PENDING_REDACTED'); assert.equal(joined.room.members.length,1); assert.equal(joined.room.zombies.length,0); evidence.push('pending passenger cannot read other members or vehicle state');
    const pending=await passenger.send(cmd(0,'fire',{angleDeg:60}));
    assert.equal(pending.error.code,'MEMBER_PENDING'); evidence.push('pending phone cannot play');
    await request('/api/rooms/'+room.roomId+'/approve',{memberId:joined.memberId},host.token);
    let current=await snap(host.token);
    const unknown=await car.send(cmd(current.roomEpoch,'round.start'));
    assert.equal(unknown.error.code,'GATE_CLOSED'); evidence.push('UNKNOWN UX/gear fails closed');
    await car.send(report());
    assert.equal((await car.send({...report('RESTRICTED','D'),reportSeq:1})).error.code,'STALE_REPORT');
    assert.equal((await snap(host.token)).vehicle.ux,'ALLOWED'); evidence.push('older vehicle report sequence cannot overwrite current state');
    current=await snap(host.token);
    assert.equal(current.members.find(m=>m.sessionId===phone.sessionId).seatEvidence,'MANUAL_UNKNOWN');
    const start=await car.send(cmd(current.roomEpoch,'round.start'));
    assert.equal(start.ok,true); current=await snap(host.token);
    const phoneCurrent=await snap(phone.token);
    assert.equal(current.roomId,phoneCurrent.roomId); assert.equal(current.stateVersion,phoneCurrent.stateVersion); evidence.push('two independent sockets share approved room snapshot');
    const epoch=current.roomEpoch;
    assert.equal((await car.send(cmd(epoch,'fire',{angleDeg:60}))).error.code,'ROLE_FORBIDDEN'); evidence.push('driver cannot fire');
    assert.equal((await passenger.send(cmd(epoch,'support.pulse'))).error.code,'ROLE_FORBIDDEN');
    const shot=cmd(epoch,'fire',{angleDeg:60});
    const first=await passenger.send(shot); assert.equal(first.ok,true); assert.equal(first.data.damage,1);
    const shotCount=(await snap(host.token)).stats.shots;
    await passenger.send(shot); assert.equal((await snap(host.token)).stats.shots,shotCount); evidence.push('duplicate command has one effect');
    const conflict={...shot,angleDeg:61}; passenger.ws.send(JSON.stringify(conflict));
    const collision=await passenger.wait(m=>m.type==='result'&&m.commandId===null&&m.error?.code==='IDEMPOTENCY_CONFLICT'); assert.ok(collision); evidence.push('same ID with altered payload rejected');
    assert.equal((await passenger.send(cmd(epoch,'fire',{angleDeg:-90}))).error.code,'ANGLE_OUTSIDE_SECTOR'); evidence.push('front passenger left-side shot rejected');
    assert.equal((await car.send(cmd(epoch,'support.pulse'))).error.code,'SUPPLY_REQUIRED');
    assert.equal((await passenger.send(cmd(0,'mobile.collect',{pickupId:'DEMO_PICKUP_A',passengerConfirmed:true}))).ok,true);
    const supported=await car.send(cmd(epoch,'support.pulse')); assert.equal(supported.ok,true); assert.equal(supported.data.suppliesConsumed,1); assert.equal(supported.data.inventory.supplies,0);
    const boosted=await passenger.send(cmd(epoch,'fire',{angleDeg:60})); assert.equal(boosted.data.damage,3); evidence.push('collected supply is required and consumed for commander damage-3 support');
    await car.send(report('ALLOWED','P','EMPTY'));
    assert.equal((await passenger.send(cmd(epoch,'fire',{angleDeg:60}))).error.code,'SEAT_EMPTY'); evidence.push('reported EMPTY seat cannot fire');
    await car.send(report());
    assert.equal((await passenger.send(cmd(epoch,'fire',{angleDeg:60}))).error.code,'SEAT_EMPTY'); evidence.push('EMPTY to UNKNOWN does not silently unlock manual fallback');
    const omitted=report(); delete omitted.seats; await car.send(omitted);
    assert.equal((await passenger.send(cmd(epoch,'fire',{angleDeg:60}))).error.code,'SEAT_EMPTY'); evidence.push('omitted seat does not erase last EMPTY lock');
    await car.send(report('RESTRICTED','D','OCCUPIED'));
    current=await snap(host.token); assert.equal(current.state,'PAUSED'); assert.ok(current.roomEpoch>epoch); evidence.push('drive restriction pauses and increments epoch');
    const stale=await passenger.send(cmd(epoch,'fire',{angleDeg:60})); assert.equal(stale.error.code,'STALE_EPOCH');
    assert.equal((await passenger.send(cmd(current.roomEpoch,'fire',{angleDeg:60}))).error.code,'GATE_CLOSED');
    assert.equal((await car.send(cmd(current.roomEpoch,'mobile.collect',{pickupId:'DEMO_PICKUP_B',passengerConfirmed:true}))).error.code,'ROLE_FORBIDDEN');
    assert.equal((await passenger.send(cmd(current.roomEpoch,'mobile.collect',{pickupId:'DEMO_PICKUP_B',passengerConfirmed:false}))).error.code,'PASSENGER_CONFIRMATION_REQUIRED');
    const collection=cmd(epoch,'mobile.collect',{pickupId:'DEMO_PICKUP_B',passengerConfirmed:true});
    assert.equal((await passenger.send(collection)).ok,true);
    assert.equal((await passenger.send(collection)).ok,true);
    assert.equal((await snap(host.token)).collection.inventory.supplies,1);
    assert.equal((await passenger.send(cmd(epoch,'mobile.collect',{pickupId:'DEMO_PICKUP_B',passengerConfirmed:true}))).error.code,'ALREADY_COLLECTED');
    assert.equal((await snap(host.token)).collection.inventory.supplies,1);
    evidence.push('approved passenger demo collection works during restricted battle pause and stale battle epoch');
    evidence.push('driver collection and unconfirmed passenger collection rejected; duplicate pickup reward once');
    await car.send(report('ALLOWED','P','OCCUPIED')); assert.equal((await snap(host.token)).state,'PAUSED'); evidence.push('parking does not auto-resume');
    current=await snap(host.token); await car.send(cmd(current.roomEpoch,'round.start'));
    passenger.ws.close(); await new Promise(resolve=>passenger.ws.once('close',resolve));
    const rejoined=await connect(phone.token,room.roomId); assert.ok((await rejoined.wait(m=>m.type==='snapshot')).room.members.some(m=>m.sessionId===phone.sessionId)); evidence.push('phone reconnect restores approved membership and snapshot');
    const inactive=report(); inactive.foreground=false; await car.send(inactive);
    current=await snap(host.token); assert.equal(current.state,'PAUSED'); assert.equal(current.vehicle.ux,'ALLOWED'); assert.match(current.pauseReason,/APP_INACTIVE/); evidence.push('background pauses without falsifying platform UX signal');
    current=await snap(host.token);
    await car.send(cmd(current.roomEpoch,'round.pause'));
    await request('/api/rooms/'+room.roomId+'/approve',{memberId:joined.memberId,seat:'REAR_RIGHT'},host.token);
    await car.send(report()); current=await snap(host.token); await car.send(cmd(current.roomEpoch,'round.start'));
    current=await snap(host.token);
    assert.equal((await rejoined.send(cmd(current.roomEpoch,'fire',{angleDeg:180}))).ok,true);
    assert.equal((await rejoined.send(cmd(current.roomEpoch,'fire',{angleDeg:-180}))).ok,true); evidence.push('both rear boundary representations are allowed for rear seats');
    assert.equal((await rejoined.send(cmd(current.roomEpoch,'fire',{angleDeg:-100}))).error.code,'ANGLE_OUTSIDE_SECTOR');
    for (const [seat, angle] of [['REAR_RIGHT',140],['FRONT_PASSENGER',60],['REAR_LEFT',-100]]) {
      current=await snap(host.token); await car.send(cmd(current.roomEpoch,'round.pause'));
      await request('/api/rooms/'+room.roomId+'/approve',{memberId:joined.memberId,seat},host.token);
      await car.send(report()); current=await snap(host.token); await car.send(cmd(current.roomEpoch,'round.start'));
      current=await snap(host.token);
      for(let i=0;i<5;i++) {
        const live=(await snap(host.token)).zombies.find(z=>z.angleDeg===angle);
        if(live.hp===0)break;
        assert.equal((await rejoined.send(cmd(current.roomEpoch,'fire',{angleDeg:angle}))).ok,true);
      }
    }
    current=await snap(host.token); assert.equal(current.state,'CLEARED'); assert.ok(current.zombies.every(z=>z.hp===0)); assert.equal(current.stats.kills,3); evidence.push('three seat sectors can clear all three authoritative targets');
    await car.send(report()); await car.send(cmd(current.roomEpoch,'round.start'));
    current=await snap(host.token); assert.equal(current.state,'PLAYING'); assert.ok(current.zombies.every(z=>z.hp===5)); evidence.push('explicit start after clear resets wave');
    await new Promise(resolve=>setTimeout(resolve,1100));
    current=await snap(host.token); assert.equal(current.state,'PAUSED'); assert.match(current.pauseReason,/LEASE_EXPIRED/); evidence.push('missing vehicle report expires lease and pauses');
    const emptyPassenger=report('RESTRICTED','D'); emptyPassenger.seats=[{seat:'REAR_LEFT',occupancy:'EMPTY'}]; await car.send(emptyPassenger);
    car.ws.close(); await new Promise(resolve=>car.ws.once('close',resolve));
    current=await snap(host.token); assert.ok(current.vehicle.gateReasons.includes('CAR_DISCONNECTED'));
    const independent=await rejoined.send(cmd(0,'mobile.collect',{pickupId:'DEMO_PICKUP_C',passengerConfirmed:true}));
    assert.equal(independent.ok,true); assert.equal(independent.data.gpsVerified,false);
    const ownCollection=(await snap(phone.token)).collection;
    assert.equal(ownCollection.inventory.supplies,2); assert.equal(ownCollection.collectedPickupIds.length,3);
    assert.equal(ownCollection.mode,'DEMO_PICKUP');
    evidence.push('passenger collection remains independent of host disconnection, stale car-seat data and battle lease');
    evidence.push('collection explicitly uses DEMO_PICKUP namespace and gpsVerified false');
    const output={testedAt:new Date().toISOString(),passed:true,testScope:'Node HTTP server + two independent WebSocket clients; no APK or real vehicle',evidence};
    await writeFile(new URL('../test-results.json',import.meta.url),JSON.stringify(output,null,2)+'\n');
  } finally { for(const client of clients)client.ws.terminate(); await app.close(); }
});

test('receipt capacity denies a new action before applying its effect', async () => {
  const app=createDemoServer({maxReceiptsPerMember:2}); const address=await app.listen(0);
  const base=`http://127.0.0.1:${address.port}`;
  const post=async(path,body,token)=>(await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)})).json();
  let ws;
  try {
    const host=await post('/api/session',{role:'CAR_HOST',nickname:'Capacity test'});
    const room=await post('/api/rooms',{},host.token);
    ws=new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const waits=new Map();
    ws.on('message',bytes=>{const m=JSON.parse(bytes);const key=m.type==='auth.ok'?'auth':m.commandId;if(waits.has(key)){waits.get(key)(m);waits.delete(key);}});
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    const auth=new Promise(resolve=>waits.set('auth',resolve));ws.send(JSON.stringify({type:'auth',token:host.token,roomId:room.roomId}));await auth;
    const report=async(seq,ux,gear)=>{const commandId=randomUUID();const result=new Promise(resolve=>waits.set(commandId,resolve));ws.send(JSON.stringify({type:'vehicle.report',commandId,reportSeq:seq,ux,gear,seats:[]}));return result;};
    assert.equal((await report(1,'ALLOWED','P')).ok,true);
    assert.equal((await report(2,'RESTRICTED','D')).ok,true);
    assert.equal((await report(3,'ALLOWED','P')).error.code,'COMMAND_LIMIT');
    const snapshot=await(await fetch(base+'/api/rooms/'+room.roomId,{headers:{authorization:'Bearer '+host.token}})).json();
    assert.equal(snapshot.room.vehicle.ux,'RESTRICTED');assert.equal(snapshot.room.vehicle.gear,'D');
    await writeFile(new URL('../receipt-limit-results.json',import.meta.url),JSON.stringify({testedAt:new Date().toISOString(),passed:true,evidence:'Third new report rejected before mutation when receipt capacity is two'},null,2)+'\n');
  } finally {ws?.terminate();await app.close();}
});
