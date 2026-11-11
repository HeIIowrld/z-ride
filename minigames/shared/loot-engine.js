export const REGIONS = ['seoul', 'incheon', 'gyeonggi', 'gangwon'];
const rad = n => n * Math.PI / 180;
export function haversineKm(a, b) { const dLat=rad(b.lat-a.lat), dLng=rad(b.lng-a.lng), x=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLng/2)**2; return 6371*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x)); }
export function createLootEngine({ tables, items, points = [], rng = Math.random, initialState = {} } = {}) {
  const states = new Map(Object.entries(initialState).map(([id,s])=>[id,{...s,points:new Set(s.points||[])}]));
  function pick(region, conditions=[], gameId=null) {
    let candidates=[...(tables?.[region]||[]),...(tables?.common||[])].map(row=>({...row}));
    for (const row of candidates) { const item=items.find(x=>x.id===row.itemId); if(conditions.some(c=>item?.conditions?.includes(c))) row.weight*=3; if(gameId==='pole-jump'&&item?.category==='part')row.weight*=3; if(gameId==='raindrop'&&(item?.id==='coolant-cell'||item?.category==='consumable'))row.weight*=3; }
    const total=candidates.reduce((n,row)=>n+row.weight,0); let target=rng()*total;
    for(const row of candidates){target-=row.weight;if(target<=0)return items.find(x=>x.id===row.itemId);}
    return items.find(x=>x.id===candidates.at(-1)?.itemId)||items[0];
  }
  function tick(input) {
    const partyId=String(input.partyId||'default'), lat=Number(input.lat), lng=Number(input.lng), at=Number(input.at)||Date.now(); if(!Number.isFinite(lat)||!Number.isFinite(lng)) throw new Error('lat and lng must be finite');
    let s=states.get(partyId)||{region:null,km:0,last:null,lastAt:null,lastOdometer:null,boxes:0,hourStart:at,pending:0,visited:[],points:new Set()};
    const region=input.region||null, events=[]; let delta=0;
    if(s.last){const elapsed=Math.max(0,(at-s.lastAt)/1000), moved=haversineKm(s.last,{lat,lng}); if(moved>5&&elapsed<=10||elapsed>0&&moved/elapsed*3600>250){states.set(partyId,s);return {region:s.region,events:[],ignored:true};} delta=input.odometerKm!=null&&s.lastOdometer!=null?Math.max(0,Number(input.odometerKm)-s.lastOdometer):moved;}
    s.last={lat,lng}; s.lastAt=at; if(input.odometerKm!=null&&Number.isFinite(+input.odometerKm))s.lastOdometer=+input.odometerKm;
    if(at-s.hourStart>=3600000){s.hourStart=at;s.boxes=0;}
    const conditions=[]; if(input.wiper?.on)conditions.push('rain');const hour=new Date(at).getHours();if(hour>=19||hour<6)conditions.push('night');
    const safe=input.speedLimitKmh==null||!Number.isFinite(+input.speedKmh)||+input.speedKmh<=+input.speedLimitKmh;
    const award=(type, sourceRegion=region)=>{if(s.boxes>=12)return null;const item=pick(sourceRegion,conditions);s.boxes++;events.push({type,items:[item],region:sourceRegion});return item;};
    if(region&&region!==s.region){s.region=region;if(!s.visited.includes(region))s.visited.push(region);if(safe)award('region_enter');else s.pending++;}
    if(region){s.km+=delta;while(s.km>=10){s.km-=10;if(safe)award('distance_box');else s.pending++;}}
    if(safe&&s.pending){const count=Math.min(s.pending,12-s.boxes);for(let i=0;i<count;i++)award('distance_box');s.pending-=count;}
    for(const point of points){if(haversineKm({lat,lng},{lat:point.lat,lng:point.lng})<=.3&&!s.points.has(point.id)){s.points.add(point.id);if(safe)award('point_box');else s.pending++;}}
    states.set(partyId,s);return {region:s.region,events,kmInRegion:s.km,visited:[...s.visited],boxesThisHour:s.boxes,pendingBoxes:s.pending};
  }
  function minigame({partyId='default',gameId,result={},region=null}){if(gameId==='license-quiz'){const fixed={sign:'ammo',situation:'medkit',weather_time:'coolant',enforcement:'supply'},itemsOut=[];for(const [type,id] of Object.entries(fixed)){const entry=result.correctByType?.[type];if((typeof entry==='number'?entry:entry?.correct||0)>0){const item=items.find(x=>x.id===id);if(item)itemsOut.push(item);}}if(region&&rng()<.25)itemsOut.push(pick(region,[],null));return {type:'minigame',items:itemsOut};}const item=pick(region,[],gameId);return {type:'minigame',items:[item]};}
  function state(partyId='default'){const s=states.get(String(partyId));return s?{...s,points:undefined}:null;}
  function snapshot(){return Object.fromEntries([...states].map(([id,s])=>[id,{...s,points:[...s.points]}]));}
  return {tick,minigame,state,pick,snapshot};
}
