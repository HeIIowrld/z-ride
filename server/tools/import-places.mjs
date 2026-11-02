/** Downloads only the fixed, reviewed public source. No executable content. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const origin = 'https://gilbeot-map-workshop.woojin-jang05.chatgpt.site';
const output = resolve(process.argv[2] ?? 'data/places.json');
async function get(path) { const response = await fetch(origin+path,{signal:AbortSignal.timeout(30000),redirect:'error'}); if (!response.ok) throw new Error('Source HTTP '+response.status); return Buffer.from(await response.arrayBuffer()); }
const manifest = JSON.parse(await get('/data/manifest.json')), metadata = JSON.parse(await get('/data/metadata.json'));
const expected = ['id','name','category','lat','lon','theme','address','facts','modified_at','region','unnamed'];
if (manifest.format !== 'gilbeot-osm-v1' || JSON.stringify(manifest.columns) !== JSON.stringify(expected) || manifest.shards.length>64 || manifest.count>200000) throw new Error('Unsupported manifest');
const places = [], ids = new Set();
for (const shard of manifest.shards) {
  if (!/^\/data\/places-\d{2}\.json$/.test(shard.path) || shard.bytes>4000000) throw new Error('Unsafe shard');
  const bytes = await get(shard.path);
  if (bytes.length !== shard.bytes || createHash('sha256').update(bytes).digest('hex') !== shard.sha256) throw new Error('Shard integrity failed');
  const rows = JSON.parse(bytes); if (rows.length!==shard.count) throw new Error('Count mismatch');
  for (const row of rows) {
    const [id,name,category,latitude,longitude,,address,facts,modifiedAt,region] = row;
    if (ids.has(id) || !/^(node|way|relation)\/\d+$/.test(id) || typeof name!=='string' || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude<32 || latitude>40 || longitude<124 || longitude>132) throw new Error('Invalid row');
    ids.add(id); const categories={attraction:'ATTRACTION',parking:'PARKING',charging_station:'CHARGER',fuel_station:'FUEL_STATION'};
    if (!categories[category]) throw new Error('Unknown category');
    places.push({placeId:'osm-'+id.replace('/','-'),name,category:categories[category],latitude,longitude,address,region,facts,modifiedAt,sourceId:id});
  }
}
if (places.length !== manifest.count || metadata.count !== places.length) throw new Error('Catalog count mismatch');
if (process.argv.includes('--with-demo')) places.push({placeId:'DEMO_PARKING_SPOT',name:'가상 협동 거점 · 실제 주차장 아님',category:'PARKING',latitude:37.5665,longitude:126.978,sourceId:'SIMULATED',isDemo:true});
const result = {version:'gilbeot-'+createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0,16)+(process.argv.includes('--with-demo')?'-demo':''),source:{provider:metadata.source,license:metadata.license,attribution:metadata.attribution,snapshotAt:metadata.snapshot_at,manifestUrl:origin+'/data/manifest.json',originalCount:metadata.count},places};
await mkdir(dirname(output),{recursive:true}); await writeFile(output+'.tmp',JSON.stringify(result)); await rename(output+'.tmp',output);
console.log(JSON.stringify({imported:places.length,version:result.version,allUnreviewed:true,output}));
