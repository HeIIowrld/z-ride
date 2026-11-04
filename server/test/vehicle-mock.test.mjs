import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {WebSocket} from 'ws';
import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';
import {createDemoServer} from '../server.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<300;i++){if(fn())return;await delay(10);}throw new Error('Mock did not reach expected state');}

test('vehicle screen generates a decodable QR and manually approves the same phone party through real REST/WS',async()=>{
  const app=createDemoServer({testAccessKey:'fixture-key',publicOrigin:'http://phone.example.test'}),address=await app.listen(0),base='http://127.0.0.1:'+address.port;
  const elements=new Map(),events=[],sockets=[],timers=new Set(),window=new EventTarget();
  function element(id){if(!elements.has(id))elements.set(id,{value:'',textContent:'',hidden:false,disabled:false,children:[],handlers:{},width:0,height:0,
    addEventListener(name,fn){this.handlers[name]=fn;},append(...rows){this.children.push(...rows);},prepend(row){this.children.unshift(row);},replaceChildren(...rows){this.children=rows;},removeAttribute(name){delete this[name];},
    getContext(){const self=this;return {fillStyle:'#fff',fillRect(x,y,w,h){if(!self.pixels||self.pixels.length!==self.width*self.height*4)self.pixels=new Uint8ClampedArray(self.width*self.height*4);const v=this.fillStyle==='#fff'?255:0;for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++){const n=(j*self.width+i)*4;self.pixels.set([v,v,v,255],n);}}};}});return elements.get(id);}
  window.GAME_CONFIG={apiOrigin:base};window.parent={postMessage:event=>events.push(event)};
  const intervals=new Set();
  class MockSocket extends WebSocket {constructor(){super(base.replace(/^http/,'ws')+'/ws');sockets.push(this);}}
  vm.runInNewContext(readFileSync(new URL('../phone-client/vehicle.js',import.meta.url),'utf8'),{
    window,location:{origin:base},document:{hidden:false,getElementById:element,createElement:()=>element('created-'+elements.size),addEventListener(){}},
    fetch,WebSocket:MockSocket,qrcode,crypto:globalThis.crypto,URL,AbortSignal,Date,
    setTimeout:(fn,ms)=>{const t=setTimeout(fn,ms);timers.add(t);return t;},clearTimeout,
    setInterval:fn=>{intervals.add(fn);return fn;},clearInterval:fn=>intervals.delete(fn),
  });
  const api=async(path,body,token)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;};
  try{
    await until(()=>!element('host-create').disabled);
    element('host-key').value='fixture-key';element('host-name').value='TEST MOCK CAR';element('host-gear').value='P';
    element('host-form').handlers.submit({preventDefault(){}});await until(()=>events.some(e=>e.type==='mock:invite')).catch(e=>{throw new Error(element('host-error').textContent+' '+element('host-log').children.map(r=>r.textContent).join(';'),{cause:e});});
    assert.equal(element('host-key').value,'');
    const canvas=element('invite-qr'),decoded=jsQR(canvas.pixels,canvas.width,canvas.height);assert.ok(decoded,'QR pixels must decode independently');
    const invitation=events.find(e=>e.type==='mock:invite');assert.equal(decoded.data,invitation.joinUrl);
    const cap=new URLSearchParams(new URL(decoded.data).hash.slice(1)).get('invite');assert.ok(cap);
    const guest=await api('/api/accounts/guest',{nickname:'TEST MOCK PHONE'}),joined=await api('/api/me/invitations/accept',{inviteToken:cap,seat:'REAR_LEFT',passengerConfirmed:true,expectedActivePartyId:null},guest.accountToken);
    assert.equal(joined.pending,true);await until(()=>events.some(e=>e.stage==='REQUESTED'));
    const row=element('host-members').children.find(row=>row.children[0].textContent.includes('TEST MOCK PHONE'));
    const approve=row.children.find(child=>child.textContent==='이 좌석 승인');assert.ok(approve);await approve.handlers.click();
    const ticket=await api('/api/me/party-ticket',{},guest.accountToken);assert.equal(ticket.roomId,joined.roomId);
    const phone=new WebSocket(base.replace(/^http/,'ws')+'/ws');sockets.push(phone);await new Promise((resolve,reject)=>{phone.once('open',resolve);phone.once('error',reject);});phone.send(JSON.stringify({type:'auth',token:ticket.token,roomId:ticket.roomId}));
    await until(()=>events.some(e=>e.stage==='CONNECTED'));assert.ok(element('host-summary').textContent.includes('승인 1명'));
    await element('host-close').handlers.click();assert.ok(events.some(e=>e.stage==='CLOSED'));
    assert.ok(!element('host-log').children.some(row=>row.textContent.includes('fixture-key')||row.textContent.includes(cap)||row.textContent.includes(guest.accountToken)));
  }finally{window.dispatchEvent(new Event('pagehide'));for(const t of timers)clearTimeout(t);for(const socket of sockets)socket.terminate();await app.close();}
});
