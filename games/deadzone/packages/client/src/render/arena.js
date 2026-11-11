// Modified for Z-RIDE parking-lot environment.
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

/* =============================== ARENA =================================
   Visual body for the shared World. The simulation owns where cover is; this
   file owns what it looks like and how it arrives.

   Everything is instanced. A full arena — floor, wall, thirty-four props,
   railings, floodlight masts and painted markings — costs eight draw calls,
   which is what makes 60fps on a mid-range phone possible at all. */

import * as THREE from 'three';
import { TRUNK_Z, VEHICLE_HALF_LENGTH } from '@overrun/shared/vehicle-defense.js';
import { concreteSet, steelSet, blobShadow, scorchDecal } from './textures.js';

const TYPE_ORDER = ['block', 'pillar', 'crate', 'ramp'];

export class Arena {
  constructor(stage, world) {
    this.stage = stage;
    this.world = world;
    this.group = new THREE.Group();
    stage.scene.add(this.group);
    this.dummy = new THREE.Object3D();
    this.build();
  }

  build() {
    const R = this.world.radius;
    const scene = this.group;

    /* ---- floor ---- */
    const con = concreteSet(1024, { repeat: Math.round(R / 4) });
    const floorMat = new THREE.MeshStandardMaterial({
      map: con.map, roughnessMap: con.roughnessMap, normalMap: con.normalMap,
      roughness: 1.0, metalness: 0.0, color: 0x777E70
    });
    floorMat.normalScale.set(0.9, 0.9);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(R + 4, 96), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    this.floor = floor;
    const carBody=new THREE.BoxGeometry(2.3,1.1,4.4),carRoof=new THREE.BoxGeometry(1.9,.8,2.1);
    for(let i=0;i<12;i++){
      const a=i/12*Math.PI*2,r=R+7;
      const car=new THREE.Group();
      const mat=new THREE.MeshStandardMaterial({color:[0x58625b,0x9e9a82,0x3a4e52][i%3],roughness:.7});
      const body=new THREE.Mesh(carBody,mat);body.position.y=.9;car.add(body);
      const roof=new THREE.Mesh(carRoof,new THREE.MeshStandardMaterial({color:0x263936,roughness:.3}));roof.position.set(0,1.65,-.1);car.add(roof);
      car.position.set(Math.cos(a)*r,0,Math.sin(a)*r);car.rotation.y=-a;scene.add(car);
    }

    if (this.world.vehicleDefense) this.buildTeamVehicle();

    // Arena markings live on their own non-tiling decal. Painting them into
    // the concrete texture would repeat them once per tile — a dozen centre
    // circles is a very quick way to make a floor look like wallpaper.
    const marks = new THREE.Mesh(
      new THREE.CircleGeometry(R + 1, 96),
      new THREE.MeshBasicMaterial({ map: markingsTexture(), transparent: true, depthWrite: false, opacity: 0.85 })
    );
    marks.rotation.x = -Math.PI / 2;
    marks.position.y = 0.012;
    marks.renderOrder = 1;
    scene.add(marks);

    /* ---- ground beyond the arena, so the horizon reads as a place ---- */
    const outerMat = new THREE.MeshStandardMaterial({ color: 0x6E7364, roughness: 1, metalness: 0 });
    const outer = new THREE.Mesh(new THREE.RingGeometry(R + 3.6, 260, 72, 1), outerMat);
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.35;
    scene.add(outer);

    /* ---- perimeter wall ---- */
    const steel = steelSet(512, { repeat: 6, base: [138, 146, 150] });
    const wallMat = new THREE.MeshStandardMaterial({
      map: steel.map, roughnessMap: steel.roughnessMap, metalnessMap: steel.metalnessMap,
      normalMap: steel.normalMap, roughness: 0.86, metalness: 0.15,
      color: 0xB6C2CC, side: THREE.DoubleSide
    });
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(R + 1.6, R + 1.6, 5.2, 96, 1, true), wallMat);
    wall.position.y = 2.6;
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);

    // Hazard-striped kerb at the base of the wall. Peripheral information:
    // you never look at it, but you always know where the edge is.
    const kerbTex = stripeTexture();
    const kerb = new THREE.Mesh(
      new THREE.CylinderGeometry(R + 1.55, R + 1.9, 0.75, 96, 1, true),
      new THREE.MeshStandardMaterial({ map: kerbTex, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide })
    );
    kerb.position.y = 0.37;
    kerb.receiveShadow = true;
    scene.add(kerb);

    // Top rail, thin and bright, so the arena has a clean silhouette line.
    const rail = new THREE.Mesh(
      new THREE.TorusGeometry(R + 1.6, 0.12, 8, 128),
      new THREE.MeshStandardMaterial({ color: 0xE8B84B, roughness: 0.4, metalness: 0.6 })
    );
    rail.rotation.x = Math.PI / 2;
    rail.position.y = 5.2;
    scene.add(rail);

    /* ---- floodlight masts, purely to give the sky something to interrupt ---- */
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x9AA6B0, roughness: 0.6, metalness: 0.2 });
    const masts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.34, 16, 8), mastMat, 8);
    const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(2.6, 0.9, 0.5),
      new THREE.MeshStandardMaterial({ color: 0xDDE4E8, roughness: 0.35, metalness: 0.3, emissive: 0xFFF0C4, emissiveIntensity: 0.35 }), 8);
    masts.castShadow = heads.castShadow = true;
    const d = this.dummy;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.4;
      const x = Math.cos(a) * (R + 5.5), z = Math.sin(a) * (R + 5.5);
      d.position.set(x, 8, z); d.rotation.set(0, -a, 0); d.scale.setScalar(1);
      d.updateMatrix(); masts.setMatrixAt(i, d.matrix);
      d.position.set(x, 16.2, z); d.rotation.set(-0.5, -a, 0);
      d.updateMatrix(); heads.setMatrixAt(i, d.matrix);
    }
    scene.add(masts); scene.add(heads);

    const warningCanvas=document.createElement('canvas');warningCanvas.width=512;warningCanvas.height=160;
    const w=warningCanvas.getContext('2d');w.fillStyle='#352920';w.fillRect(0,0,512,160);
    w.fillStyle='#dfbb60';w.fillRect(0,0,512,10);w.fillRect(0,150,512,10);
    w.font='900 48px system-ui';w.textAlign='center';w.fillText('QUARANTINE',256,74);
    w.font='bold 20px monospace';w.fillText('INFECTED AREA / DO NOT ENTER',256,119);
    const warningTexture=new THREE.CanvasTexture(warningCanvas);warningTexture.colorSpace=THREE.SRGBColorSpace;
    const warningMat=new THREE.MeshBasicMaterial({map:warningTexture,side:THREE.DoubleSide});
    this.beacons=[];
    for(let i=0;i<4;i++){
      const a=i*Math.PI/2;
      const board=new THREE.Mesh(new THREE.PlaneGeometry(12,3.75),warningMat);
      board.position.set(Math.cos(a)*(R-.2),3.2,Math.sin(a)*(R-.2));board.lookAt(0,3.2,0);scene.add(board);
      const lamp=new THREE.Mesh(new THREE.SphereGeometry(.38,8,6),new THREE.MeshBasicMaterial({color:0xf05b35}));
      lamp.position.set(Math.cos(a)*(R-1),5.9,Math.sin(a)*(R-1));scene.add(lamp);this.beacons.push(lamp);
    }

    /* ---- props: one instanced mesh per prop type ---- */
    const propSteel = steelSet(512, { repeat: 2, base: [128, 140, 146], seed: 33 });
    // Metalness 0.12, and no metalness map. Physically these are painted steel
    // and should be metallic, but a metal is lit almost entirely by its
    // environment — and with a single low-cost IBL that reads as near-black.
    // Cover has to be legible before it has to be correct, so the props are
    // treated as painted dielectrics and given their brightness back.
    const propMat = new THREE.MeshStandardMaterial({
      map: propSteel.map, roughnessMap: propSteel.roughnessMap, normalMap: propSteel.normalMap,
      normalScale: new THREE.Vector2(0.65, 0.65),
      roughness: 0.85, metalness: 0.12, color: 0xC9D3DA
    });
    // Crates are painted wood-and-composite, so no metalness map at all.
    const crateMat = new THREE.MeshStandardMaterial({
      map: propSteel.map, roughnessMap: propSteel.roughnessMap, normalMap: propSteel.normalMap,
      normalScale: new THREE.Vector2(0.65, 0.65),
      roughness: 0.88, metalness: 0.04, color: 0xF0BE7C
    });

    const geos = {
      block: new THREE.BoxGeometry(1, 1, 1),
      pillar: new THREE.CylinderGeometry(1, 1.06, 1, 12),
      crate: new THREE.BoxGeometry(1, 1, 1),
      ramp: rampGeometry()
    };
    this.propMeshes = {};
    for (const key of TYPE_ORDER) {
      const m = new THREE.InstancedMesh(geos[key], key === 'crate' ? crateMat : propMat, 64);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
      this.propMeshes[key] = m;
    }

    /* ---- ground decals: scorch marks from explosions ---- */
    const decalMat = new THREE.MeshBasicMaterial({
      map: scorchDecal(), transparent: true, depthWrite: false, opacity: 0.9
    });
    this.decals = new THREE.InstancedMesh(planeXZ(), decalMat, 48);
    this.decals.frustumCulled = false;
    this.decals.count = 0;
    this.decals.renderOrder = 1;
    scene.add(this.decals);
    this.decalList = [];
    for (let i = 0; i < 48; i++) this.decalList.push({ alive: false, x: 0, z: 0, r: 1, t: 0, life: 1, rot: 0 });

    /* ---- soft contact shadows for everything small and fast ---- */
    const blobMat = new THREE.MeshBasicMaterial({
      map: blobShadow(), transparent: true, depthWrite: false, opacity: 1, color: 0xffffff
    });
    this.blobs = new THREE.InstancedMesh(planeXZ(), blobMat, 300);
    this.blobs.frustumCulled = false;
    this.blobs.count = 0;
    this.blobs.renderOrder = 2;
    scene.add(this.blobs);
    this._blobN = 0;

    /* ---- the closing ring, for Squad Royale ---- */
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xFF4E7A, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false
    });
    this.shrinkRing = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 9, 72, 1, true), ringMat);
    this.shrinkRing.position.y = 4.5;
    this.shrinkRing.visible = false;
    scene.add(this.shrinkRing);
  }

  /* --------------------------------------------------------------- UPDATE */

  buildTeamVehicle() {
    const vehicle = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({ color: 0x91b94d, metalness: 0.52, roughness: 0.38 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x161e20, roughness: 0.83 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x23383d, metalness: 0.54, roughness: 0.28 });
    const lamps = new THREE.MeshStandardMaterial({ color: 0xd8f9ff, emissive: 0x9feaff, emissiveIntensity: 0.5 });
    const tail = new THREE.MeshStandardMaterial({ color: 0xff5341, emissive: 0xdc2818, emissiveIntensity: 0.8 });
    const box = (material, w, h, d, x, y, z) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      vehicle.add(mesh);
      return mesh;
    };

    box(trim, 2.8, 0.58, 5.2, 0, 0.59, 0);
    box(paint, 2.74, 0.62, 5.08, 0, 1.02, 0);
    box(paint, 2.35, 0.28, 1.38, 0, 1.42, -1.77).rotation.x = 0.1;
    box(glass, 2.25, 0.68, 2.78, 0, 1.64, 0.28);
    box(paint, 2.28, 0.23, 2.43, 0, 2.02, 0.36);
    box(trim, 1.25, 0.2, 0.18, 0, 1, VEHICLE_HALF_LENGTH - 0.08);
    for (const side of [-1, 1]) {
      box(lamps, 0.72, 0.24, 0.13, side * 0.9, 1.14, -2.57);
      box(tail, 0.72, 0.19, 0.13, side * 0.91, 1.18, 2.57);
      box(trim, 0.08, 0.12, 2.66, side * 0.82, 2.18, 0.28);
      box(paint, 0.37, 0.22, 0.36, side * 1.29, 1.6, -0.75);
      for (const z of [-1.65, 1.64]) {
        const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.53, 0.53, 0.3, 12), trim);
        tire.rotation.z = Math.PI / 2;
        tire.position.set(side * 1.26, 0.52, z);
        tire.castShadow = true;
        vehicle.add(tire);
      }
    }
    this.teamPaint = paint;
    this.headlamps = lamps;
    this.group.add(vehicle);

    const trunk = new THREE.Mesh(new THREE.RingGeometry(1.7, 1.88, 36),
      new THREE.MeshBasicMaterial({ color: 0xffc959, side: THREE.DoubleSide }));
    trunk.rotation.x = -Math.PI / 2;
    trunk.position.set(0, 0.06, TRUNK_Z);
    this.group.add(trunk);

    const geometry = new THREE.BufferGeometry();
    const front = -VEHICLE_HALF_LENGTH;
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -2.2, 0.06, front, 2.2, 0.06, front, 11.5, 0.06, front - 15,
      -2.2, 0.06, front, 11.5, 0.06, front - 15, -11.5, 0.06, front - 15
    ], 3));
    this.headlightBeam = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      color: 0xb8f3ff, transparent: true, opacity: 0.2, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending
    }));
    this.headlightBeam.visible = false;
    this.group.add(this.headlightBeam);
  }

  update(dt, shrinkRadius, defense) {
    this.world.animate(dt);
    if (this.headlightBeam && defense) {
      this.headlightBeam.visible = defense.flash > 0;
      this.headlamps.emissiveIntensity = defense.flash > 0 ? 3 : 0.5;
      this.teamPaint.color.setHex(defense.hp / defense.maxHp <= 0.35 ? 0xbc694b : 0x91b94d);
    }
    this.beaconTime=(this.beaconTime||0)+dt;
    this.beacons.forEach((b,i)=>b.material.color.setRGB(1,.18,.035).multiplyScalar(.45+.55*Math.max(0,Math.sin(this.beaconTime*5+i))));

    const d = this.dummy;
    for (const key of TYPE_ORDER) {
      const mesh = this.propMeshes[key];
      let n = 0;
      for (const p of this.world.props) {
        if (p.type !== key || !p.alive) continue;
        if (n >= 64) break;
        d.position.set(p.x, p.y + p.h / 2, p.z);
        d.rotation.set(0, p.rot, 0);
        if (key === 'pillar') d.scale.set(p.r, p.h, p.r);
        else if (key === 'ramp') d.scale.set(p.r * 2, p.h, p.r * 1.6);
        else d.scale.set(p.r * 1.7, p.h, p.r * 1.7);
        d.updateMatrix();
        mesh.setMatrixAt(n++, d.matrix);
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }

    // decals
    let dn = 0;
    for (const s of this.decalList) {
      if (!s.alive) continue;
      s.t += dt;
      if (s.t > s.life) { s.alive = false; continue; }
      const fade = 1 - Math.max(0, (s.t - s.life * 0.7) / (s.life * 0.3));
      d.position.set(s.x, 0.028, s.z);
      d.rotation.set(0, s.rot, 0);
      d.scale.set(s.r * 2, 1, s.r * 2);
      d.updateMatrix();
      this.decals.setMatrixAt(dn, d.matrix);
      this.decals.setColorAt(dn, TMP_COL.setScalar(fade));
      dn++;
    }
    this.decals.count = dn;
    this.decals.instanceMatrix.needsUpdate = true;
    if (this.decals.instanceColor) this.decals.instanceColor.needsUpdate = true;

    // shrink ring
    if (shrinkRadius && shrinkRadius < this.world.radius - 0.5) {
      this.shrinkRing.visible = true;
      this.shrinkRing.scale.set(shrinkRadius, 1, shrinkRadius);
      this.shrinkRing.material.opacity = 0.22 + Math.sin(performance.now() * 0.004) * 0.08;
    } else this.shrinkRing.visible = false;
  }

  beginBlobs() { this._blobN = 0; }

  addBlob(x, z, r, alpha = 1) {
    if (this._blobN >= 300) return;
    const d = this.dummy;
    d.position.set(x, 0.02, z);
    d.rotation.set(0, 0, 0);
    d.scale.set(r * 2.4, 1, r * 2.4);
    d.updateMatrix();
    this.blobs.setMatrixAt(this._blobN, d.matrix);
    this.blobs.setColorAt(this._blobN, TMP_COL.setScalar(alpha));
    this._blobN++;
  }

  endBlobs() {
    this.blobs.count = this._blobN;
    this.blobs.instanceMatrix.needsUpdate = true;
    if (this.blobs.instanceColor) this.blobs.instanceColor.needsUpdate = true;
  }

  scorch(x, z, r) {
    for (const s of this.decalList) {
      if (s.alive) continue;
      s.alive = true; s.x = x; s.z = z; s.r = r; s.t = 0;
      s.life = 14; s.rot = Math.random() * Math.PI * 2;
      return;
    }
  }
}

