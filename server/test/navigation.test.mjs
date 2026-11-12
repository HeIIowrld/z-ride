import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID}from'node:crypto';import{WebSocket}from'ws';
import{navigationReport,navigationSnapshot}from'../navigation.mjs';import{createDemoServer}from'../server.mjs';
const sample={source:'PLEOS_NAVI_HELPER',sdkConnected:true,owned:true,routeRevision:3,event:'REROUTE_ENDED',status:'ROUTE_READY',destination:'Test destination',remainingDistanceM:1000,remainingTimeSec:120,latitude:37.5,longitude:126.9,locationAgeMs:0};
test('SDK navigation projection drops stale coordinates and rejects invalid reports',()=>{
 const navigation=navigationReport(sample,1000),room={navigation,vehicle:{hostConnected:true}};
 assert.equal(navigationSnapshot(room,1001).geometryAvailable,false);assert.ok(navigationSnapshot(room,1001).position);
 navigation.locationAgeMs=9999;assert.equal(navigationSnapshot(room,1002).position,undefined);
 assert.equal(navigationSnapshot(room,12000).available,false);room.vehicle.hostConnected=false;assert.equal(navigationSnapshot(room,1000).available,false);
 assert.throws(()=>navigationReport({...sample,latitude:91}),{code:'INVALID_NAVIGATION_REPORT'});
 assert.throws(()=>navigationReport({...sample,source:'DEMO_ROUTE'}),{code:'INVALID_NAVIGATION_REPORT'});
 assert.equal(navigationReport({...sample,locationAgeMs:undefined}).position,undefined);
 assert.equal(navigationReport({...sample,positionSource:'ANDROID_GNSS'}).positionSource,'ANDROID_GNSS');
});
test('native navigation broadcasts only to approved party members, revokes demo geometry and rejects phone/stale reports',async t=>{
 let saved;const stateStore={load:()=>null,save:value=>{saved=structuredClone(value);},close(){}};
 const spot={placeId:'native-spot',name:'Native route parking',category:'PARKING',latitude:37.5,longitude:126.9,
  navigationDestination:{latitude:37.5,longitude:126.9},drivingAssessment:{networkRoundTrip:true}};
 const nextSpot={...spot,placeId:'next-spot',name:'Next parking',latitude:37.504,
  navigationDestination:{latitude:37.504,longitude:126.9}};
 const app=createDemoServer({leaseMs:60000,stateStore,placesCatalog:{version:'native-test',places:[spot,nextSpot]}}),address=await app.listen(0),clients=[];
 t.after(async()=>{for(const c of clients)c.ws.terminate();await app.close();});
 const api=async(path,body,token)=>{const r=await fetch(`http://127.0.0.1:${address.port}`+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(r.ok,'API '+r.status);return r.json();};
 async function until(fn){for(let i=0;i<200;i++){const result=fn();if(result)return result;await new Promise(r=>setTimeout(r,10));}throw Error('No WS update');}
 async function connect(token,roomId){const ws=new WebSocket(`ws://127.0.0.1:${address.port}/ws`),c={ws,messages:[]};clients.push(c);ws.on('message',raw=>{const m=JSON.parse(raw);c.messages.push(m);if(m.type==='snapshot')c.room=m.room;});await new Promise(r=>ws.once('open',r));ws.send(JSON.stringify({type:'auth',token,roomId}));await until(()=>c.room);c.send=async body=>{const commandId=randomUUID();ws.send(JSON.stringify({...body,commandId}));return until(()=>c.messages.find(m=>m.type==='result'&&m.commandId===commandId));};return c;}
 const host=await api('/api/session',{role:'CAR_HOST',nickname:'Navi host'}),room=await api('/api/rooms',{},host.token),base='/api/rooms/'+room.roomId;
 const phone=await api('/api/session',{role:'PHONE',nickname:'Navi phone'}),join=await api('/api/join',{joinCode:room.joinCode,seat:'REAR_LEFT'},phone.token);
 const p=await connect(phone.token,room.roomId),car=await connect(host.token,room.roomId);
 await car.send({type:'vehicle.report',reportSeq:1,gear:'P',ux:'ALLOWED',foreground:true});
 const selectGame = (game, token) => fetch('http://127.0.0.1:' + address.port + base + '/drive-game', {
   method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + token},
   body: JSON.stringify({game}),
 });
 assert.deepEqual(await api(base+'/drive-game', {game:'raindrop'}, host.token), {game:'raindrop'});
 assert.equal((await selectGame('unknown', host.token)).status, 400);
 assert.equal(p.room.driveGame, undefined);
 await api(base+'/route',{commandId:'demo',expectedRouteRevision:0,source:'DEMO_ROUTE',geometry:[{latitude:37.5,longitude:126.9},{latitude:37.51,longitude:126.91}]},host.token);
 assert.equal((await car.send({type:'navigation.report',reportSeq:1,navigation:sample})).ok,true);
 assert.equal(p.room.navigation,undefined);
 await api(base+'/approve',{memberId:join.memberId,allowManualUnknown:true},host.token);await until(()=>p.room.navigation?.nativeRouteRevision===3);
 assert.equal(p.room.driveGame, 'raindrop');
 assert.equal((await selectGame('pole-jump', phone.token)).status, 403);
 assert.equal(p.room.party.route.active,false);assert.equal(p.room.navigation.geometryAvailable,false);
 assert.ok(saved.rooms.every(r=>!Object.hasOwn(r,'navigation')),'SDK location/navigation must not enter durable checkpoints');
 assert.equal((await p.send({type:'navigation.report',reportSeq:9,navigation:sample})).error.code,'ROLE_FORBIDDEN');
 assert.equal((await car.send({type:'navigation.report',reportSeq:1,navigation:sample})).error.code,'STALE_REPORT');
 assert.equal((await car.send({type:'navigation.report',reportSeq:2,navigation:{...sample,latitude:99}})).error.code,'INVALID_NAVIGATION_REPORT');
 assert.equal((await car.send({type:'navigation.report',reportSeq:2,navigation:{...sample,routeRevision:4,status:'CANCELLED',destination:null}})).ok,true);
 await until(()=>p.room.navigation?.nativeRouteRevision===4);assert.equal(p.room.navigation.destination,null);
 await car.send({type:'vehicle.report',reportSeq:2,gear:'D',ux:'RESTRICTED',foreground:false,speedMps:7});
 await car.send({type:'navigation.report',reportSeq:3,navigation:{...sample,routeRevision:5,status:'ROUTE_DRIVE',speedLimitKmh:50,nextTurn:'right',nextTurnDistanceM:100}});
 assert.equal((await selectGame('pole-jump', host.token)).status, 409);
 await until(()=>p.room.routeSupplyAvailable);
 assert.equal(p.room.routeSupplySpot.placeId,spot.placeId);
 assert.equal(p.room.vehicle.speedMps,7);
 assert.equal(p.room.navigation.speedLimitKmh,50);
 assert.equal(p.room.navigation.nextTurn,'right');
 assert.equal(p.room.collection.inventory.supplies,0);
 await car.send({type:'navigation.report',reportSeq:4,navigation:{...sample,routeRevision:5,status:'ROUTE_DRIVE',latitude:37.51}});
 await until(()=>p.room.routeSupplyAvailable===false);
 assert.equal(p.room.collection.inventory.supplies,0);
 await car.send({type:'navigation.report',reportSeq:5,navigation:{...sample,routeRevision:5,status:'ROUTE_DRIVE'}});
 await until(()=>p.room.routeSupplySpot?.placeId===spot.placeId);
 const supply=await api('/api/world/route-supply',{passengerConfirmed:true},phone.token);
 assert.equal(supply.placeName,spot.name);
 const missed=await api('/api/world/route-supply',{passengerConfirmed:true,challengeId:supply.challengeId,sequence:'0000'},phone.token);
 assert.deepEqual(missed,{outcome:'MISSED',supplies:0});
 await until(()=>p.room.routeSupplyAvailable===false);
 const rejected=await fetch(`http://127.0.0.1:${address.port}/api/world/route-supply`,{
  method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+phone.token},
  body:JSON.stringify({passengerConfirmed:true,placeId:spot.placeId})});
 assert.equal(rejected.status,409);
 await car.send({type:'navigation.report',reportSeq:6,navigation:{...sample,routeRevision:5,status:'ROUTE_DRIVE',latitude:nextSpot.latitude}});
 await until(()=>p.room.routeSupplySpot?.placeId===nextSpot.placeId);
 assert.equal(p.room.navigation.position.latitude,nextSpot.latitude);
 const next=await api('/api/world/route-supply',{passengerConfirmed:true,placeId:nextSpot.placeId},phone.token);
 const collected=await api('/api/world/route-supply',{passengerConfirmed:true,challengeId:next.challengeId,sequence:next.sequence},phone.token);
 assert.equal(collected.supplies,1);
 await until(()=>p.room.routeSupplyAvailable===false);
 assert.equal(p.room.routeSupplySpot,null);
 await car.send({type:'navigation.report',reportSeq:7,navigation:{...sample,routeRevision:6,status:'ROUTE_DRIVE'}});
 await until(()=>p.room.navigation.nativeRouteRevision===6);
 assert.equal(p.room.routeSupplySpot,null);
});
