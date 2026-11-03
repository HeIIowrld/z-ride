import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {WebSocket} from 'ws';
import {createDemoServer} from '../server.mjs';
import {createStateStore} from '../state-store.mjs';
import {DatabaseSync} from 'node:sqlite';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

test('phone identity survives vehicle changes: approved atomic switch, isolated inventory, personal history and restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'game-accounts-')),clients=[];let app,base,failCommit=false;
  const start=async()=>{const store=createStateStore(join(directory,'state.sqlite'));app=createDemoServer({publicOrigin:'https://game.example',displayName:'Renamed game',trustedProxyAddresses:['127.0.0.1'],leaseMs:60000,stateStore:{kind:'sqlite',load:()=>store.load(),save:v=>{if(failCommit)throw new Error('Injected switch save failure');store.save(v);},close:()=>store.close()}});const a=await app.listen(0);base=`http://127.0.0.1:${a.port}`;};
  const api=async(path,body,token)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-forwarded-proto':'https',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const state=async(p,token=p.host.token)=>(await api(p.path,undefined,token)).body.room;
  async function connect(token,roomId){const ws=new WebSocket(base.replace('http','ws')+'/ws'),messages=[];clients.push(ws);ws.on('error',()=>{});ws.on('message',b=>messages.push(JSON.parse(b)));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});ws.send(JSON.stringify({type:'auth',token,roomId}));
    async function until(predicate){for(let i=0;i<300;i++){const v=predicate();if(v)return v;await sleep(10);}throw new Error('WS timeout');}await until(()=>messages.find(m=>m.type==='auth.ok'));
    return {ws,messages,send:async body=>{const commandId=randomUUID();ws.send(JSON.stringify({...body,commandId}));return until(()=>messages.find(m=>m.commandId===commandId));}};
  }
  async function car(name){const host=(await api('/api/session',{role:'CAR_HOST',nickname:name})).body,room=(await api('/api/rooms',{},host.token)).body;return {host,roomId:room.roomId,path:'/api/rooms/'+room.roomId,client:await connect(host.token,room.roomId)};}
  const invite=async p=>new URL((await api(p.path+'/party/invite',{},p.host.token)).body.joinUrl).hash.slice('#invite='.length);
  const game=async(p,operation,fields={},token=p.host.token)=>{const r=await state(p);return api(p.path+'/game/'+operation,{commandId:randomUUID(),roomEpoch:r.roomEpoch,expectedGameRevision:r.game.revision,...fields},token);};
  await start();
  try{
    assert.equal((await api('/api/client-config')).body.displayName,'Renamed game');assert.equal((await api('/api/auth/providers')).body.google.enabled,false);
    const a=await car('A'),b=await car('B'),guest=(await api('/api/accounts/guest',{nickname:'Persistent crew'})).body,accountToken=guest.accountToken,userId=guest.account.userId;
    const invitation=await invite(a);assert.equal((await api('/api/invites/preview',{inviteToken:invitation})).body.partyId,a.roomId);
    const first=(await api('/api/me/invitations/accept',{inviteToken:invitation,seat:'REAR_LEFT',passengerConfirmed:true,expectedActivePartyId:null},accountToken)).body;
    assert.equal((await api('/api/me',undefined,accountToken)).body.account.activePartyId,null);
    assert.equal((await api(a.path+'/approve',{memberId:first.memberId},a.host.token)).status,200);const phone=await connect(first.token,a.roomId);assert.equal((await api('/api/join',{joinCode:'ignored',seat:'REAR_LEFT'},first.token)).body.error.code,'ACCOUNT_PARTY_JOIN_REQUIRED');
    const other=(await api('/api/invites/redeem',{inviteToken:invitation,nickname:'Other',seat:'REAR_RIGHT',passengerConfirmed:true})).body;
    await api(a.path+'/approve',{memberId:other.memberId},a.host.token);await connect(other.token,a.roomId);
    assert.equal((await phone.send({type:'command',action:'mobile.collect',pickupId:'DEMO_PICKUP_A',passengerConfirmed:true})).ok,true);
    await game(a,'configure',{scenarioId:'signal-puzzle-v1'});
    await a.client.send({type:'vehicle.report',reportSeq:1,ux:'ALLOWED',gear:'P',foreground:true,seats:[],source:'SIMULATED_NO_SDK'});
    assert.equal((await a.client.send({type:'command',action:'round.start',roomEpoch:(await state(a)).roomEpoch})).ok,true);
    for(const objectiveId of ['SIGNAL_DECODE','RELAY_SYNC']){for(const token of [first.token,other.token])assert.equal((await game(a,'interact',{objectiveId,action:'INTERACT'},token)).status,200);await game(a,'advance');}
    const history=(await api('/api/me/history',undefined,accountToken)).body.results;assert.equal(history.length,1);assert.equal(history[0].ownInteractions,2);assert.equal(history[0].participants,undefined);
    const award=(await api(a.path+'/rewards',undefined,a.host.token)).body.awards[0];await api(a.path+'/rewards/claim',{commandId:'host-reward',awardId:award.awardId},a.host.token);assert.equal((await state(a)).collection.inventory.supplies,2);
    const nextInvite=await invite(b),joinBody={inviteToken:nextInvite,seat:'REAR_LEFT',passengerConfirmed:true,expectedActivePartyId:a.roomId};
    assert.equal((await api('/api/me/invitations/accept',joinBody,accountToken)).body.error.code,'PARTY_SWITCH_CONFIRMATION_REQUIRED');
    const second=(await api('/api/me/invitations/accept',{...joinBody,confirmSwitch:true},accountToken)).body;
    assert.equal((await api('/api/me',undefined,accountToken)).body.account.activePartyId,a.roomId);
    assert.ok((await state(a)).members.some(m=>m.memberId===first.memberId));
    failCommit=true;assert.equal((await api(b.path+'/approve',{memberId:second.memberId},b.host.token)).status,503);
    await app.close();failCommit=false;await start();
    assert.equal((await api('/api/me',undefined,accountToken)).body.account.activePartyId,a.roomId);
    assert.equal((await state(b)).members.find(m=>m.memberId===second.memberId).approved,false);
    assert.equal((await api(b.path+'/approve',{memberId:second.memberId},b.host.token)).status,200);
    assert.equal((await api('/api/me',undefined,accountToken)).body.account.activePartyId,b.roomId);
    assert.equal((await api(a.path,undefined,first.token)).status,401);assert.ok(!(await state(a)).members.some(m=>m.memberId===first.memberId));
    assert.equal((await state(a)).collection.inventory.supplies,2);assert.equal((await state(b)).collection.inventory.supplies,0);
    assert.equal((await api('/api/me',undefined,second.token)).status,401);assert.equal((await api(b.path,undefined,accountToken)).status,401);
    let ticket=(await api('/api/me/party-ticket',{},accountToken)).body;assert.equal(ticket.memberId,second.memberId);assert.equal((await api(b.path,undefined,second.token)).status,401);
    await app.close();await start();assert.equal((await api('/api/me',undefined,accountToken)).body.account.userId,userId);
    ticket=(await api('/api/me/party-ticket',{},accountToken)).body;assert.equal(ticket.roomId,b.roomId);assert.equal(ticket.room.vehicle.playAllowed,false);
    assert.equal((await api('/api/me/history',undefined,accountToken)).body.results[0].resultId,history[0].resultId);
    const memberships=(await api('/api/me/parties',undefined,accountToken)).body.memberships;assert.deepEqual(memberships.map(m=>m.status),['SWITCHED','ACTIVE']);
    const back=await invite(a);await api('/api/me/invitations/accept',{inviteToken:back,seat:'REAR_LEFT',passengerConfirmed:true,expectedActivePartyId:b.roomId,confirmSwitch:true},accountToken);
    assert.equal((await api('/api/me/invitations/cancel',{},accountToken)).status,200);assert.equal((await api('/api/me',undefined,accountToken)).body.account.activePartyId,b.roomId);
    assert.equal((await api('/api/accounts/logout',{},accountToken)).status,200);assert.equal((await api('/api/me',undefined,accountToken)).status,401);assert.equal((await api(b.path,undefined,ticket.token)).status,401);
  }finally{for(const ws of clients)ws.terminate();await app.close();const target=resolve(directory);assert.equal(dirname(target),resolve(tmpdir()));assert.ok(basename(target).startsWith('game-accounts-'));await rm(target,{recursive:true,force:true});}
});

