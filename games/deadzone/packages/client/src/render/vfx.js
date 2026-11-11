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

/* ================================= VFX ==================================
   Pooled everything. Nothing in this file allocates during a match.

     • particles  — one Points cloud, per-particle size via a shader patch
     • rings      — instanced, for telegraphs, shockwaves and spawn warnings
     • trails     — instanced additive quads behind every projectile
     • beams      — instanced stretched quads for chain lightning and rails
     • numbers    — pooled DOM nodes, because text on a canvas is worse text

   The particle system runs on plain typed arrays rather than objects: at
   1400 particles updated 60 times a second, the difference between an array
   of structs and a struct of arrays is the difference between a GC pause
   every few seconds and none at all. */

import * as THREE from 'three';
import { glowSprite } from './textures.js';
import { T } from '@overrun/shared/constants.js';

export class Particles {
  constructor(stage, max = T.vfx.maxParticles) {
    this.N = max;
    this.px = new Float32Array(max); this.py = new Float32Array(max); this.pz = new Float32Array(max);
    this.vx = new Float32Array(max); this.vy = new Float32Array(max); this.vz = new Float32Array(max);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.sz = new Float32Array(max); this.grav = new Float32Array(max); this.drag = new Float32Array(max);
    this.br = new Float32Array(max); this.bg = new Float32Array(max); this.bb = new Float32Array(max);
    this.bounce = new Float32Array(max);
    this.head = 0;

    const pos = new Float32Array(max * 3);
    const col = new Float32Array(max * 3);
    const siz = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 400);

    const mat = new THREE.PointsMaterial({
      size: 1, map: glowSprite(0xFFFFFF, 0.2), vertexColors: true,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    // `size` is already a uniform in the points shader, so the per-particle
    // attribute has to be called something else or the GLSL will not link.
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = 'attribute float aSize;\n' +
        sh.vertexShader.replace('gl_PointSize = size;', 'gl_PointSize = aSize;');
    };

    this.geo = geo;
    this.pos = pos; this.col = col; this.siz = siz;
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    stage.scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, size, life, r, g, b, grav = -22, drag = 2.5, bounce = 0.32) {
    const i = this.head;
    this.head = (this.head + 1) % this.N;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = this.maxLife[i] = life;
    this.sz[i] = size; this.grav[i] = grav; this.drag[i] = drag; this.bounce[i] = bounce;
    this.br[i] = r; this.bg[i] = g; this.bb[i] = b;
  }

  burst(x, y, z, count, spd, hex, size, life, grav = -22, opts = {}) {
    const c = TMPC.setHex(hex);
    const cone = opts.cone;
    for (let i = 0; i < count; i++) {
      let a, e;
      if (cone !== undefined) {
        a = cone + (Math.random() - 0.5) * (opts.spread || 0.5);
        e = Math.random() * 0.5 - 0.05;
      } else {
        a = Math.random() * Math.PI * 2;
        e = Math.random() * 1.35 - 0.15;
      }
      const s = spd * (0.35 + Math.random() * 0.9);
      this.emit(
        x, y, z,
        Math.cos(a) * s * Math.cos(e), Math.sin(e) * s, Math.sin(a) * s * Math.cos(e),
        size * (0.6 + Math.random() * 0.8), life * (0.7 + Math.random() * 0.6),
        c.r, c.g, c.b, grav, opts.drag ?? 2.2, opts.bounce ?? 0.32
      );
    }
  }

