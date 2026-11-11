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

/* ========================= PROCEDURAL TEXTURES =========================

   Every surface in OVERRUN is generated at runtime on a 2D canvas. That is a
   deliberate constraint, not a shortcut: it keeps the first-load payload under
   a megabyte, makes the game work with the network cut, and lets the APK ship
   without a single binary asset.

   The trick to making generated concrete look like concrete rather than like
   noise is layering at three different scales — large stains, medium pores,
   fine grit — and deriving the normal and roughness maps from the same height
   field so they agree with each other. Textures that disagree are what make
   procedural surfaces read as plastic. */

import * as THREE from 'three';

const cache = new Map();

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function toTexture(cv, { repeat = 1, srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/** Value noise with fractal octaves. Seeded, so a reload looks the same. */
function makeNoise(seed = 1) {
  const perm = new Uint8Array(512);
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  const grad = (h, x, y) => {
    const u = (h & 1) ? x : y;
    const v = (h & 2) ? x : y;
    return ((h & 4) ? -u : u) + ((h & 8) ? -v : v);
  };
  const noise2 = (x, y) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const A = perm[X] + Y, B = perm[X + 1] + Y;
    return lerp(
      lerp(grad(perm[A], x, y), grad(perm[B], x - 1, y), u),
      lerp(grad(perm[A + 1], x, y - 1), grad(perm[B + 1], x - 1, y - 1), u),
      v
    );
  };
  return (x, y, octaves = 4, persistence = 0.5) => {
    let total = 0, amp = 1, freq = 1, max = 0;
    for (let i = 0; i < octaves; i++) {
      total += noise2(x * freq, y * freq) * amp;
      max += amp;
      amp *= persistence;
      freq *= 2;
    }
    return total / max;
  };
}

/** Height field -> tangent-space normal map. Sobel, one pass, good enough. */
function heightToNormal(height, size, strength = 2.2) {
  const cv = canvas(size);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * strength;
      const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      img.data[o] = ((dx / len) * 0.5 + 0.5) * 255;
      img.data[o + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      img.data[o + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/* -------------------------------------------------------------- CONCRETE */

/** The arena floor: pale poured concrete with expansion joints, stains and a
 *  faint hazard grid. Bright enough that a rose-coloured enemy silhouette
 *  reads instantly, which is the whole reason the palette changed. */
export function concreteSet(size = 1024, opts = {}) {
  const key = 'concrete' + size + JSON.stringify(opts);
  if (cache.has(key)) return cache.get(key);

  const noise = makeNoise(opts.seed || 7);
  const base = opts.base || [148, 150, 146];
  const height = new Float32Array(size * size);

  const cv = canvas(size);
  const g = cv.getContext('2d');
  const img = g.createImageData(size, size);
  const rough = canvas(size);
  const rg = rough.getContext('2d');
  const rimg = rg.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // Three scales, as described above.
      const stain = noise(u * 3, v * 3, 3, 0.6);
      const pore = noise(u * 17, v * 17, 4, 0.55);
      const grit = noise(u * 90, v * 90, 2, 0.5);
      let h = stain * 0.5 + pore * 0.35 + grit * 0.15;

      // Expansion joints on a 4x4 grid: a real slab is poured in sections.
      const jx = Math.min(Math.abs((u * 4) % 1 - 0.5), 0.5) * 2;
      const jy = Math.min(Math.abs((v * 4) % 1 - 0.5), 0.5) * 2;
      const joint = Math.min(jx, jy);
      const inJoint = joint > 0.985 ? 1 : 0;
      if (inJoint) h -= 0.55;

      const shade = 1 + h * 0.16 - inJoint * 0.22;
      const o = (y * size + x) * 4;
      img.data[o] = base[0] * shade;
      img.data[o + 1] = base[1] * shade;
      img.data[o + 2] = base[2] * shade;
      img.data[o + 3] = 255;

      // Rougher where it is pitted, smoother where it is worn — concrete
      // polishes under traffic, and the eye reads that even when it cannot
      // name it.
      const r = 0.78 + pore * 0.14 - Math.max(0, stain) * 0.10 + inJoint * 0.1;
      const rv = Math.max(0, Math.min(1, r)) * 255;
      rimg.data[o] = rv; rimg.data[o + 1] = rv; rimg.data[o + 2] = rv; rimg.data[o + 3] = 255;

      height[y * size + x] = h;
    }
  }
  g.putImageData(img, 0, 0);
  rg.putImageData(rimg, 0, 0);

  // No arena markings baked in here. This texture tiles roughly a dozen times
  // across the floor, so anything with a centre — a circle, a logo, a line —
  // would repeat a dozen times too. Markings are a separate, non-tiling decal.

  const set = {
    map: toTexture(cv, { repeat: opts.repeat || 9 }),
    roughnessMap: toTexture(rough, { repeat: opts.repeat || 9, srgb: false }),
    normalMap: toTexture(heightToNormal(height, size, 2.6), { repeat: opts.repeat || 9, srgb: false })
  };
  cache.set(key, set);
  return set;
}

/* ----------------------------------------------------------- PAINTED STEEL */

/** Props and walls: painted steel with chipped edges and rust bleed. */
export function steelSet(size = 512, opts = {}) {
  const key = 'steel' + size + JSON.stringify(opts);
  if (cache.has(key)) return cache.get(key);

  const noise = makeNoise(opts.seed || 21);
  const base = opts.base || [104, 116, 124];
  const height = new Float32Array(size * size);

  const cv = canvas(size);
  const g = cv.getContext('2d');
  const img = g.createImageData(size, size);
  const rough = canvas(size);
  const rg = rough.getContext('2d');
  const rimg = rg.createImageData(size, size);
  const metal = canvas(size);
  const mg = metal.getContext('2d');
  const mimg = mg.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const brush = noise(u * 2, v * 64, 3, 0.5) * 0.5;   // anisotropic brushing
      const dirt = noise(u * 6, v * 6, 4, 0.6);
      const chip = noise(u * 30, v * 30, 3, 0.5);
      const chipped = chip > 0.34 ? 1 : 0;

      const h = brush * 0.4 + dirt * 0.4 + (chipped ? -0.3 : 0);
      const shade = 1 + h * 0.22;
      const o = (y * size + x) * 4;
      if (chipped) {
        // Exposed metal under the paint: warmer, much more reflective.
        img.data[o] = 150 * shade; img.data[o + 1] = 128 * shade; img.data[o + 2] = 106 * shade;
        mimg.data[o] = mimg.data[o + 1] = mimg.data[o + 2] = 230;
      } else {
        img.data[o] = base[0] * shade; img.data[o + 1] = base[1] * shade; img.data[o + 2] = base[2] * shade;
        mimg.data[o] = mimg.data[o + 1] = mimg.data[o + 2] = 40;
      }
      img.data[o + 3] = mimg.data[o + 3] = 255;

      const r = chipped ? 0.42 : 0.62 + dirt * 0.2;
      const rv = Math.max(0, Math.min(1, r)) * 255;
      rimg.data[o] = rv; rimg.data[o + 1] = rv; rimg.data[o + 2] = rv; rimg.data[o + 3] = 255;
      height[y * size + x] = h;
    }
  }
  g.putImageData(img, 0, 0);
  rg.putImageData(rimg, 0, 0);
  mg.putImageData(mimg, 0, 0);

  const rep = opts.repeat || 2;
  const set = {
    map: toTexture(cv, { repeat: rep }),
    roughnessMap: toTexture(rough, { repeat: rep, srgb: false }),
    metalnessMap: toTexture(metal, { repeat: rep, srgb: false }),
    normalMap: toTexture(heightToNormal(height, size, 1.8), { repeat: rep, srgb: false })
  };
  cache.set(key, set);
  return set;
}

