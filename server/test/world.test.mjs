import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createDemoServer } from '../server.mjs';

test('phone world nearby and limited client-location claim validation', async () => {
  let now=Date.parse('2026-11-01T10:00:00Z');
  const app=createDemoServer({worldClock:()=>now}); const address=await app.listen(0);
  const base=`http://127.0.0.1:${address.port}`; const evidence=[];
  async function request(path,body,token,method='POST') {
    const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  }
  const post=async(path,body,token)=>(await request(path,body,token)).body;
  try {
    const host=await post('/api/session',{role:'CAR_HOST',nickname:'Map test host'});
    const phone=await post('/api/session',{role:'PHONE',nickname:'Map test passenger'});
    const room=await post('/api/rooms',{},host.token);
    const joined=await post('/api/join',{joinCode:room.joinCode,seat:'FRONT_PASSENGER'},phone.token);
    const query={latitude:37.5665,longitude:126.978,radiusM:500};
    assert.equal((await request('/api/world/nearby',query)).status,401);
    assert.equal((await request('/api/world/nearby',query,host.token)).body.error.code,'ROLE_FORBIDDEN');
    assert.equal((await request('/api/world/nearby',query,phone.token)).body.error.code,'MEMBER_PENDING');
    await post('/api/rooms/'+room.roomId+'/approve',{memberId:joined.memberId},host.token);
    const nearby=await post('/api/world/nearby',query,phone.token);
    assert.equal(nearby.spawns.length,3); assert.equal(nearby.scheduleId,'2026-11-01');
    assert.ok(nearby.spawns.every(p=>p.latitude>37&&p.latitude<38&&p.longitude>126&&p.longitude<128&&p.pointKind==='TEST_GAME_POINT_NOT_CHARGER'&&!p.claimed));
    assert.equal((await request('/api/world/nearby',{latitude:126.978,longitude:37.5665,radiusM:500},phone.token)).body.error.code,'INVALID_COORDINATE');
    assert.equal((await request('/api/world/nearby',{...query,radiusM:2001},phone.token)).body.error.code,'INVALID_RADIUS');
    assert.equal((await request('/api/world/nearby?lat=37.5&lon=127',undefined,phone.token,'GET')).status,405);
    evidence.push('authenticated approved passenger only; named WGS84 coordinates, bounded query and POST-only privacy');
    const spawn=nearby.spawns[0];
    const makeClaim=(overrides={})=>({commandId:randomUUID(),spawnId:spawn.spawnId,scheduleId:nearby.scheduleId,version:spawn.version,passengerConfirmed:true,
      location:{latitude:spawn.latitude,longitude:spawn.longitude,accuracyM:5,measuredAgeMs:500,source:'EMULATOR_GPS',isMock:false},...overrides});
    for (const [alter,code] of [
      [{accuracyM:51},'LOCATION_INACCURATE'],[{accuracyM:null},'LOCATION_INACCURATE'],
      [{measuredAgeMs:10001},'LOCATION_STALE'],[{measuredAgeMs:-1},'LOCATION_STALE'],
      [{latitude:37.5765},'OUTSIDE_SPAWN'],[{latitude:126.978,longitude:37.5665},'INVALID_COORDINATE'],
    ]) {
      const claim=makeClaim();Object.assign(claim.location,alter);
      assert.equal((await request('/api/world/claim',claim,phone.token)).body.error.code,code);
    }
    assert.equal((await request('/api/world/claim',makeClaim({passengerConfirmed:false}),phone.token)).body.error.code,'PASSENGER_CONFIRMATION_REQUIRED');
    assert.equal((await request('/api/world/claim',makeClaim({scheduleId:'2026-10-31'}),phone.token)).body.error.code,'SPAWN_EXPIRED');
    assert.equal((await request('/api/world/claim',makeClaim({version:'old-world'}),phone.token)).body.error.code,'WORLD_VERSION_CONFLICT');
    evidence.push('claim rejects old/inaccurate/missing/negative-age/outside/swapped fixes and wrong schedule/version');
    const observed=await post('/api/world/location',{passengerConfirmed:true,location:makeClaim().location},phone.token);
    assert.equal(observed.hardwareAttested,false);assert.equal(observed.validationTier,'MOCK_DEMO');assert.equal(observed.purpose,'QUALITY_INPUT_CHECK_ONLY_NOT_VISIT_PROOF');
    const claim=makeClaim();const first=await post('/api/world/claim',claim,phone.token);
    assert.equal(first.claimed,true);assert.equal(first.inventory.supplies,1);assert.equal(first.locationValidated,true);assert.equal(first.hardwareAttested,false);assert.equal(first.validationTier,'MOCK_DEMO');
    assert.equal(first.isMock,false); evidence.push('emulator source is MOCK_DEMO even when Location.isMock is false; no hardware-attestation claim');
    const replay=await post('/api/world/claim',claim,phone.token);assert.equal(replay.replayed,true);assert.equal(replay.inventory.supplies,1);
    const reordered={location:claim.location,passengerConfirmed:true,version:claim.version,scheduleId:claim.scheduleId,spawnId:claim.spawnId,commandId:claim.commandId};
    assert.equal((await post('/api/world/claim',reordered,phone.token)).replayed,true);
    assert.equal((await request('/api/world/claim',{...claim,location:{...claim.location,accuracyM:6}},phone.token)).body.error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal((await request('/api/world/claim',makeClaim(),phone.token)).body.error.code,'ALREADY_CLAIMED');
    evidence.push('same command replay has one reward; equivalent key order works; changed body conflicts and new-ID duplicate spawn is rejected');
    const after=await post('/api/world/nearby',query,phone.token);assert.equal(after.spawns.find(p=>p.spawnId===spawn.spawnId).claimed,true);
    const hostSnapshot=await request('/api/rooms/'+room.roomId,undefined,host.token,'GET');
    assert.equal(hostSnapshot.body.room.collection.inventory.supplies,1);
    assert.equal(hostSnapshot.body.room.collection.lastCollect.pickupId,'WORLD_CLAIM');
    const serialized=JSON.stringify(hostSnapshot.body);assert.ok(!serialized.includes('37.5665'));assert.ok(!serialized.includes('126.978'));assert.ok(!serialized.includes(spawn.spawnId));
    evidence.push('shared battle snapshot gains supplies without broadcasting phone coordinates or individual world spawn ID');
    const codeRefresh=await post('/api/rooms',{},host.token);
    const other=await post('/api/session',{role:'PHONE',nickname:'Second map passenger'});
    const otherJoin=await post('/api/join',{joinCode:codeRefresh.joinCode,seat:'REAR_LEFT'},other.token);
    await post('/api/rooms/'+room.roomId+'/approve',{memberId:otherJoin.memberId},host.token);
    const otherNearby=await post('/api/world/nearby',query,other.token);assert.equal(otherNearby.spawns[0].claimed,false);
    evidence.push('claim projection is per passenger, not shared as another phone claim list');
    now+=86400000;
    assert.equal((await request('/api/world/claim',makeClaim({spawnId:nearby.spawns[1].spawnId}),phone.token)).body.error.code,'SPAWN_EXPIRED');
    const next=await post('/api/world/nearby',query,phone.token);assert.equal(next.scheduleId,'2026-11-02');assert.ok(next.spawns.every(p=>!p.claimed));
    evidence.push('server UTC schedule expires old spawn selection and versions the next window');
    await writeFile(new URL('../world-test-results.json',import.meta.url),JSON.stringify({testedAt:new Date().toISOString(),passed:true,scope:'HTTP input/location-distance checks; simulated client locations, not actual Android GPS',evidence},null,2)+'\n');
  } finally {await app.close();}
});
