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
await p.evaluate(()=>{ window.__overrun.stage.composer=null; });

const shot = async (name) => { await p.waitForTimeout(600); await p.screenshot({path:`shots/d8-${name}.png`}); };

await shot('a-before');

// 1. kill the PMREM environment and force a full recompile
await p.evaluate(()=>{
  const s=window.__overrun.stage;
  s.scene.environment=null; s.scene.background=null;
  s.renderer.setClearColor(0x8FB8DC,1);
  s.scene.traverse(o=>{ if(o.material){ const ms=Array.isArray(o.material)?o.material:[o.material]; ms.forEach(m=>{ m.envMap=null; m.needsUpdate=true; }); } });
});
await shot('b-noenv');

// 2. also drop the fog
await p.evaluate(()=>{ const s=window.__overrun.stage; s.scene.fog=null; s.scene.traverse(o=>{if(o.material){const ms=Array.isArray(o.material)?o.material:[o.material]; ms.forEach(m=>m.needsUpdate=true);} }); });
await shot('c-nofog');

// 3. drop shadows too
await p.evaluate(()=>{ const s=window.__overrun.stage; s.renderer.shadowMap.enabled=false; s.sun.castShadow=false; s.scene.traverse(o=>{if(o.material){const ms=Array.isArray(o.material)?o.material:[o.material]; ms.forEach(m=>m.needsUpdate=true);} }); });
await shot('d-noshadow');

// 4. no tone mapping
await p.evaluate(()=>{ const s=window.__overrun.stage; s.renderer.toneMapping=0; s.scene.traverse(o=>{if(o.material){const ms=Array.isArray(o.material)?o.material:[o.material]; ms.forEach(m=>m.needsUpdate=true);} }); });
await shot('e-notone');
await b.close();
