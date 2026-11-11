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
p.on('console',m=>{ const t=m.text(); if(t.includes('THREE')||t.includes('GLSL')||t.includes('shader')||m.type()==='error') console.log('C:',t.slice(0,900)); });
await p.goto('http://localhost:4173/', { waitUntil:'networkidle' });
await p.waitForFunction(()=>window.__overrun && window.__overrun.state==='title',{timeout:60000});
await p.evaluate(()=>window.__overrun.startLocal('coop'));
await p.waitForFunction(()=>window.__overrun.state==='play',{timeout:20000});
await p.waitForTimeout(700);
await p.evaluate(()=>{
  const a=window.__overrun,s=a.sim;
  for(let i=0;i<30;i++){const ang=i/30*Math.PI*2; s.spawnEnemy('rusher', a.me.x+Math.cos(ang)*10, a.me.z+Math.sin(ang)*10);}
  for(const e of s.enemies) if(e.alive) e.spawnT=0;
});
await p.waitForTimeout(1200);
console.log(JSON.stringify(await p.evaluate(()=>{
  const a=window.__overrun, s=a.stage;
  const out={ alive:a.sim.aliveEnemies, meshes:{} };
  for(const k in a.swarm.meshes){
    const m=a.swarm.meshes[k];
    const mp=s.renderer.properties.get(m.material);
    const prog=mp&&mp.currentProgram;
    out.meshes[k]={count:m.count, visible:m.visible, hasProg:!!prog,
      diagnostics: prog && prog.diagnostics ? String(prog.diagnostics.fragmentShader && prog.diagnostics.fragmentShader.log || prog.diagnostics.vertexShader && prog.diagnostics.vertexShader.log || 'ok').slice(0,300) : null,
      geoAttrs: Object.keys(m.geometry.attributes), bs: m.geometry.boundingSphere ? +m.geometry.boundingSphere.radius.toFixed(2) : null };
  }
  return out;
}), null, 2));
await p.screenshot({path:'shots/diag-swarm.png'});
await b.close();
