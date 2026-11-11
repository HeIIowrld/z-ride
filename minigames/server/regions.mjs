import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const regionFeatures=JSON.parse(fs.readFileSync(path.join(root,'data/regions/regions.geojson'),'utf8')).features;
function inRing(lng,lat,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const [xi,yi]=ring[i],[xj,yj]=ring[j];if((yi>lat)!==(yj>lat)&&lng<(xj-xi)*(lat-yi)/(yj-yi)+xi)inside=!inside;}return inside;}
export function regionAt(lat,lng){for(const id of ['seoul','incheon','gyeonggi','gangwon']){const f=regionFeatures.find(x=>x.properties.id===id);if(f&&inRing(lng,lat,f.geometry.coordinates[0]))return id;}return null;}