/* ---------------------------------------------------------------- SPRITES */

/** Radial glow, used by every particle, muzzle flash and telegraph in the game. */
export function glowSprite(hex, softness = 0.35, size = 128) {
  const key = 'glow' + hex + softness + size;
  if (cache.has(key)) return cache.get(key);
  const cv = canvas(size);
  const g = cv.getContext('2d');
  const col = new THREE.Color(hex);
  const rgb = `${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)}`;
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, `rgba(${rgb},1)`);
  grd.addColorStop(softness, `rgba(${rgb},0.35)`);
  grd.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}

/** Soft elliptical contact shadow. Cheaper and more readable than a real
 *  shadow for small fast things, and it never flickers. */
export function blobShadow(size = 128) {
  const key = 'blob' + size;
  if (cache.has(key)) return cache.get(key);
  const cv = canvas(size);
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.24)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(cv);
  cache.set(key, t);
  return t;
}

/** Scorch decal left by explosions. Irregular, so repeats do not tile. */
export function scorchDecal(size = 128, seed = 3) {
  const key = 'scorch' + seed;
  if (cache.has(key)) return cache.get(key);
  const cv = canvas(size);
  const g = cv.getContext('2d');
  const noise = makeNoise(seed);
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x / size - 0.5) * 2, dy = (y / size - 0.5) * 2;
      const d = Math.hypot(dx, dy);
      const n = noise(x / size * 5, y / size * 5, 4, 0.6) * 0.35;
      const a = Math.max(0, 1 - (d + n) * 1.15);
      const o = (y * size + x) * 4;
      img.data[o] = 30; img.data[o + 1] = 26; img.data[o + 2] = 24;
      img.data[o + 3] = a * a * 210;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  cache.set(key, t);
  return t;
}

export function disposeTextureCache() {
  for (const v of cache.values()) {
    if (v.dispose) v.dispose();
    else for (const k in v) v[k].dispose && v[k].dispose();
  }
  cache.clear();
}
