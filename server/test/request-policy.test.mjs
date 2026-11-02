import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequestPolicy,deploymentOptions} from '../request-policy.mjs';
import {createDemoServer} from '../server.mjs';
test('proxy identity trusts only explicit peers and walks forwarding chains from the right',()=>{
  const p=createRequestPolicy({trustedProxyAddresses:['127.0.0.1']});
  const req=(remote,header)=>({socket:{remoteAddress:remote},headers:{'x-forwarded-for':header}});
  assert.equal(p.clientAddress(req('198.51.100.1','1.1.1.1')),'198.51.100.1');
  assert.equal(p.clientAddress(req('127.0.0.1','1.1.1.1, 198.51.100.2')),'198.51.100.2');
  assert.equal(p.clientAddress(req('::ffff:127.0.0.1','203.0.113.2')),'203.0.113.2');
  assert.equal(p.clientAddress(req('127.0.0.1','invalid')),'127.0.0.1');
  assert.throws(()=>createRequestPolicy({allowedOrigins:['*']}));
  assert.throws(()=>deploymentOptions({ZRIDE_BROWSER_API_ORIGIN:'https://api.example.test/path'}));
});
test('configured browser origins get bounded CORS and QR frontend URL without exposing credentials',async()=>{
  const app=createDemoServer({allowedOrigins:['https://play.hjpark.net'],publicOrigin:'https://api.hjpark.net',phonePublicUrl:'https://play.hjpark.net/zride/',browserApiOrigin:'https://api.hjpark.net'});const a=await app.listen(0),base=`http://127.0.0.1:${a.port}`;
  try{
    const preflight=await fetch(base+'/api/session',{method:'OPTIONS',headers:{origin:'https://play.hjpark.net','access-control-request-method':'POST','access-control-request-headers':'authorization, content-type'}});
    assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'https://play.hjpark.net');assert.equal(preflight.headers.get('access-control-allow-credentials'),null);
    assert.equal((await fetch(base+'/healthz',{headers:{origin:'https://evil.example'}})).status,403);
    const cfg=await fetch(base+'/play/config.js');assert.ok((await cfg.text()).includes('https://api.hjpark.net'));assert.ok(cfg.headers.get('content-security-policy').includes('wss://api.hjpark.net'));
    const post=async(path,body,token)=>(await fetch(base+path,{method:'POST',headers:{origin:'https://play.hjpark.net','content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)})).json();
    const host=await post('/api/session',{role:'CAR_HOST',nickname:'Domain test'}),room=await post('/api/rooms',{},host.token),invite=await post('/api/rooms/'+room.roomId+'/party/invite',{},host.token);
    assert.ok(invite.joinUrl.startsWith('https://play.hjpark.net/zride/#invite='));
  }finally{await app.close();}
});
