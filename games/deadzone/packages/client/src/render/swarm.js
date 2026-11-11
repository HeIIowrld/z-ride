// Modified for Z-RIDE zombie character geometry.
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

/* ============================== THE SWARM ==============================

   Two hundred and sixty enemies, each visibly walking, bobbing, winding up
   and flinching — in one draw call per archetype.

   The trick: skinning happens in the vertex shader, driven by instance
   attributes, with the "skeleton" baked into the geometry as a per-vertex
   part index and pivot. Each part is rotated around its own pivot by an angle
   derived from the instance's gait phase. No bones, no skeleton uniforms, no
   per-object CPU work — the entire crowd animates for the cost of a few extra
   attributes and about twenty lines of GLSL.

   It is not as expressive as the real rig used for players, and it does not
   need to be: at the distance and scale a rusher is seen, an articulated
   silhouette with correct timing is indistinguishable from a skinned one.  */

import * as THREE from 'three';
import { ENEMY_TYPES, COL } from '@overrun/shared/defs.js';

/* Part indices understood by the shader. */
const PART = { BODY: 0, LEG_L: 1, LEG_R: 2, HEAD: 3, ARM_L: 4, ARM_R: 5, SHELL: 6, EYE: 7 };

const vertexPatch = /* glsl */`
  attribute float aPart;
  attribute vec3  aPivot;
  attribute float aPhase;
  attribute vec4  aState;   // x: gait speed, y: windup 0..1, z: flash 0..1, w: spawn/scale pop
  varying float vFlash;
  varying float vWind;
  varying float vAO;
  varying float vEye;

  mat3 rotX(float a){ float c=cos(a), s=sin(a); return mat3(1.,0.,0., 0.,c,-s, 0.,s,c); }
  mat3 rotY(float a){ float c=cos(a), s=sin(a); return mat3(c,0.,s, 0.,1.,0., -s,0.,c); }
  mat3 rotZ(float a){ float c=cos(a), s=sin(a); return mat3(c,-s,0., s,c,0., 0.,0.,1.); }
`;

const transformPatch = /* glsl */`
  float gait   = aState.x;
  float wind   = aState.y;
  float spawnK = aState.w;
  vFlash = aState.z;
  vWind  = wind;
  vEye = aPart == 7.0 ? 1.0 : 0.0;

  float ph = aPhase;
  vec3 p = transformed;
  vec3 local = p - aPivot;

  if (aPart == 1.0 || aPart == 2.0) {
    // Legs. Opposite phase, knee-free single-segment swing — at this scale a
    // straight limb swinging correctly reads better than a bent one that is
    // one pixel tall.
    float side = (aPart == 1.0) ? 0.0 : 3.14159265;
    float limp = aPart == 1.0 ? 0.48 : 0.86;
    float sw = sin(ph + side) * gait * limp;
    float lift = max(0.0, sin(ph + side + 0.5)) * gait * 0.5;
    local = rotX(sw) * local;
    local.y += lift * 0.12;
  } else if (aPart == 3.0 || aPart == 7.0) {
    // Head: counter-rotates slightly against the body sway, which is what
    // makes a walk look like it has weight.
    local = rotZ(-0.16 + sin(ph * 0.5) * gait * 0.11) * local;
    local = rotX(wind * -0.35) * local;
  } else if (aPart == 4.0 || aPart == 5.0) {
    float side = (aPart == 4.0) ? 3.14159265 : 0.0;
    float sw = sin(ph * 0.62 + side) * gait * 0.16;
    local = rotX(sw) * local;
    // Wind-up raises both arms — the telegraph is in the pose, not only in
    // the ring on the floor.
    local = rotZ((aPart == 4.0 ? 1.0 : -1.0) * wind * 0.9) * local;
  } else if (aPart == 6.0) {
    // Shell/carapace: squash-and-stretch on the wind-up, then a snap.
    local.y *= 1.0 + wind * 0.22;
    local.xz *= 1.0 - wind * 0.10;
  } else {
    // Body: vertical bob and a roll, both from the same phase as the legs.
    local = rotZ(sin(ph) * gait * 0.07) * local;
    local.y += sin(ph) * gait * 0.035;
    local = rotX(gait * 0.10) * local;
  }

  transformed = aPivot + local;

  // Spawn pop: scale in from nothing with a slight overshoot.
  float pop = 1.0 - spawnK;
  transformed *= mix(1.0, 1.0 + sin(pop * 3.14159) * 0.18, step(0.001, spawnK)) * mix(0.05, 1.0, pop);

  // Cheap vertical AO term so the underside of a body is not lit like the top.
  vAO = clamp(transformed.y * 1.4 + 0.35, 0.25, 1.0);
`;

