// Synthetic participants for checking an actual Pleos WebView against the real room server.
// Every name is marked TEST. This is not physical-phone multiplayer evidence.
import {writeFileSync} from 'node:fs';
import {MSG,Reader,encodeJson,decodeJson,decodeSnapshot,encodeInput} from '../packages/shared/src/protocol.js';
const base=process.env.BASE||'http://127.0.0.1:8788';
const file=process.env.ZRIDE_DEMO_INFO;
const response=await fetch(base+'/api/zride/rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({players:4,hostName:'Pleos TEST'})});
if(!response.ok)throw Error('room create failed '+response.status);
const room=await response.json();if(file)writeFileSync(file,JSON.stringify({...room,testOnly:true,participants:'4 synthetic WebSocket clients'},null,2));
console.log('TEST room '+room.code+' / 4 synthetic participants');
const clients=[];
for(let index=0;index<4;index++){
 const ws=new WebSocket(base.replace('http','ws')+'/ws?code='+room.code+'&pid='+crypto.randomUUID());
 ws.binaryType='arraybuffer';const c={ws,index,seq:0,snapshot:null,id:null,ready:false};clients.push(c);
 const ready=()=>{if(!c.ready){c.ready=true;ws.send(encodeJson(MSG.READY,{ready:true}));}};
 ws.onopen=()=>ws.send(encodeJson(MSG.HELLO,{name:'TEST 생존자 '+(index+1),skin:index}));
 ws.onmessage=e=>{
  const reader=new Reader(new Uint8Array(e.data));const type=reader.u8();
  if(type===MSG.SNAPSHOT){c.snapshot=decodeSnapshot(reader);return;}
  if(type===MSG.WELCOME){c.id=decodeJson(reader).playerId;ready();}
  if(type===MSG.LOBBY){const lobby=decodeJson(reader);if(lobby.reason==='rematch')c.ready=false;if(lobby.state==='lobby')ready();}
  if(type===MSG.CHOICE){const choice=decodeJson(reader),card=choice.cards[0];if(card)ws.send(encodeJson(MSG.PICK,{id:card.id,kind:card.kind,slot:card.slot}));}
  if(type===MSG.END){c.ready=false;}
 };
 ws.onerror=()=>console.error('TEST socket error '+index);
 await new Promise(r=>setTimeout(r,100));
}
const timer=setInterval(()=>{
 for(const c of clients){
  const s=c.snapshot,p=s?.players.find(x=>x.id===c.id);if(!p||c.ws.readyState!==1)continue;
  let target=null,best=Infinity;
  for(const e of s.enemies){const d=Math.hypot(e.x-p.x,e.z-p.z);if(d<best){best=d;target=e;}}
  const time=s.matchTime;
  let dx=Math.cos(time*.7+c.index),dz=Math.sin(time*.7+c.index),fire=false;
  if(target){dx=target.x-p.x;dz=target.z-p.z;fire=true;}
  const len=Math.hypot(dx,dz)||1,nx=dx/len,nz=dz/len;
  const back=best<9?-1:best>18?.45:0;
  const mx=nx*back-nz*.65,mz=nz*back+nx*.65;
  c.ws.send(encodeInput(c.seq++&65535,{mx,mz,ax:nx,az:nz,fire,dash:s.tick%180===0,ab0:s.tick%120===0,weapon:0}));
 }
},50);
const stop=()=>{clearInterval(timer);for(const c of clients)c.ws.close();process.exit();};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
