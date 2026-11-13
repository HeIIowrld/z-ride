/** Export only public PHONE assets; never exports server state, keys or observer credentials. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {checkedOrigin} from '../request-policy.mjs';
import {DRIVE_FILES} from '../phone-client.mjs';
const origin=checkedOrigin(process.argv[2]??process.env.GAME_BROWSER_API_ORIGIN??'');
if(!origin.startsWith('https://'))throw new Error('Public frontend requires HTTPS API');
const displayName=process.env.GAME_DISPLAY_NAME??'PLY';if(!displayName.trim()||displayName.length>64||/[\u0000-\u001f]/.test(displayName))throw new Error('Invalid display name');
const target=resolve(process.argv[3]??'dist/phone');await mkdir(target,{recursive:true});
let html=await readFile(new URL('../phone-client/index.html',import.meta.url),'utf8');
html=html.replaceAll('PLY',displayName.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\"','&quot;').replaceAll("'",'&#39;'));
html=html.replaceAll('/play/', './');
html=html.replace('href="/play"','href="./"').replace('href="/observer"','href="'+origin+'/observer"');
html=html.replace('<meta name="theme-color"',`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' https://accounts.google.com/gsi/style; frame-src 'self' https://accounts.google.com/gsi/; connect-src 'self' ${origin} ${origin.replace(/^http/,'ws')} https://accounts.google.com/gsi/; base-uri 'none'; form-action 'self'">\n  <meta name="referrer" content="strict-origin-when-cross-origin">\n  <meta name="theme-color"`);
await writeFile(target+'/index.html',html);
for(const file of ['app.js','account.js','style.css','arena.js','arena.css','thief.webp','relay.webp','deadzone.webp'])await writeFile(target+'/'+file,await readFile(new URL('../phone-client/'+file,import.meta.url)));
for (const file of DRIVE_FILES) {
  const destination = resolve(target, 'drive', file);
  await mkdir(dirname(destination), {recursive: true});
  await writeFile(destination, await readFile(new URL('../../minigames/' + file, import.meta.url)));
}
await writeFile(target+'/config.js','window.GAME_CONFIG=window.ZRIDE_CONFIG=Object.freeze('+JSON.stringify({apiOrigin:origin,displayName})+');\n');
await writeFile(target+'/.nojekyll','');
console.log(JSON.stringify({exported:true,apiOrigin:origin,target,containsSecrets:false}));
