import {importCatalog} from '../catalog-import.mjs';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../../data/places/',import.meta.url)));
const output=resolve(process.argv[2]??'data/places.json');
const catalog=await importCatalog(root,{withDemo:process.argv.includes('--with-demo')});
await mkdir(dirname(output),{recursive:true});await writeFile(output+'.tmp',JSON.stringify(catalog));await rename(output+'.tmp',output);
console.log(JSON.stringify({version:catalog.version,count:catalog.places.length,sourceCount:catalog.source.originalCount,output,gamePromotion:false}));
