import {isIP} from 'node:net';
const fail=(code,message,status=400)=>Object.assign(new Error(message),{code,status});
export function checkedOrigin(value) {
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Expected exact HTTP(S) origin');
  return url.origin;
}
export function createRequestPolicy({allowedOrigins=[],trustedProxyAddresses=[]}={}) {
  const origins=new Set(allowedOrigins.map(checkedOrigin));
  const normalize=ip=>ip?.startsWith('::ffff:')?ip.slice(7):ip;
  const trusted=new Set(trustedProxyAddresses.map(value=>{if(!isIP(value))throw new Error('Trusted proxies must be explicit IP addresses');return normalize(value);}));
  function clientAddress(req) {
    let client=normalize(req.socket.remoteAddress)??'unknown';
    if(!trusted.has(client))return client;
    const header=req.headers['x-forwarded-for'];if(typeof header!=='string'||header.length>1024)return client;
    const chain=header.split(',').map(ip=>normalize(ip.trim()));if(chain.some(ip=>!isIP(ip)))return client;
    for(let i=chain.length-1;i>=0&&trusted.has(client);i--)client=chain[i];
    return client;
  }
  function acceptedOrigin(origin,req) {
    if(!origin)return true;
    try{return origins.has(checkedOrigin(origin))||new URL(origin).host===req.headers.host;}catch{return false;}
  }
  function apply(req,res,path) {
    if(!path.startsWith('/api/')&&path!=='/healthz')return false;
    const origin=req.headers.origin;
    res.setHeader('Vary','Origin');
    if(origin&&!acceptedOrigin(origin,req))throw fail('ORIGIN_FORBIDDEN','Browser origin not allowed',403);
    if(origin){res.setHeader('Access-Control-Allow-Origin',origin);}
    if(req.method!=='OPTIONS')return false;
    const method=req.headers['access-control-request-method'];
    const headers=String(req.headers['access-control-request-headers']??'').toLowerCase().split(',').map(v=>v.trim()).filter(Boolean);
    if(!origin||!['GET','POST'].includes(method)||headers.some(h=>!['authorization','content-type'].includes(h)))throw fail('PREFLIGHT_FORBIDDEN','Unsupported CORS preflight',403);
    req.resume();res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600','Content-Length':'0'});res.end();return true;
  }
  return {clientAddress,acceptedOrigin,apply,isSecure:req=>req.socket.encrypted===true||(trusted.has(normalize(req.socket.remoteAddress))&&req.headers['x-forwarded-proto']==='https')};
}
export function deploymentOptions(env=process.env) {
  const configured={...env,ZRIDE_BROWSER_API_ORIGIN:env.GAME_BROWSER_API_ORIGIN??env.ZRIDE_BROWSER_API_ORIGIN,ZRIDE_PHONE_PUBLIC_URL:env.GAME_PHONE_JOIN_URL??env.ZRIDE_PHONE_PUBLIC_URL,ZRIDE_ALLOWED_ORIGINS:env.GAME_ALLOWED_ORIGINS??env.ZRIDE_ALLOWED_ORIGINS,ZRIDE_OBSERVER_ALLOWED_ORIGINS:env.GAME_OBSERVER_ALLOWED_ORIGINS??env.ZRIDE_OBSERVER_ALLOWED_ORIGINS,ZRIDE_TRUSTED_PROXY_ADDRESSES:env.GAME_TRUSTED_PROXY_ADDRESSES??env.ZRIDE_TRUSTED_PROXY_ADDRESSES};
  const list=name=>(configured[name]??'').split(',').map(v=>v.trim()).filter(Boolean);
  const apiOrigin=configured.ZRIDE_BROWSER_API_ORIGIN?checkedOrigin(configured.ZRIDE_BROWSER_API_ORIGIN):'';
  let phonePublicUrl=configured.ZRIDE_PHONE_PUBLIC_URL??'';
  if(phonePublicUrl){const url=new URL(phonePublicUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Invalid phone public URL');phonePublicUrl=url.href;}
  const pickupRespawnMs=Number(env.ZRIDE_PICKUP_RESPAWN_MS??300000);
  return {allowedOrigins:list('ZRIDE_ALLOWED_ORIGINS').map(checkedOrigin),observerAllowedOrigins:list('ZRIDE_OBSERVER_ALLOWED_ORIGINS').map(checkedOrigin),trustedProxyAddresses:list('ZRIDE_TRUSTED_PROXY_ADDRESSES'),browserApiOrigin:apiOrigin,phonePublicUrl,pickupRespawnMs,displayName:env.GAME_DISPLAY_NAME??'Z-RIDE',googleClientId:env.GAME_GOOGLE_CLIENT_ID??'',eventPolicy:{durationMs:Number(env.ZRIDE_EVENT_DURATION_MS??1800000),respawnMs:Number(env.ZRIDE_EVENT_RESPAWN_MS??300000),target:Number(env.ZRIDE_EVENT_TARGET_PARTIES??3),missionReward:Number(env.ZRIDE_MISSION_REWARD_SUPPLIES??1),sharedReward:Number(env.ZRIDE_SHARED_REWARD_SUPPLIES??2)}};
}
