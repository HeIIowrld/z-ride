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
const logs=[]; p.on('console', m=>logs.push(m.type()+': '+m.text())); p.on('pageerror',e=>logs.push('ERR '+e.message));
await p.goto('http://localhost:4173/?debug', { waitUntil:'networkidle' });
await p.waitForFunction(()=>window.__overrun && window.__overrun.state==='title',{timeout:60000});
await p.waitForTimeout(500);
console.log(JSON.stringify(await p.evaluate(()=>{
  const a=window.__overrun, s=a.stage;
  const gl = s.renderer.getContext();
  let meshes=0, visible=0;
  s.scene.traverse(o=>{ if(o.isMesh||o.isPoints||o.isInstancedMesh){meshes++; if(o.visible)visible++;} });
  return {
    tier:s.tier, dpr:s.dpr,
    hasComposer: !!s.composer,
    passes: s.composer ? s.composer.passes.map(x=>x.constructor.name) : [],
    background: s.scene.background ? s.scene.background.constructor.name : null,
    environment: s.scene.environment ? s.scene.environment.constructor.name : null,
    camPos: s.camera.position.toArray().map(v=>+v.toFixed(2)),
    camFov: s.camera.fov,
    meshes, visible,
    glErr: gl.getError(),
    ctxLost: s.renderer.getContext().isContextLost ? s.renderer.getContext().isContextLost() : 'n/a',
    caps: { maxTex: s.renderer.capabilities.maxTextureSize, float: s.renderer.capabilities.floatFragmentTextures },
    arenaChildren: a.arena.group.children.length
  };
},), null, 2));
// try rendering without composer
await p.evaluate(()=>{ const s=window.__overrun.stage; s.composer=null; });
await p.waitForTimeout(600);
await p.screenshot({path:'/tmp/nocomposer.png'});
console.log(logs.slice(0,15).join('\n'));
await b.close();
