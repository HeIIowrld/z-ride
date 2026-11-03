import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccounts} from '../accounts.mjs';
import {generateKeyPairSync,sign} from 'node:crypto';
import {OAuth2Client} from 'google-auth-library';

test('Google verifies signed identities and nonce, links a stable guest, and never merges by email',async()=>{
  let now=Date.now();const clientId='fixture.apps.googleusercontent.com',client=new OAuth2Client();
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const verifier=async({credential,audience})=>{const ticket=await client.verifySignedJwtWithCertsAsync(credential,{fixture:publicKey.export({type:'spki',format:'pem'})},audience,['accounts.google.com','https://accounts.google.com']);return ticket.getPayload();};
  const options={clock:()=>now,googleClientId:clientId,publicOrigin:'https://game.example',verifyGoogleIdToken:verifier};let a=createAccounts(options);
  const jwt=(nonce,sub='subject-a',extra={})=>{const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture'})).toString('base64url');const payload=Buffer.from(JSON.stringify({iss:'https://accounts.google.com',aud:clientId,sub,nonce,iat:Math.floor(now/1000),exp:Math.floor(now/1000)+3600,email:'same@example.test',...extra})).toString('base64url');const data=header+'.'+payload;return data+'.'+sign('RSA-SHA256',Buffer.from(data),privateKey).toString('base64url');};
  const guest=a.guest({nickname:'Guest'}),userId=guest.account.userId;
  const c=a.challenge({mode:'LINK'},guest.accountToken),credential=jwt(c.nonce);
  const plan=a.beginGoogle({challengeId:c.challengeId,credential},guest.accountToken);
  assert.throws(()=>a.beginGoogle({challengeId:c.challengeId,credential},guest.accountToken),{code:'AUTH_CHALLENGE_EXPIRED'});
  const verified=await a.verifyGoogle(credential,plan),linked=a.finishGoogle(plan,verified);
  assert.equal(linked.account.userId,userId);assert.equal(linked.account.kind,'GOOGLE');assert.throws(()=>a.authenticate(guest.accountToken),{code:'ACCOUNT_AUTH_REQUIRED'});
  const saved=a.durable();assert.ok(!JSON.stringify(saved).includes(credential));assert.ok(!JSON.stringify(saved).includes(linked.accountToken));
  a=createAccounts(options);a.restore(saved);assert.equal(a.authenticate(linked.accountToken).userId,userId);
  const login=async(sub,extra={})=>{const c=a.challenge({mode:'LOGIN'}),credential=jwt(c.nonce,sub,extra),p=a.beginGoogle({challengeId:c.challengeId,credential});return a.finishGoogle(p,await a.verifyGoogle(credential,p));};
  assert.equal((await login('subject-a')).account.userId,userId);assert.notEqual((await login('subject-b')).account.userId,userId);
  const another=a.guest({nickname:'Another'}),link=a.challenge({mode:'LINK'},another.accountToken),conflict=jwt(link.nonce),p=a.beginGoogle({challengeId:link.challengeId,credential:conflict},another.accountToken);
  assert.throws(()=>a.finishGoogle(p,verified),{code:'ACCOUNT_LINK_CONFLICT'});assert.equal(a.authenticate(another.accountToken).kind,'GUEST');
  const bad=a.challenge({}),badPlan=a.beginGoogle({challengeId:bad.challengeId,credential:'bad'});
  await assert.rejects(a.verifyGoogle(jwt('wrong-nonce'),badPlan),{code:'AUTH_PROVIDER_REJECTED'});
  await assert.rejects(a.verifyGoogle(jwt(bad.nonce,'subject-a',{aud:'another-client'}),badPlan),{code:'AUTH_PROVIDER_REJECTED'});
  await assert.rejects(a.verifyGoogle(jwt(bad.nonce).replace(/.$/,'!'),badPlan),{code:'AUTH_PROVIDER_REJECTED'});
  now+=28800001;assert.throws(()=>a.authenticate(linked.accountToken),{code:'ACCOUNT_AUTH_REQUIRED'});
});

test('party membership is many-history/one-active, explicit switching waits for approval and survives restore',()=>{
  let now=100000;let a=createAccounts({clock:()=>now});const credentials=a.guest({nickname:'Crew'}),u=a.authenticate(credentials.accountToken);
  const room=id=>({roomId:id}),member=id=>({memberId:id});
  const first=member('one'),plan=a.planJoin(u,'car-a',{expectedActivePartyId:null});a.pending(u,plan,first);
  assert.equal(a.view(u).activePartyId,null);a.activate(a.approval(room('car-a'),first));assert.equal(a.view(u).activePartyId,'car-a');
  assert.throws(()=>a.planJoin(u,'car-b',{expectedActivePartyId:'car-a'}),{code:'PARTY_SWITCH_CONFIRMATION_REQUIRED'});
  assert.throws(()=>a.planJoin(u,'car-b',{expectedActivePartyId:null,confirmSwitch:true}),{code:'PARTY_SWITCH_CONFLICT'});
  const second=member('two');a.pending(u,a.planJoin(u,'car-b',{expectedActivePartyId:'car-a',confirmSwitch:true}),second);
  assert.equal(a.view(u).activePartyId,'car-a');assert.equal(a.view(u).pendingPartyId,'car-b');
  const approval=a.approval(room('car-b'),second);a.activate(approval);assert.equal(a.view(u).activePartyId,'car-b');
  const saved=a.durable();a=createAccounts({clock:()=>now});a.restore(saved);const restored=a.authenticate(credentials.accountToken);
  assert.deepEqual(a.memberships(restored).memberships.map(m=>m.status),['SWITCHED','ACTIVE']);
  const third=member('three');a.pending(restored,a.planJoin(restored,'car-c',{expectedActivePartyId:'car-b',confirmSwitch:true}),third);now+=300001;
  assert.throws(()=>a.approval(room('car-c'),third),{code:'SWITCH_CONFIRMATION_EXPIRED'});a.depart(third,'CANCELLED');assert.equal(a.view(restored).activePartyId,'car-b');
  const refreshed=a.refresh(credentials.accountToken);assert.equal(refreshed.accountToken,credentials.accountToken);assert.equal(a.authenticate(refreshed.accountToken).userId,credentials.account.userId);
});

test('Google is unavailable without configuration, and expired challenges cannot be reused after restart',()=>{
  const disabled=createAccounts();assert.equal(disabled.describe().google.enabled,false);assert.throws(()=>disabled.challenge({}),{code:'AUTH_PROVIDER_DISABLED'});
  let now=100000;const options={clock:()=>now,publicOrigin:'https://game.example',googleClientId:'fixture.apps.googleusercontent.com'};let a=createAccounts(options);const c=a.challenge({});
  const saved=a.durable();now+=120001;a=createAccounts(options);a.restore(saved);assert.throws(()=>a.beginGoogle({challengeId:c.challengeId,credential:'token'}),{code:'AUTH_CHALLENGE_EXPIRED'});
});
