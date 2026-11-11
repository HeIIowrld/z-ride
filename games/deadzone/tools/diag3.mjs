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
await p.waitForTimeout(1200);

const steps = [
  ['baseline', ()=>{}],
  ['nopost', ()=>{ window.__overrun.stage.composer=null; }],
  ['noenv', ()=>{ const s=window.__overrun.stage; s.scene.environment=null; s.scene.background=null; s.renderer.setClearColor(0x224466,1); }],
  ['ambient', ()=>{ const T=window.THREE_TEST; }],
];
for (const [name, fn] of steps) {
  await p.evaluate(fn);
  await p.waitForTimeout(500);
  const px = await p.evaluate(()=>{
    const c=document.getElementById('gl');
    const gl=c.getContext('webgl2')||c.getContext('webgl');
    const buf=new Uint8Array(4);
    // sample a point that should be floor
    gl.readPixels((c.width*0.35)|0,(c.height*0.35)|0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,buf);
    return Array.from(buf);
  }).catch(e=>'readpixels failed: '+e.message);
  console.log(name, JSON.stringify(px));
  await p.screenshot({path:`shots/diag-${name}.png`});
}
// material probe
console.log(JSON.stringify(await p.evaluate(()=>{
  const a=window.__overrun;
  const f=a.arena.floor;
  return { visible:f.visible, matColor:f.material.color.getHexString(),
    hasMap: !!f.material.map, mapImage: f.material.map ? (f.material.map.image ? f.material.map.image.width : 'noimg') : null,
    rough: f.material.roughness, metal: f.material.metalness,
    lights: a.stage.scene.children.filter(o=>o.isLight).map(l=>({t:l.type,i:l.intensity,vis:l.visible,pos:l.position.toArray().map(v=>Math.round(v))})),
    fogNear: a.stage.scene.fog?a.stage.scene.fog.near:null, fogFar: a.stage.scene.fog?a.stage.scene.fog.far:null,
    camNear: a.stage.camera.near, camFar: a.stage.camera.far,
    floorWorldY: f.position.y, floorGeoR: f.geometry.parameters ? f.geometry.parameters.radius : '?'
  };
}), null, 2));
await b.close();
