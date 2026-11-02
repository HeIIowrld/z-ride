/** Export only public PHONE assets; never exports server state, keys or observer credentials. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {checkedOrigin} from '../request-policy.mjs';
const origin=checkedOrigin(process.argv[2]??'');
if(!origin.startsWith('https://'))throw new Error('Public frontend requires HTTPS API');
const target=resolve(process.argv[3]??'dist/phone');await mkdir(target,{recursive:true});
let html=await readFile(new URL('../phone-client/index.html',import.meta.url),'utf8');
html=html.replaceAll('/play/style.css','./style.css').replaceAll('/play/app.js','./app.js').replaceAll('/play/config.js','./config.js');
html=html.replace('href="/play"','href="./"').replace('href="/observer"','href="'+origin+'/observer"');
html=html.replace('<meta name="theme-color"',`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; connect-src ${origin} ${origin.replace(/^http/,'ws')}; base-uri 'none'; form-action 'self'">\n  <meta name="referrer" content="no-referrer">\n  <meta name="theme-color"`);
await writeFile(target+'/index.html',html);
for(const file of ['app.js','style.css'])await writeFile(target+'/'+file,await readFile(new URL('../phone-client/'+file,import.meta.url)));
await writeFile(target+'/config.js','window.ZRIDE_CONFIG=Object.freeze('+JSON.stringify({apiOrigin:origin})+');\n');
await writeFile(target+'/.nojekyll','');
console.log(JSON.stringify({exported:true,apiOrigin:origin,target,containsSecrets:false}));