test('Google phone exchange requires trusted HTTPS, commits one-use challenges and preserves linked user ID',async()=>{
  const clientId='fixture.apps.googleusercontent.com';let saved,app,base;
  const store={load:()=>saved,save:v=>{saved=structuredClone(v);},close(){}};
  const options={stateStore:store,publicOrigin:'https://renamed.example',googleClientId:clientId,trustedProxyAddresses:['127.0.0.1'],verifyGoogleIdToken:async({credential})=>{await sleep(5);return JSON.parse(credential);}};
  const start=async()=>{app=createDemoServer(options);const a=await app.listen(0);base=`http://127.0.0.1:${a.port}`;};
  const api=async(path,body,token,secure=true)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(secure?{'x-forwarded-proto':'https'}:{}),...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  await start();
  try{
    const guest=(await api('/api/accounts/guest',{nickname:'Link me'})).body;
    assert.equal((await api('/api/auth/google/challenge',{mode:'LINK'},guest.accountToken,false)).body.error.code,'AUTH_HTTPS_REQUIRED');
    const challenge=(await api('/api/auth/google/challenge',{mode:'LINK'},guest.accountToken)).body;
    const credential=JSON.stringify({iss:'https://accounts.google.com',aud:clientId,sub:'fixture-subject',nonce:challenge.nonce,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600});
    const body={challengeId:challenge.challengeId,credential};
    const results=await Promise.all([1,2].map(()=>api('/api/auth/google/exchange',body,guest.accountToken)));
    assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.body.error?.code==='AUTH_CHALLENGE_EXPIRED').length,1);
    const linked=results.find(r=>r.status===200).body;assert.equal(linked.account.userId,guest.account.userId);assert.equal(linked.account.kind,'GOOGLE');
    assert.ok(!JSON.stringify(saved).includes(credential));assert.ok(!JSON.stringify(saved).includes(linked.accountToken));
    await app.close();await start();
    assert.equal((await api('/api/auth/google/exchange',body,linked.accountToken)).body.error.code,'AUTH_CHALLENGE_EXPIRED');
    assert.equal((await api('/api/accounts/refresh',{},linked.accountToken)).body.account.userId,guest.account.userId);
  }finally{await app.close();}
});