const fragmentPatch = /* glsl */`
  // Hit flash blows out to white; wind-up pushes toward the danger colour.
  // Colour carries state, and rose always means "this can kill you".
  vec3 warn = vec3(1.0, 0.18, 0.42);
  diffuseColor.rgb = mix(diffuseColor.rgb * vAO, warn, vWind * 0.55);
  diffuseColor.rgb += vec3(vFlash * 1.6) + vEye * vec3(1.5, 0.22, 0.03);
`;

/* ------------------------------------------------------- GEOMETRY BUILDERS */

function tagged(geo, part, pivot, translate) {
  if (translate) geo.translate(translate[0], translate[1], translate[2]);
  // Everything is flattened to non-indexed before merging. three's primitives
  // are inconsistent about this — icosahedra come out non-indexed, cylinders
  // and spheres come out indexed — and concatenating the two without dropping
  // the index buffer produces a mesh made of scrambled triangles. This one
  // line is the difference between a walking drone and confetti.
  if (geo.index) {
    const flat = geo.toNonIndexed();
    geo.dispose();
    geo = flat;
  }
  const n = geo.attributes.position.count;
  const parts = new Float32Array(n);
  const pivots = new Float32Array(n * 3);
  parts.fill(part);
  for (let i = 0; i < n; i++) {
    pivots[i * 3] = pivot[0];
    pivots[i * 3 + 1] = pivot[1];
    pivots[i * 3 + 2] = pivot[2];
  }
  geo.setAttribute('aPart', new THREE.BufferAttribute(parts, 1));
  geo.setAttribute('aPivot', new THREE.BufferAttribute(pivots, 3));
  return geo;
}

function mergeTagged(list) {
  let total = 0;
  for (const g of list) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const part = new Float32Array(total);
  const piv = new Float32Array(total * 3);
  let o = 0;
  for (const g of list) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array.subarray(0, n * 3), o * 3);
    nor.set(g.attributes.normal.array.subarray(0, n * 3), o * 3);
    if (g.attributes.color) col.set(g.attributes.color.array.subarray(0, n * 3), o * 3);
    else col.fill(1, o * 3, (o + n) * 3);
    part.set(g.attributes.aPart.array.subarray(0, n), o);
    piv.set(g.attributes.aPivot.array.subarray(0, n * 3), o * 3);
    o += n;
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  geo.setAttribute('aPivot', new THREE.Float32BufferAttribute(piv, 3));
  geo.computeBoundingSphere();
  return geo;
}

