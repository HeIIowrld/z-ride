import { reportTick } from './loot-client.js';
import { SERVER_URL } from './config.js';
import { inJourney } from './journey.js';
let watch=null,current=null;
function offlineRegion(lat,lng){if(lat>37.42&&lat<37.70&&lng>126.74&&lng<127.17)return'seoul';if(lat>37.18&&lat<37.50&&lng>126.32&&lng<126.82)return'incheon';if(lat>37.0&&lat<37.9&&lng>126.3&&lng<127.6)return'gyeonggi';if(lat>37.4&&lat<38.2&&lng>127.0&&lng<128.5)return'gangwon';return null;}
export function startLootTracking(){if(inJourney||watch!==null||!navigator.geolocation)return;let lastSent=0,lastPosition=null;watch=navigator.geolocation.watchPosition(async pos=>{const now=Date.now(),lat=pos.coords.latitude,lng=pos.coords.longitude;if(lastSent&&now-lastSent<15000&&lastPosition&&Math.hypot(lat-lastPosition.lat,lng-lastPosition.lng)<.001)return;lastSent=now;lastPosition={lat,lng};const result=await reportTick({lat,lng,speedKmh:0,at:now,region:SERVER_URL?undefined:offlineRegion(lat,lng)}).catch(()=>null);current=result?.region||null;},()=>{}, {enableHighAccuracy:true,maximumAge:10000,timeout:15000});}
export function stopLootTracking(){if(watch!==null)navigator.geolocation?.clearWatch(watch);watch=null;}
export function currentLootRegion(){return current;}
