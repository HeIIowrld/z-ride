import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const categories={attraction:'ATTRACTION',parking:'PARKING',charging_station:'CHARGER',fuel_station:'FUEL_STATION'};
const coordinate=p=>p&&Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)&&p.latitude>=32&&p.latitude<=40&&p.longitude>=124&&p.longitude<=132;
/** Only manifest-listed, hash-verified JSON shards from the local Git snapshot. */
export async function importCatalog(root,{withDemo=false}={}){
 const bytes=await readFile(join(root,'manifest.json')),manifest=JSON.parse(bytes);
 if(manifest.format!=='z-ride-place-catalog-v3'||manifest.license!=='ODbL-1.0'||!Number.isInteger(manifest.count)||manifest.count<1||manifest.count>200000||!Array.isArray(manifest.shards)||manifest.shards.length>64)throw new Error('Unsupported catalog manifest');
 const places=[],ids=new Set();let total=0;
 for(const shard of manifest.shards){
  if(!/^(attraction|parking|charging_station|fuel_station)-\d{3}\.json$/.test(shard.path)||!Number.isInteger(shard.bytes)||shard.bytes<1||shard.bytes>16000000)throw new Error('Unsafe catalog shard');
  const raw=await readFile(join(root,shard.path));if(raw.length!==shard.bytes||createHash('sha256').update(raw).digest('hex')!==shard.sha256)throw new Error('Catalog shard integrity mismatch');
  const rows=JSON.parse(raw);if(!Array.isArray(rows)||rows.length!==shard.count)throw new Error('Catalog shard count mismatch');
  for(const p of rows){const d=p.drivingAssessment;
   if(!/^(node|way|relation)\/[1-9]\d*$/.test(p.id)||ids.has(p.id)||!categories[p.category]||typeof p.name!=='string'||!p.name.length||!coordinate(p)||!coordinate(d?.arrival)||d.networkRoundTrip!==true||d.fieldVerified!==false||p.gameEnabled!==false||p.reviewStatus!=='pending')throw new Error('Invalid or promoted catalog entry');
   ids.add(p.id);places.push({placeId:'osm-'+p.id.replace('/','-'),sourceId:p.id,name:p.name,category:categories[p.category],latitude:p.latitude,longitude:p.longitude,address:p.address,region:p.region,displayCategory:p.displayCategory,facts:p.facts,modifiedAt:p.osmModifiedAt,reviewStatus:'pending',gameEnabled:false,carAccess:p.carAccess,drivingAssessment:d,navigationDestination:{...d.arrival,basis:'OSM_NETWORK_NODE_NOT_FIELD_VERIFIED'}});
  }total+=rows.length;
 }
 if(total!==manifest.count)throw new Error('Catalog total mismatch');
 if(withDemo)places.push({placeId:'DEMO_PARKING_SPOT',name:'가상 협동 거점 · 실제 주차장 아님',category:'PARKING',latitude:37.5665,longitude:126.978,sourceId:'SIMULATED',isDemo:true});
 return {version:'github-v3-'+createHash('sha256').update(bytes).digest('hex').slice(0,16)+(withDemo?'-demo':''),source:{provider:'OpenStreetMap / Geofabrik',license:manifest.license,attribution:manifest.attribution,snapshotAt:manifest.snapshotAt,originalCount:manifest.count,manifestUrl:'https://github.com/HeIIowrld/z-ride/blob/main/data/places/manifest.json',byCategory:manifest.byCategory,drivingFilter:manifest.drivingFilter,fieldVerified:false},places};
}
