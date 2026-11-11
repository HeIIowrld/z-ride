import assert from 'node:assert/strict';
import {MSG,Reader,encodeJson,decodeJson} from '../packages/shared/src/protocol.js';
const base=process.env.BASE||'http://127.0.0.1:8788';
const sockets=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(60);}throw new Error('condition timed out');}
async function create(n){const r=await fetch(base+'/api/zride/rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({players:n})});assert.equal(r.status,201);return r.json();}
async function state(room){const r=await fetch(base+'/api/zride/rooms/'+room.code+'/status',{headers:{'x-dashboard-token':room.dashboardToken}});assert.equal(r.status,200);return r.json();}
async function join(room,i,pid){
 const ws=new WebSocket(base.replace('http','ws')+'/ws?code='+room.code+'&pid='+(pid||crypto.randomUUID()));ws.binaryType='arraybuffer';sockets.push(ws);
 const c={ws,messages:[],welcome:null};
 ws.onmessage=e=>{const rd=new Reader(new Uint8Array(e.data));const type=rd.u8();if([MSG.WELCOME,MSG.LOBBY,MSG.KICK].includes(type)){const v=decodeJson(rd);c.messages.push({type,v});if(type===MSG.WELCOME)c.welcome=v;}};
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
 ws.send(encodeJson(MSG.HELLO,{name:'test-'+i,skin:0}));
 await until(()=>c.welcome||c.messages.find(m=>m.type===MSG.KICK));return c;
}
try{
 for(const n of [0,5,1.5]){const r=await fetch(base+'/api/zride/rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({players:n})});assert.equal(r.status,400);}
 await Promise.all([1,2,3,4].map(async n=>{
  const room=await create(n);
  assert.equal((await fetch(base+'/api/zride/rooms/'+room.code+'/status')).status,403);
  const clients=[];
  for(let i=0;i<n;i++)clients.push(await join(room,i));
  const s=await state(room);assert.equal(s.targetPlayers,n);assert.equal(s.connectedPlayers,n);assert.equal(s.players.length,n);
  const extra=await join(room,99);assert.ok(extra.messages.some(m=>m.type===MSG.KICK));
  for(let i=0;i<n-1;i++)clients[i].ws.send(encodeJson(MSG.READY,{ready:true}));
  await sleep(120);assert.equal((await state(room)).state,'lobby');
  clients[n-1].ws.send(encodeJson(MSG.READY,{ready:true}));
  const started=await until(async()=>{const x=await state(room);return x.state==='playing'?x:null;},9000);
  assert.equal(started.wave,1);assert.equal(started.players.length,n);assert.equal(started.difficulty.spawnMultiplier,+(1+(n-1)*.72).toFixed(2));
  // Observing never occupies a player slot and the API has no gameplay mutation path.
  assert.equal((await state(room)).connectedPlayers,n);
  if(n===1){
    const pid=crypto.randomUUID();
    // The host's reconnect token is in its original socket URL; test a separate room.
    const again=await create(1),first=await join(again,1,pid);
    first.ws.send(encodeJson(MSG.READY,{ready:true}));
    await until(async()=> (await state(again)).state==='playing').catch(async e=>{console.error('Reconnect setup failed',await state(again),first.messages);throw e;});
    first.ws.close();await until(async()=> (await state(again)).connectedPlayers===0);
    const rejoined=await join(again,2,pid);assert.equal(rejoined.welcome.playerId,first.welcome.playerId);
    assert.equal((await state(again)).players.length,1);
    console.log('PASS reconnect: same player retained during a running co-op match');
  }
  console.log('PASS live: '+n+' players, admission limit, all-ready gate, wave start, dashboard auth');
 }));
 console.log('PASS live integration');
}finally{for(const ws of sockets)ws.close();}
