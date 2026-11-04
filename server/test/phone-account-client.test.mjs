import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createDemoServer} from '../server.mjs';

const source=readFileSync(new URL('../phone-client/account.js',import.meta.url),'utf8');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){for(let i=0;i<300;i++){if(predicate())return;await delay(10);}throw new Error('Browser action did not settle');}
function browser(base,storage=new Map(),hash=''){
  const elements=new Map(),window=new EventTarget(),intervals=new Set();
  const element=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,value:'',checked:false,textContent:'',handlers:{},addEventListener(name,fn){this.handlers[name]=fn;},replaceChildren(){}});return elements.get(id);};
  const location={origin:'https://hyundai.hjpark.net',pathname:'/play',search:'',hash};
  element('guest-button').disabled=true;element('google-start').disabled=true;
  let googleOptions,buttonRendered=false;
  window.GAME_CONFIG={apiOrigin:''};window.google={accounts:{id:{initialize(options){googleOptions=options;},renderButton(){buttonRendered=true;}}}};
  const timers=new Set();
  vm.runInNewContext(source,{
    window,location,history:{replaceState(){location.hash='';}},document:{getElementById:element,hidden:false},
    sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    fetch:(url,options)=>fetch(base+new URL(url).pathname,{...options,headers:{...options.headers,'x-forwarded-proto':'https'}}),
    setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timers.add(timer);return timer;},clearTimeout,
    setInterval:fn=>{intervals.add(fn);return fn;},clearInterval:fn=>intervals.delete(fn),
    URL,URLSearchParams,AbortController,CustomEvent,Date,Promise,
  });
  return {window,storage,element,location,click:id=>element(id).handlers.click(),google:()=>googleOptions,rendered:()=>buttonRendered,
    poll:()=>Promise.all([...intervals].map(fn=>fn())),close:()=>{for(const t of timers)clearTimeout(t);window.dispatchEvent(new Event('pagehide'));}};
}

test('phone page links guest Google identity, resumes on reload and joins a car only after HOST approval',async()=>{
  const origin='https://hyundai.hjpark.net',clientId='fixture.apps.googleusercontent.com';
  const app=createDemoServer({publicOrigin:origin,googleClientId:clientId,trustedProxyAddresses:['127.0.0.1'],verifyGoogleIdToken:async({credential})=>JSON.parse(credential)});
  const address=await app.listen(0),base='http://127.0.0.1:'+address.port,browsers=[];
  const api=async(path,body,token)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-forwarded-proto':'https',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();};
  const accountToken=b=>b.storage.get('phone-account-v1:'+origin);
  const credential=nonce=>JSON.stringify({iss:'https://accounts.google.com',aud:clientId,sub:'stable-subject',iat:Date.now()/1000,exp:Date.now()/1000+300,nonce,name:'Google passenger'});
  try{
    const b=browser(base);browsers.push(b);await until(()=>!b.element('guest-button').disabled);
    b.element('account-nickname').value='Guest';b.click('guest-button');await until(()=>!!accountToken(b));
    const initial=(await api('/api/me',undefined,accountToken(b))).account;
    b.click('google-start');await until(()=>b.rendered()&&!b.element('google-start').disabled);
    assert.equal(b.google().client_id,clientId);assert.ok(b.google().nonce);
    b.google().callback({credential:credential(b.google().nonce)});
    await until(()=>b.element('account-status').textContent.includes('· Google'));
    assert.equal((await api('/api/me',undefined,accountToken(b))).account.userId,initial.userId);
    const oldToken=accountToken(b);b.close();
    const reload=browser(base,b.storage);browsers.push(reload);await until(()=>reload.element('account-status').textContent.includes('· Google'));
    assert.equal(accountToken(reload),oldToken);

    const host=await api('/api/session',{role:'CAR_HOST',nickname:'Car'}),room=await api('/api/rooms',{},host.token);
    const invite=await api('/api/rooms/'+room.roomId+'/party/invite',{},host.token);
    // The QR capability is removed from the visible URL before any Google script loads.
    reload.location.hash=new URL(invite.joinUrl).hash;reload.window.dispatchEvent(new Event('hashchange'));
    assert.equal(reload.location.hash,'');await until(()=>reload.element('invite-status').textContent.includes('승인 후'));
    const joined=await reload.window.PHONE_ACCOUNT.join('REAR_LEFT',true);
    assert.equal(joined.pending,true);assert.equal((await api('/api/me',undefined,accountToken(reload))).account.activePartyId,null);
    let ticket;reload.window.addEventListener('phone:ticket',event=>{ticket=event.detail;});
    await reload.poll();assert.equal(ticket,undefined);
    await api('/api/rooms/'+room.roomId+'/approve',{memberId:joined.memberId},host.token);
    await Promise.all([reload.poll(),reload.poll()]);assert.equal(ticket.roomId,room.roomId);assert.equal(ticket.tokenPurpose,'PARTY_PLAY');
    assert.notEqual(ticket.token,accountToken(reload));
    reload.click('account-logout');await until(()=>!accountToken(reload));
    const login=browser(base);browsers.push(login);await until(()=>!login.element('google-start').disabled);
    login.click('google-start');await until(()=>login.rendered()&&!login.element('google-start').disabled);
    login.google().callback({credential:credential(login.google().nonce)});
    await until(()=>login.element('account-status').textContent.includes('· Google'));
    assert.equal((await api('/api/me',undefined,accountToken(login))).account.userId,initial.userId);
  }finally{for(const b of browsers)b.close();await app.close();}
});

test('phone client never silently creates a guest when restoring an expired credential',async()=>{
  const app=createDemoServer(),a=await app.listen(0),base='http://127.0.0.1:'+a.port;
  const storage=new Map([['phone-account-v1:https://hyundai.hjpark.net','expired-fixture']]),b=browser(base,storage);
  try{await until(()=>!b.element('guest-button').disabled);assert.equal(storage.size,0);assert.ok(b.element('account-error').textContent.includes('만료'));assert.ok(b.element('account-status').textContent.includes('시작한 뒤'));}
  finally{b.close();await app.close();}
});
