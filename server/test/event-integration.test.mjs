import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {WebSocket} from 'ws';
import {createDemoServer} from '../server.mjs';
import {createStateStore} from '../state-store.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const point={latitude:37.5665,longitude:126.978};
const catalog={version:'fixture-events',places:[{placeId:'p',name:'Synthetic parking',category:'PARKING',...point,isDemo:true}]};

test('two non-combat parties complete, race settlement, restart and respawn without duplicate rewards',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zride-events-'));let now=Date.now(),app,base,failCommit=false;const clients=[];
  const options={dbPath:join(dir,'state.sqlite'),placesCatalog:catalog,placeReviewToken:'fixture-review',leaseMs:60000,eventClock:()=>now,eventPolicy:{durationMs:10000,respawnMs:1000,target:2}};
  const start=async()=>{const store=createStateStore(options.dbPath);app=createDemoServer({...options,stateStore:{kind:'sqlite',load:()=>store.load(),save:v=>{if(failCommit)throw new Error('Injected reward commit failure');store.save(v);},close:()=>store.close()}});const a=await app.listen(0);base=`http://127.0.0.1:${a.port}`;};
  const api=async(path,body,token,method=body===undefined?'GET':'POST')=>{
    const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};
  };
  async function connect(token,roomId){
    const ws=new WebSocket(base.replace('http','ws')+'/ws'),messages=[];clients.push(ws);ws.on('error',()=>{});ws.on('message',b=>messages.push(JSON.parse(b)));
    await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});ws.send(JSON.stringify({type:'auth',token,roomId}));
    async function until(predicate){for(let n=0;n<300;n++){const v=predicate();if(v)return v;await sleep(10);}throw new Error('WS timeout');}
    await until(()=>messages.find(m=>m.type==='auth.ok'));
    return {ws,messages,send:async body=>{const commandId=randomUUID();ws.send(JSON.stringify({...body,commandId}));return until(()=>messages.find(m=>m.commandId===commandId));}};
  }
  const state=async p=>(await api(p.path,undefined,p.host.token)).body.room;
  const game=async(p,action,fields={},token=p.host.token)=>{const r=await state(p),body={commandId:randomUUID(),roomEpoch:r.roomEpoch,expectedGameRevision:r.game.revision,...fields};const response=await api(p.path+'/game/'+action,body,token);if(action==='advance'&&response.body.room?.game.completed)p.finalAdvance=body;return response;};
  async function party(name){
    const host=(await api('/api/session',{role:'CAR_HOST',nickname:name})).body,r=(await api('/api/rooms',{},host.token)).body;
    const p={host,roomId:r.roomId,path:'/api/rooms/'+r.roomId,phones:[],reportSeq:0};p.car=await connect(host.token,r.roomId);
    for(const [i,seat]of ['REAR_LEFT','REAR_RIGHT'].entries()){
      const phone=(await api('/api/session',{role:'PHONE',nickname:name+i})).body;
      const invite=i?(await api('/api/rooms',{},host.token)).body:r;
      const m=(await api('/api/join',{joinCode:invite.joinCode,seat},phone.token)).body;
      await api(p.path+'/approve',{memberId:m.memberId,allowManualUnknown:true},host.token);p.phones.push(phone);await connect(phone.token,r.roomId);
    }
    await game(p,'configure',{scenarioId:'signal-puzzle-v1'});
    await api(p.path+'/party',{commandId:randomUUID(),visible:true,name,spotId:'p'},host.token);
    const shared=(await api('/api/spots/p/shared',undefined,host.token)).body;
    p.instanceId=(await api(p.path+'/party/events/join',{commandId:randomUUID(),spotId:'p',expectedInstanceId:shared.instance?.instanceId??null},host.token)).body.instance.instanceId;
    return p;
  }
  async function report(p){assert.equal((await p.car.send({type:'vehicle.report',reportSeq:++p.reportSeq,ux:'ALLOWED',gear:'P',foreground:true,seats:[],source:'SIMULATED_NO_SDK'})).ok,true);}
  async function finish(p){
    await report(p);const r=await state(p);const started=await p.car.send({type:'command',action:'round.start',roomEpoch:r.roomEpoch});assert.equal(started.ok,true,JSON.stringify(started.error));
    for(const objectiveId of ['SIGNAL_DECODE','RELAY_SYNC']){
      for(const phone of p.phones)assert.equal((await game(p,'interact',{objectiveId,action:'INTERACT'},phone.token)).status,200);
      assert.equal((await game(p,'advance')).status,200);
    }
    assert.equal((await state(p)).game.completed,true);
  }
  await start();
  try{
    await api('/api/admin/places/review',{commandId:'review',placeId:'p',expectedRevision:0,accessStatus:'VERIFIED',enabled:true,entrance:point,playZone:{...point,radiusM:40},parkingAllowed:true,dwellAllowed:true,evidence:'Synthetic test only'},'fixture-review');
    const a=await party('A'),b=await party('B');assert.equal(a.instanceId,b.instanceId);
    await finish(a);await finish(b);
    assert.ok(a.car.messages.some(m=>m.type==='mission.changed'&&m.resultId));
    assert.equal((await api(a.path+'/rewards/claim',{commandId:'phone-claim',awardId:'any'},a.phones[0].token)).status,403);
    assert.equal((await api(b.path+'/results',undefined,a.host.token)).status,403);
    const body=p=>({commandId:'contribution',spotId:'p',instanceId:p.instanceId,expectedInstanceRevision:0});
    const races=await Promise.all([a,b].map(p=>api(p.path+'/party/contribute',body(p),p.host.token)));
    assert.equal(races.filter(r=>r.status===200).length,1);assert.equal(races.filter(r=>r.body.error?.code==='INSTANCE_REVISION_CONFLICT').length,1);
    const loser=races[0].status===200?b:a;
    assert.equal((await api(loser.path+'/party/contribute',{...body(loser),expectedInstanceRevision:1},loser.host.token)).body.instance.completed,true);
    assert.equal((await api(a.path+'/game/advance',a.finalAdvance,a.host.token)).body.replayed,true);
    const awards=(await api(a.path+'/rewards',undefined,a.host.token)).body.awards;assert.equal(awards.length,2);
    const claim={commandId:'claim-a',awardId:awards[0].awardId};
    failCommit=true;const failed=await api(a.path+'/rewards/claim',claim,a.host.token);assert.equal(failed.status,503);
    assert.ok(!a.car.messages.some(m=>m.type==='snapshot'&&m.room.collection.inventory.supplies>0));
    await app.close();failCommit=false;await start();
    assert.equal((await state(a)).collection.inventory.supplies,0);
    assert.ok((await api(a.path+'/rewards',undefined,a.host.token)).body.awards.every(a=>a.status==='PENDING'));
    const repeated=await Promise.all([1,2,3].map(()=>api(a.path+'/rewards/claim',claim,a.host.token)));
    assert.ok(repeated.every(r=>r.status===200));assert.equal(repeated.filter(r=>!r.body.replayed).length,1);
    const next=await Promise.all(['x','y'].map(commandId=>api(a.path+'/rewards/claim',{commandId,awardId:awards[1].awardId},a.host.token)));
    assert.equal(next.filter(r=>r.status===200).length,1);assert.equal(next.filter(r=>r.body.error?.code==='REWARD_ALREADY_CLAIMED').length,1);
    assert.equal((await state(a)).collection.inventory.supplies,3);
    const before=(await api(a.path+'/results',undefined,a.host.token)).body.results;
    for(const ws of clients)ws.terminate();await app.close();await start();
    assert.equal((await api(a.path+'/results',undefined,a.host.token)).body.results[0].resultId,before[0].resultId);
    assert.equal((await api(a.path+'/rewards/claim',claim,a.host.token)).body.replayed,true);
    assert.equal((await state(a)).collection.inventory.supplies,3);
    now+=1000;await sleep(350);const fresh=(await api('/api/spots/p/shared',undefined,a.host.token)).body.instance;
    assert.notEqual(fresh.instanceId,a.instanceId);assert.equal(fresh.cycle,2);assert.equal(fresh.contributions.length,0);
    assert.equal((await api(a.path+'/party/contribute',{...body(a),commandId:'stale'},a.host.token)).body.error.code,'EVENT_INSTANCE_CONFLICT');
    assert.equal((await state(a)).collection.inventory.supplies,3);
    assert.equal((await game(a,'configure',{scenarioId:'supply-run-v1'})).status,200);
    assert.equal((await api(a.path+'/results',undefined,a.host.token)).body.results[0].resultId,before[0].resultId);
    assert.equal((await api(a.path+'/party/events/join',{commandId:'new-cycle',spotId:'p',expectedInstanceId:fresh.instanceId},a.host.token)).status,200);
  }finally{
    for(const ws of clients)ws.terminate();await app.close();
    const target=resolve(dir);assert.equal(dirname(target),resolve(tmpdir()));assert.ok(basename(target).startsWith('zride-events-'));await rm(target,{recursive:true,force:true});
  }
});
