/** API-only center-console/phone account mock. No real SDK, Google login or private values in output. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const base=process.argv[2]??'http://127.0.0.1:8000',cars=[];let accountToken;
async function api(method,path,body,token){const r=await fetch(base+path,{method,signal:AbortSignal.timeout(12000),headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error('HTTP_'+r.status+'_'+data.error?.code);return data;}
const post=(path,body,token)=>api('POST',path,body,token),get=(path,token)=>api('GET',path,undefined,token);
const step=(name,method,path,detail={})=>console.log(JSON.stringify({step:name,method,path,source:'SIMULATED_NO_SDK',...detail}));
try{
  const config=await get('/api/client-config');step('PHONE_CONFIG','GET','/api/client-config',{displayName:config.displayName,googleEnabled:config.auth.google.enabled});
  for(const label of ['A','B']){
    const host=await post('/api/session',{role:'CAR_HOST',nickname:'TEST ACCOUNT CAR '+label,accessKey:process.env.ZRIDE_TEST_ACCESS_KEY??process.env.GAME_TEST_ACCESS_KEY});
    const room=await post('/api/rooms',{},host.token),path='/api/rooms/'+room.roomId;cars.push({host,room,path});
    await post(path+'/party',{commandId:randomUUID(),visible:false,name:'TEST CAR '+label,spotId:null},host.token);
  }
  const guest=await post('/api/accounts/guest',{nickname:'TEST ACCOUNT PHONE'});accountToken=guest.accountToken;const userId=guest.account.userId;
  step('PHONE_GUEST_LOGIN','POST','/api/accounts/guest',{tokenPurpose:guest.tokenPurpose});
  async function invite(car){const data=await post(car.path+'/party/invite',{},car.host.token);return new URL(data.joinUrl).hash.slice('#invite='.length);}
  const a=cars[0],b=cars[1],firstInvite=await invite(a);
  step('CONSOLE_QR','POST','/api/rooms/{roomId}/party/invite',{qrContains:'short-lived invitation URL only'});
  await post('/api/invites/preview',{inviteToken:firstInvite},accountToken);step('PHONE_SCAN_QR','POST','/api/invites/preview');
  const first=await post('/api/me/invitations/accept',{inviteToken:firstInvite,seat:'REAR_LEFT',passengerConfirmed:true,expectedActivePartyId:null},accountToken);
  assert.equal(first.pending,true);step('PHONE_REQUEST_JOIN','POST','/api/me/invitations/accept',{pending:true});
  await post(a.path+'/approve',{memberId:first.memberId},a.host.token);assert.equal((await get('/api/me',accountToken)).account.activePartyId,a.room.roomId);
  step('CONSOLE_APPROVAL','POST','/api/rooms/{roomId}/approve',{activeVehicle:'A'});
  const nearby=await post('/api/world/nearby',{latitude:37.5665,longitude:126.978,radiusM:500},first.token),spawn=nearby.spawns[0];
  await post('/api/world/claim',{commandId:randomUUID(),spawnId:spawn.spawnId,spawnCycleId:spawn.spawnCycleId,scheduleId:nearby.scheduleId,version:spawn.version,passengerConfirmed:true,location:{latitude:spawn.latitude,longitude:spawn.longitude,accuracyM:5,measuredAgeMs:100,source:'EMULATOR_GPS',isMock:true}},first.token);
  const secondInvite=await invite(b),preview=await post('/api/invites/preview',{inviteToken:secondInvite},accountToken);assert.equal(preview.requiresVehicleSwitch,true);
  const second=await post('/api/me/invitations/accept',{inviteToken:secondInvite,seat:'REAR_RIGHT',passengerConfirmed:true,expectedActivePartyId:a.room.roomId,confirmSwitch:true},accountToken);
  assert.equal((await get('/api/me',accountToken)).account.activePartyId,a.room.roomId);
  step('PHONE_CONFIRM_VEHICLE_CHANGE','POST','/api/me/invitations/accept',{activeVehicle:'A',pendingVehicle:'B',oldPartyInventoryRetained:true});
  await post(b.path+'/approve',{memberId:second.memberId},b.host.token);
  assert.equal((await get('/api/me',accountToken)).account.activePartyId,b.room.roomId);
  const ticket=await post('/api/me/party-ticket',{},accountToken);assert.equal(ticket.roomId,b.room.roomId);
  const oldStock=(await get(a.path,a.host.token)).room.collection.inventory.supplies,newStock=(await get(b.path,b.host.token)).room.collection.inventory.supplies;
  assert.equal(oldStock,1);assert.equal(newStock,0);assert.equal((await get('/api/me',accountToken)).account.userId,userId);
  const memberships=(await get('/api/me/parties',accountToken)).memberships;assert.deepEqual(memberships.map(m=>m.status),['SWITCHED','ACTIVE']);
  step('PHONE_RESUME_B','POST','/api/me/party-ticket',{tokenPurpose:ticket.tokenPurpose,personalIdentityUnchanged:true,oldPartySupplies:oldStock,newPartySupplies:newStock});
  step('PHONE_PARTY_HISTORY','GET','/api/me/parties',{statuses:memberships.map(m=>m.status),passed:true});
}finally{
  if(accountToken){await post('/api/me/party/leave',{},accountToken).catch(()=>{});await post('/api/accounts/logout',{},accountToken).catch(()=>{});}
  for(const car of cars)await post(car.path+'/party/disband',{},car.host.token).catch(()=>{});
}