const TMP_COL = new THREE.Color();

function planeXZ() {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

function rampGeometry() {
  // A wedge. Cheap cover you can shoot over but not hide behind.
  const g = new THREE.BufferGeometry();
  const v = new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5,
    -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5,
    -0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    -0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5,
    0.5, -0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5,
    -0.5, -0.5, -0.5, -0.5, 0.5, 0.5, 0.5, 0.5, 0.5,
    -0.5, -0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, -0.5
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

/** The painted circle, lane lines and corner marks — drawn once at arena
 *  scale so nothing repeats. */
function markingsTexture() {
  const S=1024,c=document.createElement('canvas');c.width=c.height=S;
  const g=c.getContext('2d');g.clearRect(0,0,S,S);
  g.lineWidth=3;g.strokeStyle='#e5e9c7';g.globalAlpha=.85;
  for(const row of [200,650])for(let col=180;col<=800;col+=90){
    g.strokeRect(col,row,82,160);g.font='bold 24px monospace';g.fillStyle='#dbe5be';g.fillText('P',col+30,row+95);
  }
  g.setLineDash([26,20]);g.strokeStyle='#f4cf73';g.lineWidth=7;
  g.beginPath();g.moveTo(110,512);g.lineTo(910,512);g.stroke();g.setLineDash([]);
  let seed=173;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<35;i++){
    const x=125+random()*774,y=130+random()*760;
    g.fillStyle=i%4===0?'#668c32':'#622f27';g.globalAlpha=.45+random()*.35;
    g.beginPath();g.ellipse(x,y,8+random()*20,5+random()*11,random()*6.28,0,Math.PI*2);g.fill();
    for(let j=0;j<4;j++){g.beginPath();g.arc(x+(random()-.5)*55,y+(random()-.5)*40,1+random()*3,0,Math.PI*2);g.fill();}
  }
  g.globalAlpha=.85;
  g.fillStyle='#d8c990';g.font='900 25px system-ui';g.textAlign='center';g.fillText('QUARANTINE / INFECTED AREA',512,602);
  g.font='900 31px system-ui';g.fillStyle='#cbdc9c';g.textAlign='center';g.fillText('SECTOR P-01',512,100);
  g.fillStyle='#efb774';g.font='bold 18px monospace';g.fillText('EVACUATION ZONE',512,940);
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;
}

function stripeTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#2C3238';
  g.fillRect(0, 0, 256, 32);
  g.fillStyle = '#F0C64E';
  g.save();
  for (let i = -2; i < 12; i++) {
    g.beginPath();
    g.moveTo(i * 24, 0); g.lineTo(i * 24 + 12, 0);
    g.lineTo(i * 24 + 12 + 16, 32); g.lineTo(i * 24 + 16, 32);
    g.closePath(); g.fill();
  }
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(28, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
