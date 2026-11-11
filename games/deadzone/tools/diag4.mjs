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
p.on('console',m=>{ if(m.type()==='error'||m.text().includes('THREE')) console.log('C:',m.text()); });
await p.goto('http://localhost:4173/?debug', { waitUntil:'networkidle' });
await p.waitForFunction(()=>window.__overrun && window.__overrun.state==='title',{timeout:60000});
await p.evaluate(()=>document.querySelectorAll('#modeGrid .mode')[0].querySelector('[data-a="solo"]').click());
await p.waitForFunction(()=>window.__overrun.state==='play',{timeout:20000});
await p.waitForTimeout(1200);
console.log(JSON.stringify(await p.evaluate(()=>{
  const a=window.__overrun, s=a.stage;
  s.composer=null;
  s.renderer.setRenderTarget(null);
  s.renderer.info.reset();
  s.renderer.render(s.scene, s.camera);
  const r = { ...s.renderer.info.render, programs: s.renderer.info.programs.length, memGeo: s.renderer.info.memory.geometries, memTex: s.renderer.info.memory.textures };
  // now with background removed
  s.scene.background = null;
  s.renderer.info.reset();
  s.renderer.render(s.scene, s.camera);
  const r2 = { ...s.renderer.info.render };
  // project the floor centre to NDC to confirm it is on screen
  const v = new (Object.getPrototypeOf(s.camera.position).constructor)(0,0,0);
  v.project(s.camera);
  return { withBg:r, noBg:r2, floorNdc:[+v.x.toFixed(2),+v.y.toFixed(2),+v.z.toFixed(3)], shadowsOn: s.renderer.shadowMap.enabled };
}), null, 2));
await p.waitForTimeout(300);
await p.screenshot({path:'shots/diag-direct.png'});
await b.close();
