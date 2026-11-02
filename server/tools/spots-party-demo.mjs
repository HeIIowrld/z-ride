/** API-only two-party integration. SIMULATED, no real place review or SDK. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
const base=process.argv[2]??'http://127.0.0.1:8000',spotId='DEMO_PARKING_SPOT',clients=[],parties=[];
const auth=process.env.ZRIDE_TEST_ACCESS_KEY,reviewKey=process.env.ZRIDE_PLACE_REVIEW_TOKEN;
if(!reviewKey)throw new Error('Private reviewer environment required');
async function api(path,body,token,method='POST'){
  const r=await fetch(base+path,{method,signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json();if(!r.ok)throw new Error('HTTP_'+r.status+'_'+data.error?.code);return data;
}
async function connect(token,roomId){
  const ws=new WebSocket(base.replace(/^http/,'ws')+'/ws'),waiting=new Map();let latest,authMessage;
  const client={ws,get room(){return latest},messages:[],send(body){const commandId=randomUUID();return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{waiting.delete(commandId);reject(new Error('WS_TIMEOUT'));},6000);waiting.set(commandId,{resolve,reject,timer});ws.send(JSON.stringify({...body,commandId}));
  });}};clients.push(client);ws.on('error',()=>{});
  ws.on('message',bytes=>{const m=JSON.parse(bytes);client.messages.push(m);if(m.type==='snapshot')latest=m.room;if(m.type==='auth.ok')authMessage=m;
    const w=waiting.get(m.commandId);if(w){waiting.delete(m.commandId);clearTimeout(w.timer);m.ok?w.resolve(m):w.reject(new Error(m.error?.code));}});
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});ws.send(JSON.stringify({type:'auth',token,roomId}));
  const end=Date.now()+6000;while(!latest||!authMessage){if(Date.now()>end)throw new Error('AUTH_TIMEOUT');await new Promise(r=>setTimeout(r,10));}return client;
}
let heartbeat;
try{
  for(let i=0;i<2;i++){
    const host=await api('/api/session',{role:'CAR_HOST',nickname:'TEST SHARED '+i,accessKey:auth});const created=await api('/api/rooms',{},host.token),roomId=created.roomId,b='/api/rooms/'+roomId;
    const car=await connect(host.token,roomId),p={host,roomId,b,car,seq:0,phones:[]};parties.push(p);
    await car.send({type:'vehicle.report',reportSeq:++p.seq,ux:'ALLOWED',gear:'P',foreground:true,seats:[],source:'SIMULATED_NO_SDK'});
    if(i===0){
      const status=await api('/api/places/catalog',undefined,host.token,'GET');
      const candidate=await api('/api/places/nearby',{latitude:37.5665,longitude:126.978,eligibleOnly:false,limit:100},host.token);
      assert.ok(candidate.places.some(p=>p.placeId===spotId&&p.isDemo===true));
      await api('/api/admin/places/review',{commandId:randomUUID(),expectedRevision:status.worldRevision,placeId:spotId,accessStatus:'VERIFIED',enabled:true,entrance:{latitude:37.5665,longitude:126.978},playZone:{latitude:37.5665,longitude:126.978,radiusM:40},parkingAllowed:true,dwellAllowed:true,evidence:'SIMULATED fixture only; not an actual parking location'},reviewKey);
    }
    const invite=await api(b+'/party/invite',{},host.token);const inviteToken=new URL(invite.joinUrl).hash.slice('#invite='.length);
    for(const seat of ['REAR_LEFT','REAR_RIGHT']){
      const joined=await api('/api/invites/redeem',{inviteToken,nickname:'TEST '+i+' '+seat,seat,passengerConfirmed:true});
      await api(b+'/approve',{memberId:joined.memberId,allowManualUnknown:true},host.token);p.phones.push(await connect(joined.token,roomId));
    }
    await api(b+'/party',{commandId:randomUUID(),visible:true,name:'TEST PARTY '+i,spotId},host.token);
    const current=(await api(b,undefined,host.token,'GET')).room;
    await api(b+'/game/configure',{commandId:randomUUID(),roomEpoch:current.roomEpoch,expectedGameRevision:current.game.revision,scenarioId:'zombie-defense-v1'},host.token);
    const shared=await api('/api/spots/'+spotId+'/shared',undefined,host.token,'GET');
    const event=await api(b+'/party/events/join',{commandId:randomUUID(),spotId,expectedInstanceId:shared.instance?.instanceId??null},host.token);p.instanceId=event.instance.instanceId;
    const route=await api(b+'/route',{commandId:randomUUID(),expectedRouteRevision:0,source:'DEMO_ROUTE',geometry:[{latitude:37.56,longitude:126.978},{latitude:37.57,longitude:126.978}]},host.token);
    const candidates=await api(b+'/route/spots',{routeRevision:route.routeRevision,corridorM:300},host.token);
    assert.ok(candidates.places.some(p=>p.placeId===spotId));
    await car.send({type:'world.subscribe',spotId});
  }
  heartbeat=setInterval(()=>{for(const p of parties)p.car.send({type:'vehicle.report',reportSeq:++p.seq,ux:'ALLOWED',gear:'P',foreground:true,seats:[],source:'SIMULATED_NO_SDK'}).catch(()=>{});},2000);
  for(const p of parties){
    const started=await p.car.send({type:'command',action:'round.start',roomEpoch:p.car.room.roomEpoch});
    for(const [index,angleDeg] of [[0,-100],[1,60],[1,140]])for(let n=0;n<5;n++)await p.phones[index].send({type:'command',action:'fire',angleDeg,roomEpoch:started.roomEpoch});
    const current=(await api(p.b,undefined,p.host.token,'GET')).room;
    await api(p.b+'/game/advance',{commandId:randomUUID(),roomEpoch:current.roomEpoch,expectedGameRevision:current.game.revision},p.host.token);
    const world=await api('/api/spots/'+spotId+'/shared',undefined,p.host.token,'GET');
    const body={commandId:randomUUID(),spotId,instanceId:p.instanceId,expectedInstanceRevision:world.instance?.revision??0};
    const contribution=await api(p.b+'/party/contribute',body,p.host.token);assert.equal(contribution.rewardGranted,false);
    assert.equal((await api(p.b+'/party/contribute',body,p.host.token)).replayed,true);
  }
  const shared=await api('/api/spots/'+spotId+'/shared',undefined,parties[0].host.token,'GET');
  assert.equal(shared.parties.length,2);assert.equal(shared.instance.contributions.length,2);
  assert.ok(parties[0].car.messages.some(m=>m.type==='world.snapshot'&&m.parties.length===2));
  assert.ok(!JSON.stringify(shared).includes('inviteToken'));assert.ok(!JSON.stringify(shared).includes('geometry'));
  console.log(JSON.stringify({event:'shared-demo.verified',source:'SIMULATED_NO_SDK',spotId,parties:2,qrGuests:4,routeQueries:2,contributions:2,replaySafe:true,rewardGranted:false,actualVehicleSdk:false}));
}finally{
  clearInterval(heartbeat);for(const p of parties)await api(p.b+'/party/disband',{},p.host.token).catch(()=>{});for(const c of clients)c.ws.terminate();
}