  /** Ground-hugging smoke. Slow, big, low gravity — reads as mass. */
  smoke(x, y, z, count, spd, hex, size, life) {
    const c = TMPC.setHex(hex);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = spd * (0.2 + Math.random() * 0.6);
      this.emit(x, y, z, Math.cos(a) * s, Math.random() * 1.5, Math.sin(a) * s,
        size * (1.2 + Math.random()), life * (0.8 + Math.random() * 0.8),
        c.r, c.g, c.b, 1.2, 1.1, 0);
    }
  }

  update(dt) {
    const N = this.N;
    for (let i = 0; i < N; i++) {
      if (this.life[i] <= 0) { if (this.siz[i] !== 0) this.siz[i] = 0; continue; }
      this.life[i] -= dt;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      const d = 1 - Math.min(1, this.drag[i] * dt);
      this.vx[i] *= d; this.vz[i] *= d;
      this.vy[i] = this.vy[i] * d + this.grav[i] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      if (this.py[i] < 0.06 && this.bounce[i] > 0) {
        this.py[i] = 0.06;
        this.vy[i] *= -this.bounce[i];
        this.vx[i] *= 0.6; this.vz[i] *= 0.6;
      }
      const o = i * 3;
      this.pos[o] = this.px[i]; this.pos[o + 1] = this.py[i]; this.pos[o + 2] = this.pz[i];
      // Additive blending means dimming the colour *is* the fade.
      const f = t * t;
      this.col[o] = this.br[i] * f;
      this.col[o + 1] = this.bg[i] * f;
      this.col[o + 2] = this.bb[i] * f;
      this.siz[i] = this.sz[i] * (0.3 + t * 0.95);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ RINGS */

export class Rings {
  constructor(stage, cap = 128) {
    const geo = new THREE.RingGeometry(0.80, 1, 48);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 4;
    stage.scene.add(this.mesh);
    this.cap = cap;
    this.items = [];
    for (let i = 0; i < cap; i++) this.items.push({ alive: false, x: 0, z: 0, r0: 1, r1: 1, t: 0, life: 1, hex: 0xffffff, y: 0.06, ease: 1 });
    this.dummy = new THREE.Object3D();
  }
  add(x, z, r0, r1, life, hex, y = 0.06, ease = 1) {
    for (const it of this.items) {
      if (it.alive) continue;
      it.alive = true; it.x = x; it.z = z; it.r0 = r0; it.r1 = r1;
      it.t = 0; it.life = life; it.hex = hex; it.y = y; it.ease = ease;
      return it;
    }
    return null;
  }
  update(dt) {
    const d = this.dummy;
    let n = 0;
    for (const it of this.items) {
      if (!it.alive) continue;
      it.t += dt;
      const k = it.t / it.life;
      if (k >= 1) { it.alive = false; continue; }
      const e = it.ease === 1 ? k * k * (3 - 2 * k) : Math.pow(k, it.ease);
      const r = it.r0 + (it.r1 - it.r0) * e;
      d.position.set(it.x, it.y, it.z);
      d.rotation.set(0, 0, 0);
      d.scale.set(r, 1, r);
      d.updateMatrix();
      this.mesh.setMatrixAt(n, d.matrix);
      const a = 1 - k;
      this.mesh.setColorAt(n, TMPC.setHex(it.hex).multiplyScalar(a * a * 1.7));
      if (++n >= this.cap) break;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/* --------------------------------------------------------- TRAILS & BEAMS */

export class Quads {
  constructor(stage, cap = 320, flat = true) {
    const geo = new THREE.PlaneGeometry(1, 1);
    if (flat) geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      map: glowSprite(0xFFFFFF, 0.25), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 5;
    stage.scene.add(this.mesh);
    this.cap = cap;
    this.n = 0;
    this.dummy = new THREE.Object3D();
  }
  begin() { this.n = 0; }
  push(x, y, z, angle, len, wide, hex, bright) {
    if (this.n >= this.cap) return;
    const d = this.dummy;
    d.position.set(x, y, z);
    d.rotation.set(0, -angle, 0);
    d.scale.set(len, 1, wide);
    d.updateMatrix();
    this.mesh.setMatrixAt(this.n, d.matrix);
    this.mesh.setColorAt(this.n, TMPC.setHex(hex).multiplyScalar(bright));
    this.n++;
  }
  /** Segment between two world points — used by chain lightning and rails. */
  segment(ax, az, bx, bz, y, wide, hex, bright) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    this.push((ax + bx) / 2, y, (az + bz) / 2, Math.atan2(dz, dx), len, wide, hex, bright);
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/* --------------------------------------------------------- DAMAGE NUMBERS */

export class DamageNumbers {
  constructor(layer, camera, max = T.vfx.maxDamageNumbers) {
    this.layer = layer;
    this.camera = camera;
    this.pool = [];
    for (let i = 0; i < max; i++) {
      const el = document.createElement('div');
      el.className = 'dmg';
      el.style.opacity = '0';
      layer.appendChild(el);
      this.pool.push({ el, t: 0, life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, shown: false });
    }
    this.v = new THREE.Vector3();
  }
  add(x, y, z, value, kind) {
    for (const p of this.pool) {
      if (p.life > 0) continue;
      p.el.textContent = kind === 'heal' ? '+' + value : String(value);
      p.el.className = 'dmg' + (kind ? ' ' + kind : '');
      p.x = x; p.y = y; p.z = z;
      p.t = 0;
      p.life = kind === 'crit' ? 0.95 : kind === 'armor' ? 0.8 : 0.7;
      p.vx = (Math.random() - 0.5) * 76;
      p.vy = -120 - Math.random() * 40;
      return;
    }
  }
  update(dt) {
    const w = window.innerWidth, h = window.innerHeight;
    for (const p of this.pool) {
      if (p.life <= 0) {
        if (p.shown) { p.el.style.opacity = '0'; p.shown = false; }
        continue;
      }
      p.t += dt; p.life -= dt;
      p.vy += 320 * dt;
      this.v.set(p.x, p.y, p.z).project(this.camera);
      if (this.v.z > 1) { p.life = 0; continue; }
      const sx = (this.v.x * 0.5 + 0.5) * w + p.vx * p.t;
      const sy = (-this.v.y * 0.5 + 0.5) * h + p.vy * p.t + 160 * p.t * p.t;
      const pop = 1 + Math.max(0, 0.25 - p.t) * 2.2;
      p.el.style.transform = `translate(${sx | 0}px,${sy | 0}px) scale(${pop.toFixed(2)})`;
      p.el.style.opacity = String(Math.min(1, p.life * 3.2));
      p.shown = true;
    }
  }
}

const TMPC = new THREE.Color();
