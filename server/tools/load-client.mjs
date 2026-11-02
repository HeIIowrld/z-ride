/** Bounded correctness/load probe for tools/load-server.mjs only; refuses production. */
import {WebSocket} from 'ws';
import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
const [base,countText,profile='active',durationText='25',output='load-result.json',guard]=process.argv.slice(2);
if(guard!=='--isolated-benchmark'||!base||!['idle','active','mixed'].includes(profile))throw new Error('Explicit isolated benchmark guard required');
const count=Number(countText),duration=Number(durationText);if(!Number.isInteger(count)||count<4||count>104||count%4||duration<10||duration>300)throw new Error('4..104 users in complete parties, duration 10..300s');
const metricsBase=new URL(base);metricsBase.port='18081';
const metrics=async(path='')=>{const r=await fetch(metricsBase.origin+'/'+path,{signal:AbortSignal.timeout(10000)});const v=await r.json();if(typeof v.case!=='string'||!Number.isFinite(v.rssMiB))throw new Error('Not a benchmark server');return v;};
await metrics();
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),clients=[],parties=[],latencies=[],syncLatencies=[],errors={},timers=[];
let measured=false,stopping=false,attempted=0,success=0,skipped=0,httpAttempted=0,httpSuccess=0,rejections=0,unexpectedCloses=0,sequence=0,bytesReceived=0;
const error=code=>{if(measured)errors[code]=(errors[code]??0)+1;};
async function api(path,body,token,setup=false){
  if(setup)await sleep(110);const start=performance.now();if(measured)httpAttempted++;
  try{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});const value=await r.json();if(measured)latencies.push(performance.now()-start);if(!r.ok){error(value.error?.code??'HTTP_'+r.status);throw new Error(value.error?.code??'HTTP_'+r.status);}if(measured)httpSuccess++;return value;}catch(e){if(e.name==='TimeoutError')error('HTTP_TIMEOUT');throw e;}
}
async function connect(token,roomId,role){
  const ws=new WebSocket(base.replace(/^http/,'ws')+'/ws'),pending=new Map();let room,auth;
  const c={ws,role,token,roomId,get room(){return room;},pending,send(message){
    if(ws.readyState!==WebSocket.OPEN)return Promise.reject(new Error('WS_CLOSED'));
    const commandId='load-'+(++sequence),start=performance.now(),wasMeasured=measured;
    if(wasMeasured)attempted++;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(commandId);if(wasMeasured)error('WS_TIMEOUT');reject(new Error('WS_TIMEOUT'));},5000);pending.set(commandId,{resolve,reject,timer,start,wasMeasured});ws.send(JSON.stringify({...message,commandId}));});
  }};
  ws.on('error',()=>{});ws.on('close',()=>{if(measured&&!stopping)unexpectedCloses++;for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('WS_CLOSED'));}pending.clear();});
  ws.on('message',bytes=>{if(measured)bytesReceived+=bytes.length;const m=JSON.parse(bytes);if(m.type==='auth.ok')auth=m;if(m.type==='snapshot'){room=m.room;const last=m.room.stats?.lastShot;if(measured&&last?.accepted&&last.memberId===c.lastShotMemberId&&c.lastFireStart){syncLatencies.push(performance.now()-c.lastFireStart);c.lastFireStart=0;}}
    const p=pending.get(m.commandId);if(p){clearTimeout(p.timer);pending.delete(m.commandId);if(p.wasMeasured)latencies.push(performance.now()-p.start);if(m.ok){if(p.wasMeasured)success++;p.resolve(m);}else{if(p.wasMeasured)error(m.error?.code??'WS_ERROR');p.reject(new Error(m.error?.code));}}});
  try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('WS_CONNECT_TIMEOUT')),5000);ws.once('open',()=>{clearTimeout(timer);resolve();});ws.once('error',e=>{clearTimeout(timer);reject(e);});ws.once('unexpected-response',(_req,res)=>{clearTimeout(timer);res.resume();reject(new Error('WS_HTTP_'+res.statusCode));});});
    ws.send(JSON.stringify({type:'auth',token,roomId}));const until=Date.now()+5000;while(!auth||!room){if(Date.now()>until)throw new Error('WS_AUTH_TIMEOUT');await sleep(5);}clients.push(c);return c;
  }catch(e){rejections++;ws.terminate();return null;}
}
const report=async p=>p.car?.send({type:'vehicle.report',reportSeq:++p.reportSeq,ux:'ALLOWED',gear:'P',foreground:true,seats:[],source:'SIMULATED_LOAD_NO_SDK'});
const percentile=(values,p)=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return +sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))].toFixed(2);};
let result;
try{
  for(let i=0;i<count/4;i++){
    const host=await api('/api/session',{role:'CAR_HOST',nickname:'LOAD HOST '+i},null,true),created=await api('/api/rooms',{},host.token,true);
    const p={roomId:created.roomId,host,reportSeq:0,phones:[],car:await connect(host.token,created.roomId,'CAR_HOST')};parties.push(p);
    if(profile!=='idle'&&p.car){await report(p);timers.push(setInterval(()=>{if(!p.car.pending.size)report(p).catch(e=>error(e.message));else if(measured)skipped++;},2000));}
    const invite=await api('/api/rooms/'+p.roomId+'/party/invite',{},host.token,true),inviteToken=invite.joinUrl.split('invite=')[1];
    for(const seat of ['REAR_LEFT','REAR_RIGHT','FRONT_PASSENGER']){
      const phone=await api('/api/invites/redeem',{inviteToken,nickname:'LOAD '+seat,seat,passengerConfirmed:true},null,true);
      await api('/api/rooms/'+p.roomId+'/approve',{memberId:phone.memberId,allowManualUnknown:true},host.token,true);
      const c=await connect(phone.token,p.roomId,seat);if(c){c.lastShotMemberId=phone.memberId;p.phones.push(c);}
    }
  }
  if(profile!=='idle')for(const p of parties)if(p.car&&p.phones.length){await report(p);await p.car.send({type:'command',action:'round.start',roomEpoch:p.car.room.roomEpoch});}
  await metrics('reset');measured=true;const start=performance.now();
  if(profile!=='idle')for(const p of parties)for(const c of p.phones){
    const angleDeg={REAR_LEFT:-70,REAR_RIGHT:100,FRONT_PASSENGER:0}[c.role];
    const begin=setTimeout(()=>{if(stopping)return;timers.push(setInterval(()=>{if(c.pending.size){skipped++;return;}if(c.room?.state!=='PLAYING'){error('NOT_PLAYING_CLIENT');return;}c.lastFireStart=performance.now();c.send({type:'command',action:'fire',roomEpoch:c.room.roomEpoch,angleDeg}).catch(e=>error(e.message));},500));},Math.random()*500);timers.push(begin);
    if(profile==='mixed')timers.push(setInterval(()=>api('/api/world/nearby',{latitude:37.5665,longitude:126.978,radiusM:500},c.token).catch(()=>{}),5000+Math.random()*1000));
  }
  await sleep(duration*1000);measured=false;stopping=true;for(const timer of timers)clearInterval(timer);
  const resource=await metrics();
  result={profile,requestedUsers:count,connectedUsers:clients.length,rejectedConnections:rejections,durationSec:+((performance.now()-start)/1000).toFixed(2),attempted,successfulCommands:success,skipped,errors,unexpectedCloses,httpAttempted,httpSuccess,latencyP50Ms:percentile(latencies,.5),latencyP95Ms:percentile(latencies,.95),latencyP99Ms:percentile(latencies,.99),snapshotP95Ms:percentile(syncLatencies,.95),receivedMiB:+(bytesReceived/1048576).toFixed(2),server:resource};
  await writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{stopping=true;measured=false;for(const timer of timers)clearInterval(timer);for(const c of clients)c.ws.terminate();}