function paint(geo, hex) {
  // Same reason as tagged(): the colour attribute has to be sized against the
  // vertex list that will actually be drawn, not the pre-index one.
  if (geo.index) {
    const flat = geo.toNonIndexed();
    geo.dispose();
    geo = flat;
  }
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Z-RIDE infected: exaggerated head, reaching hands, torn civilian clothes.
 * All pieces remain tagged and merged, retaining one draw call per archetype. */
export function zombieGeometry(kind) {
  const tank=['bruiser','warden','elite','boss','splitter'].includes(kind);
  const runner=['stalker','shard'].includes(kind);
  const spitter=kind==='spitter', bomber=kind==='sapper';
  const skin=spitter?0xb4ca62:runner?0xbec69b:0xadc486;
  const cloth=kind==='warden'?0xa49a3e:tank?0x655047:runner?0x733b37:0x4a6150;
  const pants=0x273c38, wound=0x74382d, bone=0xe1d8b3;
  const bodyWidth=tank?1.18:.76, skull=tank?.73:.65;
  const pieces=[];
  const put=(geo,part,pivot,pos,color,rotation=null)=>{
    if(rotation){geo.rotateX(rotation[0]||0);geo.rotateY(rotation[1]||0);geo.rotateZ(rotation[2]||0);}
    pieces.push(tagged(paint(geo,color),part,pivot,pos));
  };
  const box=(part,pivot,size,pos,color,rotation)=>put(new THREE.BoxGeometry(...size),part,pivot,pos,color,rotation);
  const ball=(part,pivot,size,pos,color)=>{const g=new THREE.SphereGeometry(1,8,6);g.scale(...size);put(g,part,pivot,pos,color);};
  const torso=[0,1.13,.06],head=[.06,1.97,.31];
  // A round, exposed belly on the mutated types; others wear a ripped shirt.
  if(tank||bomber)ball(PART.BODY,torso,[bodyWidth*.64,.66,.47],[0,1.17,.13],bomber?0xa8b35c:skin);
  box(PART.BODY,torso,[bodyWidth,.67,.45],[0,1.38,.14],cloth,[.22,0,.07]);
  // Ragged hem, bare ribs and diagonal slashes are silhouettes, not just tint.
  for(let i=0;i<5;i++){
    const g=new THREE.ConeGeometry(.13,.28,3);g.rotateZ(Math.PI);
    put(g,PART.BODY,torso,[-bodyWidth*.42+i*bodyWidth*.21,.93+(i%2)*.06,.17],cloth);
  }
  box(PART.BODY,torso,[.27,.32,.035],[-.19,1.32,.407],wound,[0,0,-.28]);
  for(let i=0;i<3;i++)box(PART.BODY,torso,[.23,.035,.04],[-.15,1.20+i*.08,.435],bone,[0,0,-.22]);
  // Oversized crooked skull; the brow and open jaw read from the game camera.
  ball(PART.HEAD,head,[skull*.52,.43,.37],[.09,2.10,.38],skin);
  box(PART.HEAD,head,[skull*.9,.20,.35],[.11,1.83,.55],skin,[.25,0,-.12]);
  box(PART.HEAD,head,[skull*.72,.21,.035],[.10,1.94,.711],0x263129,[.12,0,-.08]);
  for(let i=0;i<4;i++)box(PART.HEAD,head,[.055,.10,.04],[-.08+i*.12,1.99,.745],bone,[0,0,(i%2)*.1]);
  box(PART.HEAD,head,[.12,.15,.16],[.07,2.12,.74],skin);
  // Asymmetric hair cap, missing patch, exposed temple.
  box(PART.HEAD,head,[skull*.94,.16,.46],[.04,2.41,.30],0x28342d,[0,0,-.12]);
  box(PART.HEAD,head,[.19,.20,.035],[-.20,2.25,.59],wound,[0,0,-.2]);
  for(const x of [-.13,.25]){
    box(PART.HEAD,head,[.24,.16,.055],[x,2.24,.663],0x26342c,[0,0,x<0?.16:-.15]);
    box(PART.EYE,head,[.13,.085,.07],[x,2.24,.70],0xff5b25);
  }
  // One intact trouser leg, one torn cuff and exposed shin.
  box(PART.LEG_L,[.23,.86,0],[.29,.53,.30],[.23,.65,-.02],pants,[.10,0,.06]);
  box(PART.LEG_L,[.23,.86,0],[.21,.38,.22],[.24,.28,.03],skin,[.12,0,.04]);
  box(PART.LEG_R,[-.23,.86,0],[.29,.76,.30],[-.23,.45,-.06],pants,[-.09,0,-.08]);
  box(PART.LEG_R,[-.23,.86,0],[.14,.22,.025],[-.20,.47,.102],wound);
  box(PART.LEG_L,[.23,.86,0],[.32,.17,.48],[.25,.08,.14],0x252e28);
  box(PART.LEG_R,[-.23,.86,0],[.34,.19,.47],[-.25,.08,.06],0x252e28);
  // Bent upper arms; reaching palm with separate claw-like fingers.
  for(const side of [-1,1]){
    const part=side<0?PART.ARM_L:PART.ARM_R,pivot=[side*bodyWidth*.63,1.60,.14];
    const reach=side<0?.14:0;
    box(part,pivot,[.25,.27,.46],[pivot[0],1.49,.40],cloth,[.2,0,side*.18]);
    box(part,pivot,[.18,.20,.51],[pivot[0]*1.12,1.32+reach,.78],skin,[.12,side*.13,0]);
    box(part,pivot,[.26,.15,.23],[pivot[0]*1.13,1.29+reach,1.10],skin);
    for(let f=0;f<3;f++)box(part,pivot,[.055,.075,.22],[pivot[0]*1.13+(f-1)*.075,1.27+reach,1.27],skin,[.25,0,0]);
    box(part,pivot,[.10,.17,.03],[pivot[0],1.43,.64],wound);
  }
  if(spitter){ball(PART.HEAD,head,[.20,.17,.10],[.1,1.90,.78],0xb6ed49);ball(PART.BODY,torso,[.25,.30,.16],[.26,1.1,.52],0x91a83b);}
  if(bomber)for(let i=0;i<4;i++)ball(PART.BODY,torso,[.14,.15,.13],[Math.cos(i*2)*.50,1.03+(i%2)*.32,.50],0xc0a354);
  if(kind==='warden'){
    box(PART.BODY,torso,[bodyWidth*.72,.11,.035],[0,1.52,.424],0xe2d56d);
    box(PART.BODY,torso,[.12,.53,.04],[.25,1.31,.43],0xe2d56d);
  }
  if(kind==='boss'||kind==='elite')for(const side of [-1,1])ball(PART.BODY,torso,[.30,.28,.27],[side*.65,1.65,.12],0x8c9c62);
  const geo=mergeTagged(pieces);
  // Visual size improves recognition without changing collision/damage rules.
  geo.scale(runner?1.10:1.18,runner?.96:1.10,1.12);
  const piv=geo.getAttribute('aPivot');
  for(let i=0;i<piv.count;i++){piv.setXYZ(i,piv.getX(i)*(runner?1.10:1.18),piv.getY(i)*(runner?.96:1.10),piv.getZ(i)*1.12);}
  return geo;
}
const GEO_BUILDERS = Object.fromEntries(Object.keys(ENEMY_TYPES).map(key=>[key,()=>zombieGeometry(key)]));

const CAPS = {
  rusher: 200, shard: 200, splitter: 90, sapper: 60, spitter: 90,
  stalker: 70, bruiser: 60, warden: 40, elite: 22, boss: 4
};

export class Swarm {
  constructor(stage) {
    this.stage = stage;
    this.meshes = {};
    this.attrs = {};
    this.dummy = new THREE.Object3D();

    for (const key in ENEMY_TYPES) {
      const def = ENEMY_TYPES[key];
      const geo = GEO_BUILDERS[key]();
      const cap = CAPS[key] || 40;

      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.94,
        metalness: 0.0,
        emissive: new THREE.Color(def.elite ? COL.amber : 0x000000),
        emissiveIntensity: def.elite ? 0.22 : 0
      });
      mat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\n' + vertexPatch)
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + transformPatch);
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vFlash;\nvarying float vWind;\nvarying float vAO;\nvarying float vEye;')
          .replace('#include <color_fragment>', '#include <color_fragment>\n' + fragmentPatch);
      };
      // Different shader source per archetype would recompile per material;
      // a shared cache key keeps it to one program for the whole crowd.
      mat.customProgramCacheKey = () => 'zride-infected-v2';

      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;

      const phase = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      const state = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      phase.setUsage(THREE.DynamicDrawUsage);
      state.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aPhase', phase);
      geo.setAttribute('aState', state);

      stage.scene.add(mesh);
      this.meshes[key] = mesh;
      this.attrs[key] = { phase, state, cap };
    }
    this._phases = new Map();
  }

  /** Feed it the list of visible enemies. Anything not in the list is gone. */
  update(list, dt, alpha, arena) {
    const counts = {};
    for (const key in this.meshes) counts[key] = 0;
    const d = this.dummy;

    for (const e of list) {
      const key = e.key;
      const mesh = this.meshes[key];
      const at = this.attrs[key];
      if (!mesh) continue;
      const n = counts[key];
      if (n >= at.cap) continue;

      // Per-entity gait phase, advanced by its own speed. Kept in a map keyed
      // by entity id so an enemy does not restart its walk cycle whenever the
      // draw order changes.
      const speed = Math.hypot(e.vx || 0, e.vz || 0);
      let ph = this._phases.get(e.eid);
      if (ph === undefined) ph = Math.random() * Math.PI * 2;
      ph += dt * (2.4 + Math.min(1, speed / 9) * 6.5);
      this._phases.set(e.eid, ph);

      const def = ENEMY_TYPES[key];
      const scale = (e.r || def.r) / def.r * (def.scale || 1);
      const x = e.rx !== undefined ? e.rx : e.x;
      const z = e.rz !== undefined ? e.rz : e.z;

      d.position.set(x, 0, z);
      d.rotation.set(0, -(e.faceA || 0) + Math.PI / 2, 0);
      d.scale.setScalar(scale);
      d.updateMatrix();
      mesh.setMatrixAt(n, d.matrix);

      // Health tint: colour dims as it dies, so a nearly-dead target is
      // readable without a health bar.
      const hp = e.hpFrac !== undefined ? e.hpFrac : 1;
      const tint = 0.55 + hp * 0.45 + (e.buffed ? 0.35 : 0);
      mesh.setColorAt(n, TMP.setScalar(tint));

      at.phase.array[n] = ph;
      const so = n * 4;
      at.state.array[so] = Math.min(1, speed / 8);
      at.state.array[so + 1] = e.windup ? 1 : 0;
      at.state.array[so + 2] = e.flash || 0;
      at.state.array[so + 3] = e.spawning ? 1 : 0;

      if (arena) arena.addBlob(x, z, (e.r || def.r) * 0.9, 0.85);
      counts[key] = n + 1;
    }

    for (const key in this.meshes) {
      const mesh = this.meshes[key];
      const at = this.attrs[key];
      mesh.count = counts[key];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      at.phase.needsUpdate = true;
      at.state.needsUpdate = true;
    }

    // Occasional prune so the phase map does not grow across a long session.
    if (this._phases.size > 900) {
      const keep = new Set(list.map(e => e.eid));
      for (const k of this._phases.keys()) if (!keep.has(k)) this._phases.delete(k);
    }
  }
}

const TMP = new THREE.Color();