test('legacy SQLite migrates to account-aware format and changing the display name preserves user IDs',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'game-accounts-')),dbPath=join(directory,'state.sqlite');let app;
  try{
    const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE server_state(id INTEGER PRIMARY KEY,format_version INTEGER,revision INTEGER,payload TEXT,saved_at INTEGER) STRICT');
    const legacy={formatVersion:1,places:{revision:0,reviews:{},parties:{},instances:{},receipts:{}},sessions:[],rooms:[]};
    db.prepare('INSERT INTO server_state VALUES(1,1,1,?,?)').run(JSON.stringify(legacy),Date.now());db.close();
    app=createDemoServer({dbPath,displayName:'Before rename'});let address=await app.listen(0);
    const response=await fetch(`http://127.0.0.1:${address.port}/api/accounts/guest`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nickname:'Same identity'})}),guest=await response.json();await app.close();
    const inspect=new DatabaseSync(dbPath);assert.equal(inspect.prepare('SELECT format_version FROM server_state').get().format_version,2);inspect.close();
    app=createDemoServer({dbPath,displayName:'After rename'});address=await app.listen(0);
    assert.equal((await (await fetch(`http://127.0.0.1:${address.port}/api/client-config`)).json()).displayName,'After rename');
    const me=await (await fetch(`http://127.0.0.1:${address.port}/api/me`,{headers:{authorization:'Bearer '+guest.accountToken}})).json();assert.equal(me.account.userId,guest.account.userId);
  }finally{await app?.close();const target=resolve(directory);assert.equal(dirname(target),resolve(tmpdir()));assert.ok(basename(target).startsWith('game-accounts-'));await rm(target,{recursive:true,force:true});}
});
