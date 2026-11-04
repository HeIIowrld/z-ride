const fail=(message)=>Object.assign(new Error(message),{code:'INVALID_NAVIGATION_REPORT',status:400});
export function navigationReport(value,now=Date.now()){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.source!=='PLEOS_NAVI_HELPER'||typeof value.sdkConnected!=='boolean'||typeof value.owned!=='boolean'||!Number.isSafeInteger(value.routeRevision)||value.routeRevision<0)throw fail('Typed SDK navigation report required');
  const text=(key,max=96)=>value[key]==null?null:typeof value[key]==='string'&&value[key].length<=max?value[key]:(()=>{throw fail('Invalid '+key);})();
  const number=key=>value[key]==null?null:Number.isFinite(value[key])&&value[key]>=0&&value[key]<=1e8?value[key]:(()=>{throw fail('Invalid '+key);})();
  const result={source:'PLEOS_NAVI_HELPER',sdkConnected:value.sdkConnected,owned:value.owned,nativeRouteRevision:value.routeRevision,event:text('event'),status:text('status')??'UNKNOWN',error:text('error'),destination:text('destination',128),remainingDistanceM:number('remainingDistanceM'),remainingTimeSec:number('remainingTimeSec'),geometryAvailable:false,geometryBasis:'UNAVAILABLE_NO_ROAD_POLYLINE',receivedAt:now};
  if(value.latitude!=null||value.longitude!=null){if(!Number.isFinite(value.latitude)||Math.abs(value.latitude)>90||!Number.isFinite(value.longitude)||Math.abs(value.longitude)>180)throw fail('Invalid SDK coordinate');if(Number.isFinite(value.locationAgeMs)&&value.locationAgeMs>=0&&value.locationAgeMs<=10000){result.position={latitude:value.latitude,longitude:value.longitude};result.locationAgeMs=value.locationAgeMs;result.positionSource=value.positionSource==='ANDROID_GNSS'?'ANDROID_GNSS':'PLEOS_NAVI_HELPER';}}
  return result;
}
export function navigationSnapshot(room,now=Date.now()){
  const state=room.navigation;
  if(!state||!room.vehicle.hostConnected||now-state.receivedAt>10000)return {source:'PLEOS_NAVI_HELPER',available:false,status:state?'STALE':'NOT_CONNECTED',geometryAvailable:false};
  if(!state.sdkConnected)return {source:'PLEOS_NAVI_HELPER',available:false,status:'SDK_NOT_CONNECTED',error:state.error,geometryAvailable:false};
  const {receivedAt,...data}=state;if(data.position){data.locationAgeMs+=now-receivedAt;if(data.locationAgeMs>10000){delete data.position;delete data.locationAgeMs;}}return {...data,available:true,reportAgeMs:now-receivedAt,hardwareAttested:false};
}
