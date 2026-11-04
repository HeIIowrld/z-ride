import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {importCatalog} from '../catalog-import.mjs';import {createPlacesService} from '../places.mjs';
test('verified Git catalog retains road arrival separately and never enables game spots',async()=>{
 const root=await mkdtemp(join(tmpdir(),'zride-catalog-'));try{
 const row={id:'node/123',name:'Test parking',category:'parking',latitude:37.5,longitude:127,reviewStatus:'pending',gameEnabled:false,drivingAssessment:{arrival:{latitude:37.501,longitude:127},networkRoundTrip:true,fieldVerified:false}};
 const raw=JSON.stringify([row]),shard={path:'parking-000.json',bytes:Buffer.byteLength(raw),count:1,sha256:createHash('sha256').update(raw).digest('hex')},manifest={format:'z-ride-place-catalog-v3',license:'ODbL-1.0',count:1,shards:[shard]};
 await writeFile(join(root,shard.path),raw);await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));
 const catalog=await importCatalog(root),service=createPlacesService({catalog});const p=service.nearby({latitude:37.5,longitude:127,eligibleOnly:false}).places[0];
 assert.equal(p.placeId,'osm-node-123');assert.equal(p.latitude,37.5);assert.equal(p.navigationDestination.latitude,37.501);assert.equal(p.enabled,false);assert.equal(service.nearby({latitude:37.5,longitude:127}).places.length,0);
 await writeFile(join(root,shard.path),raw+' ');await assert.rejects(importCatalog(root),/integrity/);
 manifest.shards[0].path='../escape.json';await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));await assert.rejects(importCatalog(root),/Unsafe/);
 }finally{await rm(root,{recursive:true,force:true});}
});
