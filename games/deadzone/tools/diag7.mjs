/*
 * Copyright 2026 Mohammad Mahdi Mortazavi
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 640, height: 400 } });
p.on('pageerror',e=>console.log('ERR',e.message));
await p.goto('http://localhost:4173/?debug', { waitUntil:'networkidle' });
await p.waitForFunction(()=>window.__overrun && window.__overrun.state==='title',{timeout:60000});
await p.evaluate(()=>document.querySelectorAll('#modeGrid .mode')[0].querySelector('[data-a="solo"]').click());
await p.waitForFunction(()=>window.__overrun.state==='play',{timeout:20000});
await p.waitForTimeout(900);
console.log(await p.evaluate(()=>{
  const a=window.__overrun, s=a.stage;
  s.composer=null;
  const f=a.arena.floor;
  const mp=s.renderer.properties.get(f.material);
  const prog=mp&&mp.currentProgram;
  return JSON.stringify({ cacheKey: prog ? String(prog.cacheKey).slice(0,600) : 'none' });
}));
// emissive test
await p.evaluate(()=>{ const f=window.__overrun.arena.floor; f.material.emissive.setHex(0x666666); f.material.emissiveIntensity=1; f.material.needsUpdate=true; });
await p.waitForTimeout(500);
await p.screenshot({path:'shots/diag-emissive.png'});
await b.close();
