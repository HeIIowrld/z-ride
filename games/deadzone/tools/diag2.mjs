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
const p = await b.newPage({ viewport: { width: 800, height: 500 } });
const logs=[]; p.on('pageerror',e=>logs.push('ERR '+e.message));
await p.goto('http://localhost:4173/?debug', { waitUntil:'networkidle' });
await p.waitForFunction(()=>window.__overrun && window.__overrun.state==='title',{timeout:60000});
await p.evaluate(()=>document.querySelectorAll('#modeGrid .mode')[0].querySelector('[data-a="solo"]').click());
await p.waitForFunction(()=>window.__overrun.state==='play',{timeout:20000});
await p.waitForTimeout(2000);
console.log('PLAY:', JSON.stringify(await p.evaluate(()=>{
  const a=window.__overrun,s=a.stage;
  return { camPos:s.camera.position.toArray().map(v=>+v.toFixed(2)),
           rig:{x:+a.rig.x.toFixed(2),z:+a.rig.z.toFixed(2),dist:+a.rig.dist.toFixed(2),pitch:+a.rig.pitch.toFixed(2)},
           me:{x:+a.me.x.toFixed(2),z:+a.me.z.toFixed(2)},
           bg: !!s.scene.background, env: !!s.scene.environment,
           sunI: s.sun.intensity, hemiI: s.hemi.intensity,
           floorVisible: a.arena.floor.visible, floorMat: a.arena.floor.material.type };
})));
// render straight to screen, no post
await p.evaluate(()=>{ window.__overrun.stage.composer=null; window.__overrun.stage.grade=null; });
await p.waitForTimeout(700);
await p.screenshot({path:'shots/diag-nopost.png'});
// also: disable env + set basic lighting
await p.evaluate(()=>{ const s=window.__overrun.stage; s.scene.background=null; s.renderer.setClearColor(0x336699,1); });
await p.waitForTimeout(500);
await p.screenshot({path:'shots/diag-clear.png'});
console.log(logs.slice(0,8).join('\n'));
await b.close();
