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
const p = await b.newPage({ viewport: { width: 900, height: 520 } });
p.on('pageerror',e=>console.log('PAGEERR',e.message));
await p.goto('http://localhost:4173/', { waitUntil:'networkidle' });
await p.waitForFunction(()=>window.__overrun && window.__overrun.state==='title',{timeout:60000});
await p.evaluate(()=>window.__overrun.startLocal('coop'));
await p.waitForFunction(()=>window.__overrun.state==='play',{timeout:20000});
await p.waitForTimeout(600);
const spawn = ()=>{ const a=window.__overrun,s=a.sim;
  for(let i=0;i<24;i++){const ang=i/24*Math.PI*2; const e=s.spawnEnemy('rusher', a.me.x+Math.cos(ang)*9, a.me.z+Math.sin(ang)*9); if(e) e.spawnT=0;} };
await p.evaluate(spawn);
await p.waitForTimeout(900);
await p.screenshot({path:'shots/s1-patched.png'});

// strip the shader patch and force recompile
await p.evaluate(()=>{
  const a=window.__overrun;
  for(const k in a.swarm.meshes){ const m=a.swarm.meshes[k]; m.material.onBeforeCompile=()=>{}; m.material.customProgramCacheKey=()=>'plain'; m.material.needsUpdate=true; }
});
await p.waitForTimeout(900);
await p.screenshot({path:'shots/s2-nopatch.png'});

// also drop vertexColors + instanceColor
await p.evaluate(()=>{
  const a=window.__overrun;
  for(const k in a.swarm.meshes){ const m=a.swarm.meshes[k]; m.material.vertexColors=false; m.material.color.setHex(0xff2d6b); m.material.needsUpdate=true; }
});
await p.waitForTimeout(900);
await p.screenshot({path:'shots/s3-flat.png'});
await b.close();
