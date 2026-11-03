import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';

const clone=value=>structuredClone(value);
const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=(code,message,status=409)=>Object.assign(new Error(message),{code,status});
const secret=()=>randomBytes(32).toString('base64url');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&timingSafeEqual(Buffer.from(digest(a),'hex'),Buffer.from(digest(b),'hex'));

/** Stable phone identities. Tokens here never authorize vehicle reports or gameplay. */
export function createAccounts({clock=Date.now,sessionMs=28800000,capacity=10000,googleClientId='',publicOrigin='',verifyGoogleIdToken}={}) {
  let state={version:1,users:{},identities:{},sessions:{},challenges:{},memberships:{}};
  let googleClientPromise;
  const configured=!!googleClientId&&publicOrigin.startsWith('https://');
  function describe(){return {
    guest:{enabled:true,method:'PERSISTENT_ACCOUNT_TOKEN'},
    google:{enabled:configured,configured,clientId:configured?googleClientId:null,method:'ID_TOKEN_WITH_SERVER_NONCE',reason:configured?null:'HTTPS_AND_CLIENT_ID_REQUIRED'},
    pleos:{enabled:false,purpose:'VEHICLE_DATA_OWNER_AUTHORIZATION',generalGameLogin:false,reason:'REGION_SUPPORT_AND_API_APPROVAL_REQUIRED'},
  };}
  function bounded(collection){if(Object.keys(collection).length>=capacity)throw fail('ACCOUNT_CAPACITY','Account service capacity reached',429);}
  function authenticate(token){const s=typeof token==='string'&&state.sessions[digest(token)];if(!s||s.expiresAt<=clock())throw fail('ACCOUNT_AUTH_REQUIRED','Valid phone account token required',401);return state.users[s.userId];}
  function view(user){const active=state.memberships[user.activeMembershipId],pending=state.memberships[user.pendingMembershipId];return {userId:user.userId,kind:user.kind,displayName:user.displayName,createdAt:user.createdAt,activePartyId:active?.partyId??null,activePartyName:active?.partyName??null,pendingPartyId:pending?.partyId??null,pendingPartyName:pending?.partyName??null};}
  function issue(user){bounded(state.sessions);const token=secret(),expiresAt=clock()+sessionMs;state.sessions[digest(token)]={userId:user.userId,expiresAt};return {accountToken:token,tokenPurpose:'PHONE_ACCOUNT',expiresAt,account:view(user)};}
  function guest(body){if(typeof body.nickname!=='string'||body.nickname.trim().length<1||body.nickname.length>24)throw fail('INVALID_NICKNAME','Nickname 1..24 required',400);bounded(state.users);bounded(state.sessions);
    const user={userId:randomUUID(),kind:'GUEST',displayName:body.nickname.trim(),createdAt:clock(),activeMembershipId:null,pendingMembershipId:null};state.users[user.userId]=user;return issue(user);
  }
  function profile(user,body){if(typeof body.displayName!=='string'||body.displayName.trim().length<1||body.displayName.length>24)throw fail('INVALID_NICKNAME','Display name 1..24 required',400);user.displayName=body.displayName.trim();return view(user);}
  function refresh(token){const u=authenticate(token);bounded(state.sessions);const result=issue(u);delete state.sessions[digest(token)];return result;}
  function logout(token){authenticate(token);delete state.sessions[digest(token)];return {loggedOut:true,partyParticipationRetained:true};}
  function challenge(body,token){
    if(!configured)throw fail('AUTH_PROVIDER_DISABLED','Configure HTTPS and Google client ID',503);
    const mode=body.mode??'LOGIN';if(!['LOGIN','LINK'].includes(mode))throw fail('INVALID_AUTH_MODE','LOGIN or LINK required',400);
    const u=mode==='LINK'?authenticate(token):null;
    if(u?.kind!=='GUEST')if(mode==='LINK')throw fail('ACCOUNT_ALREADY_LINKED','Only a guest can link a Google identity');
    bounded(state.challenges);const challengeId=secret(),nonce=secret(),expiresAt=clock()+120000;
    state.challenges[digest(challengeId)]={nonceDigest:digest(nonce),expiresAt,mode,userId:u?.userId??null,consumed:false};
    return {challengeId,nonce,expiresAt,clientId:googleClientId,mode};
  }
  function beginGoogle(body,token){
    if(!configured)throw fail('AUTH_PROVIDER_DISABLED','Google login is not configured',503);
    const c=typeof body.challengeId==='string'&&state.challenges[digest(body.challengeId)];
    if(!c||c.consumed||c.expiresAt<=clock())throw fail('AUTH_CHALLENGE_EXPIRED','Start a new Google login',401);
    if(typeof body.credential!=='string'||body.credential.length<1||body.credential.length>12000)throw fail('INVALID_CREDENTIAL','ID token required',400);
    if(c.mode==='LINK'&&authenticate(token).userId!==c.userId)throw fail('ACCOUNT_LINK_CONFLICT','Use the account that began linking');
    c.consumed=true;return clone(c);
  }
  async function verifyGoogle(credential,plan){
    let claims;
    try{
      if(verifyGoogleIdToken)claims=await verifyGoogleIdToken({credential,audience:googleClientId});
      else {const client=await (googleClientPromise??=import('google-auth-library').then(({OAuth2Client})=>new OAuth2Client({clientId:googleClientId,transporterOptions:{timeout:5000}})));claims=(await client.verifyIdToken({idToken:credential,audience:googleClientId})).getPayload();}
    }catch{throw fail('AUTH_PROVIDER_REJECTED','Google token verification failed',401);}
    const now=clock()/1000,audience=Array.isArray(claims?.aud)?claims.aud:[claims?.aud];
    if(!claims||!['accounts.google.com','https://accounts.google.com'].includes(claims.iss)||!audience.includes(googleClientId)||typeof claims.sub!=='string'||!claims.sub.length||claims.sub.length>255||
      !Number.isFinite(claims.exp)||claims.exp<=now||!Number.isFinite(claims.iat)||claims.iat>now+300||typeof claims.nonce!=='string'||!equal(digest(claims.nonce),plan.nonceDigest))throw fail('AUTH_PROVIDER_REJECTED','Invalid Google identity or nonce',401);
    return {identityKey:digest('https://accounts.google.com:'+claims.sub)};
  }
  function finishGoogle(plan,verified){
    bounded(state.sessions);const old=state.identities[verified.identityKey];let user;
    if(plan.mode==='LINK'){
      user=state.users[plan.userId];if(!user||user.kind!=='GUEST')throw fail('ACCOUNT_LINK_CONFLICT','Guest changed while linking');
      if(old&&old!==user.userId)throw fail('ACCOUNT_LINK_CONFLICT','Google identity already belongs to another account; no automatic merge');
    }else if(old)user=state.users[old];
    else {bounded(state.users);user={userId:randomUUID(),kind:'GOOGLE',displayName:'플레이어',createdAt:clock(),activeMembershipId:null,pendingMembershipId:null};state.users[user.userId]=user;}
    state.identities[verified.identityKey]=user.userId;user.kind='GOOGLE';if(plan.mode==='LINK')for(const [key,s]of Object.entries(state.sessions))if(s.userId===user.userId)delete state.sessions[key];return {...issue(user),linked:plan.mode==='LINK'};
  }
  function membershipView(m){return {membershipId:m.membershipId,partyId:m.partyId,partyName:m.partyName??'차량 파티',memberId:m.memberId,status:m.status,joinedAt:m.joinedAt,endedAt:m.endedAt};}
  function memberships(user){return {account:view(user),memberships:Object.values(state.memberships).filter(m=>m.userId===user.userId).map(membershipView)};}
  function planJoin(user,partyId,body){
    const active=state.memberships[user.activeMembershipId];
    if(user.pendingMembershipId)throw fail('PENDING_JOIN_EXISTS','Cancel the pending request before another invitation');
    if(active?.partyId===partyId)throw fail('ALREADY_IN_PARTY','Resume the current party using a game ticket');
    if(body.expectedActivePartyId!==(active?.partyId??null))throw fail('PARTY_SWITCH_CONFLICT','Refresh current party before accepting');
    if(active&&body.confirmSwitch!==true)throw fail('PARTY_SWITCH_CONFIRMATION_REQUIRED','Explicitly confirm changing vehicles');
    bounded(state.memberships);return {userId:user.userId,partyId,fromMembershipId:user.activeMembershipId,consentedAt:clock()};
  }
  function pending(user,plan,member){const m={membershipId:randomUUID(),userId:user.userId,partyId:plan.partyId,partyName:plan.partyName??'차량 파티',memberId:member.memberId,status:'PENDING',joinedAt:clock(),endedAt:null,fromMembershipId:plan.fromMembershipId,consentedAt:plan.consentedAt};
    state.memberships[m.membershipId]=m;user.pendingMembershipId=m.membershipId;member.accountUserId=user.userId;member.accountMembershipId=m.membershipId;return membershipView(m);
  }
  function approval(room,member){
    if(!member.accountUserId)return null;
    const user=state.users[member.accountUserId],m=state.memberships[member.accountMembershipId];
    if(m?.status==='ACTIVE'&&user.activeMembershipId===m.membershipId)return null;
    if(!m||m.partyId!==room.roomId||m.status!=='PENDING'||user.pendingMembershipId!==m.membershipId||user.activeMembershipId!==m.fromMembershipId)throw fail('PARTY_SWITCH_CONFLICT','Account party changed; request approval again');
    if(m.fromMembershipId&&clock()-m.consentedAt>300000)throw fail('SWITCH_CONFIRMATION_EXPIRED','Confirm the vehicle change again');
    return {user,m,old:state.memberships[user.activeMembershipId]??null};
  }
  function activate(plan){if(!plan)return;const {user,m,old}=plan;if(old){old.status='SWITCHED';old.endedAt=clock();}m.status='ACTIVE';user.activeMembershipId=m.membershipId;user.pendingMembershipId=null;}
  function depart(member,status){
    const user=state.users[member.accountUserId],m=state.memberships[member.accountMembershipId];if(!user||!m)return;
    if(user.activeMembershipId===m.membershipId)user.activeMembershipId=null;if(user.pendingMembershipId===m.membershipId)user.pendingMembershipId=null;
    if(['PENDING','ACTIVE'].includes(m.status)){m.status=status;m.endedAt=clock();}
  }
  function active(user){const m=state.memberships[user.activeMembershipId];return m?.status==='ACTIVE'?clone(m):null;}
  function pendingOf(user){const m=state.memberships[user.pendingMembershipId];return m?.status==='PENDING'?clone(m):null;}
  function personalHistory(user,results){
    const own=new Set(Object.values(state.memberships).filter(m=>m.userId===user.userId).map(m=>m.partyId+':'+m.memberId));
    return results.filter(r=>r.participants.some(m=>own.has(r.partyId+':'+m.memberId))).map(r=>({resultId:r.resultId,partyId:r.partyId,missionRunId:r.missionRunId,scenarioId:r.scenarioId,outcome:r.outcome,endedAt:r.endedAt,
      ownInteractions:r.contributions.filter(c=>own.has(r.partyId+':'+c.memberId)).length}));
  }
  function prune(){let changed=false;for(const [k,c]of Object.entries(state.challenges))if(c.expiresAt<=clock()){delete state.challenges[k];changed=true;}for(const [k,s]of Object.entries(state.sessions))if(s.expiresAt<=clock()){delete state.sessions[k];changed=true;}return changed;}
  return {describe,authenticate,view,guest,profile,refresh,logout,challenge,beginGoogle,verifyGoogle,finishGoogle,memberships,planJoin,pending,approval,activate,depart,active,pendingOf,personalHistory,prune,
    durable:()=>clone(state),restore:saved=>{if(saved){if(saved.version!==1)throw new Error('Unknown account format');state=clone(saved);}}};
}
