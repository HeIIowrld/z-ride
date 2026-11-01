// Optional isolated audit. Does not connect to or restart the running port-8000 demo.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { createDemoServer } from '../server.mjs';

const startedAt=new Date().toISOString(); const start=performance.now();
const durationMs=90000;
const app=createDemoServer(); const address=await app.listen(0);
const base=`http://127.0.0.1:${address.port}`;
const events=[];const clients=[];let reports;
function record(event,extra={}) {events.push({elapsedMs:Math.round(performance.now()-start),event,...extra});}
async function post(path,body,token) {
  const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  const value=await response.json();
  if(!response.ok)throw new Error('HTTP '+response.status+' '+(value.error?.code??'UNKNOWN'));
  return value;
}
async function connect(token,roomId,label) {
  const ws=new WebSocket(`ws://127.0.0.1:${address.port}/ws`);const waiters=new Map();
  let room=null;
  ws.on('error',error=>record(label+'.error',{message:error.message}));
  ws.on('close',(code,reason)=>record(label+'.close',{code,reason:reason.toString()}));
  ws.on('message',data=>{
    const message=JSON.parse(data);
    if(message.type==='snapshot'){
      if(room?.state!==message.room.state)record(label+'.state',{state:message.room.state,pauseReason:message.room.pauseReason});
      room=message.room;
    }
    const key=message.type==='auth.ok'?'auth':message.commandId;
    const waiter=waiters.get(key);
    if(waiter){waiters.delete(key);clearTimeout(waiter.timer);waiter.resolve(message);}
  });
  const wait=key=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Response timeout: '+key)),5000);waiters.set(key,{resolve,timer});});
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const auth=wait('auth');ws.send(JSON.stringify({type:'auth',token,roomId}));await auth;
  const client={ws,get room(){return room;},async send(payload){const promise=wait(payload.commandId);ws.send(JSON.stringify(payload));return promise;}};
  clients.push(client);record(label+'.authenticated');return client;
}
try {
  const host=await post('/api/session',{role:'CAR_HOST',nickname:'Liveness car'});
  const phone=await post('/api/session',{role:'PHONE',nickname:'Liveness passenger'});
  const room=await post('/api/rooms',{},host.token);
  const joined=await post('/api/join',{joinCode:room.joinCode,seat:'FRONT_PASSENGER'},phone.token);
  await post('/api/rooms/'+room.roomId+'/approve',{memberId:joined.memberId},host.token);
  const car=await connect(host.token,room.roomId,'car');const passenger=await connect(phone.token,room.roomId,'phone');
  let seq=0;
  const report=()=>car.send({type:'vehicle.report',commandId:randomUUID(),reportSeq:++seq,ux:'ALLOWED',gear:'P',foreground:true,seats:[],source:'ISOLATED_TEST_ADAPTER'});
  await report();await car.send({type:'command',commandId:randomUUID(),roomEpoch:car.room.roomEpoch,action:'round.start'});
  reports=setInterval(()=>report().catch(error=>record('report.error',{message:error.message})),2000);
  const stopReports=setTimeout(()=>{clearInterval(reports);record('vehicle_reports_stopped');console.log(JSON.stringify({phase:'idle_with_no_more_reports',elapsedMs:Math.round(performance.now()-start)}));},10000);
  console.log(JSON.stringify({phase:'isolated_audit_started',durationMs,httpTimeouts:{requestTimeout:app.server.requestTimeout,headersTimeout:app.server.headersTimeout,socketTimeout:app.server.timeout,keepAliveTimeout:app.server.keepAliveTimeout}}));
  await new Promise(resolve=>setTimeout(resolve,durationMs));
  clearTimeout(stopReports);clearInterval(reports);
  assert.equal(car.ws.readyState,WebSocket.OPEN);assert.equal(passenger.ws.readyState,WebSocket.OPEN);
  assert.equal(car.room.state,'PAUSED');assert.match(car.room.pauseReason,/LEASE_EXPIRED/);
  const collect=await passenger.send({type:'command',commandId:randomUUID(),roomEpoch:0,action:'mobile.collect',pickupId:'DEMO_PICKUP_A',passengerConfirmed:true});
  assert.equal(collect.ok,true);record('late_phone_command_accepted_after_idle');
  const result={startedAt,completedAt:new Date().toISOString(),passed:true,durationMs,actualElapsedMs:Math.round(performance.now()-start),
    scope:'isolated ephemeral localhost Node server plus two ws clients; not Android/emulator/ADB network',
    conclusions:['authenticated sockets remain OPEN after 90 seconds, including over 60 seconds without state traffic','lease expiration pauses battle and does not close WebSocket','late passenger command still works after idle'],
    events,livePort8000Touched:false,runtimeServerChanged:false};
  await writeFile(new URL('../ws-liveness-results.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({phase:'audit_passed',durationMs,actualElapsedMs:result.actualElapsedMs,unexpectedCloseEvents:events.filter(e=>e.event.endsWith('.close')).length}));
} catch(error) {
  await writeFile(new URL('../ws-liveness-results.json',import.meta.url),JSON.stringify({startedAt,completedAt:new Date().toISOString(),passed:false,error:String(error),events,livePort8000Touched:false},null,2)+'\n');
  throw error;
} finally {clearInterval(reports);for(const client of clients)client.ws.terminate();await app.close();}
