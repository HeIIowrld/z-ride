// Modified for Z-RIDE evening parking-lot grade.
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

/* ============================ RENDERER / STAGE ==========================

   The old arena was a dark room lit by two lamps. This one is an outdoor
   concrete yard under a physical sky, which changes three things that matter
   more than they sound:

     • Enemies read at a glance. A rose silhouette against pale concrete is
       legible at any zoom; the same silhouette against near-black was not.
     • Shadows do work. With a real sun and cascaded shadow maps, cover casts
       a shadow you can use to judge distance and height.
     • Bloom becomes a scalpel instead of a hammer. When the background is
       bright, only genuinely emissive things glow — so a glowing thing is
       always information.

   Quality is four tiers, chosen by a real frame-time measurement rather than
   by sniffing the user agent, and re-evaluated continuously. Resolution and
   post-processing go first; the enemy count never changes, because that would
   alter the game rather than its presentation.                              */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';

export const TIERS = ['floor', 'low', 'med', 'high', 'ultra'];

/* Quality tiers.

   `dpr` here is a CEILING, not a target — the real limit is the pixel budget
   below, because device pixel ratio on its own says nothing about how many
   pixels the GPU has to fill. A 720x1560 phone at dpr 1.35 is 2.1 megapixels
   through a bloom chain, which a Mali-G71 MP2 will not do at any framerate
   worth having.

   'floor' exists because 'low' was not low. It is the tier for GPUs that
   cannot afford a second full-screen pass at all. */
const TIER_SPEC = {
  floor: { dpr: 0.75, shadows: false, shadowSize: 0,    bloom: false, aa: false, sunIntensity: 2.7, fogMul: 1.2  },
  low:   { dpr: 1.0,  shadows: false, shadowSize: 512,  bloom: false, aa: false, sunIntensity: 2.6, fogMul: 1.15 },
  med:   { dpr: 1.35, shadows: true,  shadowSize: 1024, bloom: true,  aa: false, sunIntensity: 2.5, fogMul: 1.0 },
  high:  { dpr: 1.8,  shadows: true,  shadowSize: 2048, bloom: true,  aa: true,  sunIntensity: 2.5, fogMul: 0.9 },
  ultra: { dpr: 2.0,  shadows: true,  shadowSize: 4096, bloom: true,  aa: true,  sunIntensity: 2.5, fogMul: 0.85 }
};

/* How many pixels each tier is allowed to render, regardless of what the
   display would like. Fill rate is the currency on mobile: a mid-range phone
   with a 1080p panel and a two-core GPU is not a 1080p device.

   These are deliberately conservative. Upscaling a 900k-pixel image on a
   5.6-inch screen is very hard to see; 9fps is not. */
const PIXEL_BUDGET = {
  floor: 460000,
  low:   760000,
  med:   1300000,
  high:  2400000,
  ultra: 4200000
};

/* A tiny grade pass. Doing exposure, saturation, vignette and a damage tint
   in one fullscreen shader is cheaper than three passes and gives the game a
   single place to express "you are in trouble" without touching the HUD. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 1.0 },
    uSaturation: { value: 1.10 },
    uContrast: { value: 1.10 },
    uVignette: { value: 0.42 },
    uDamage: { value: 0.0 },
    uDamageDir: { value: new THREE.Vector2(0, 0) },
    uChroma: { value: 0.0 },
    uTime: { value: 0 },
    uLowHealth: { value: 0.0 }
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uExposure, uSaturation, uContrast, uVignette, uDamage, uChroma, uTime, uLowHealth;
    uniform vec2 uDamageDir;
    varying vec2 vUv;

    void main(){
      vec2 uv = vUv;
      vec2 c = uv - 0.5;

      // Chromatic aberration only fires on impact. Permanent CA is a look;
      // transient CA is a hit confirmation you feel before you read it.
      vec3 col;
      if (uChroma > 0.001) {
        float k = uChroma * 0.006;
        col.r = texture2D(tDiffuse, uv + c * k).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - c * k).b;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }

      col *= uExposure;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);
      col = (col - 0.5) * uContrast + 0.5;

      // Directional damage wash: the screen darkens from where you were hit,
      // so being surrounded stays readable.
      if (uDamage > 0.001) {
        float d = dot(normalize(c + 1e-5), uDamageDir);
        float band = smoothstep(0.1, 1.0, d) * uDamage;
        col = mix(col, vec3(0.85, 0.10, 0.26), band * 0.42);
      }

      // Low health: the frame itself starts breathing.
      if (uLowHealth > 0.001) {
        float pulse = 0.55 + sin(uTime * 6.5) * 0.25;
        float r = length(c) * 1.5;
        col = mix(col, vec3(0.72, 0.06, 0.20), smoothstep(0.35, 1.0, r) * uLowHealth * pulse * 0.55);
        col = mix(vec3(dot(col, vec3(0.299,0.587,0.114))), col, 1.0 - uLowHealth * 0.35);
      }

      float vig = smoothstep(0.95, 0.25, length(c) * 1.25);
      col *= mix(1.0, vig, uVignette);

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `
};

export class Stage {
  constructor(canvasEl, settings) {
    this.settings = settings;
    this.canvas = canvasEl;

    this.renderer = new THREE.WebGLRenderer({
      canvas: canvasEl,
      antialias: false,             // post-processing does AA; MSAA here would be paid twice
      powerPreference: 'high-performance',
      stencil: false,
      depth: true
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.78;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x9FC6E8, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 400);

    this.buildSky();
    this.buildLights();

    this.composer = null;
    this.bloom = null;
    this.grade = null;
    this.fxaa = null;

    this.tier = 'high';
    this.dpr = 1;
    this._samples = [];
    this._sampleT = 0;
    this._settleT = 0;
    this._time = 0;

    this.resize();
  }

  /* ------------------------------------------------------------------ SKY */

  buildSky() {
    // Mid-afternoon: the sun is high enough for short shadows and low enough
    // that props still cast something you can judge distance by.
    this.sunAngle = { elevation: 38, azimuth: 132 };
    this.sunDir = new THREE.Vector3().setFromSphericalCoords(
      1,
      THREE.MathUtils.degToRad(90 - this.sunAngle.elevation),
      THREE.MathUtils.degToRad(this.sunAngle.azimuth)
    );

    // The sky is a painted equirectangular texture rather than the scattering
    // shader, for two reasons that both showed up in testing:
    //
    //   • PMREM-from-a-scene is fragile. On a software rasteriser — and on
    //     more than a few real mobile drivers — pre-filtering a live scene
    //     produced an environment map that poisoned every physical material
    //     in the game to solid black. Pre-filtering a plain equirect texture
    //     is a much shorter, much better-supported path.
    //   • It is faster. One 1024x512 canvas beats a full atmospheric shader
    //     compile on a phone that is already compiling forty other programs.
    //
    // The gradient is hand-tuned to sit behind pale concrete without competing
    // with it: bright at the horizon, deeper overhead, warm near the sun.
    const equirect = skyTexture(this.sunDir);
    equirect.mapping = THREE.EquirectangularReflectionMapping;
    this.scene.background = new THREE.Color(0x273b35);
    this.skyTexture = equirect;

    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const rt = pmrem.fromEquirectangular(equirect);
      // Sanity-check before trusting it. A broken environment is worse than
      // no environment: it does not fail loudly, it just makes the game black.
      if (rt && rt.texture) {
        this.scene.environment = rt.texture;
        this.scene.environmentIntensity = 0.34;
        this.envRT = rt;
      }
      pmrem.dispose();
    } catch (e) {
      // No image-based lighting on this device. The three analytic lights
      // below are tuned to carry the scene on their own if this happens.
      console.warn('[stage] IBL unavailable, falling back to analytic lighting', e);
      this.scene.environment = null;
    }

    // A little aerial perspective so distance reads. Too subtle to notice
    // consciously, which is the point.
    this.scene.fog = new THREE.Fog(0x354c40, 95, 260);
  }

  /** Rebuild lighting without image-based ambient — used when IBL is absent
   *  or when the player forces the low tier on a weak GPU. */
  setIBL(on) {
    if (on && this.envRT) {
      this.scene.environment = this.envRT.texture;
      this.hemi.intensity = 1.25;
    } else {
      this.scene.environment = null;
      // Compensate: without IBL the sky/bounce term has to do all the ambient
      // work, so it goes up rather than the scene going flat.
      this.hemi.intensity = 1.9;
    }
    this.scene.traverse(o => { if (o.isMesh && o.material) markMaterials(o.material); });
  }

  buildLights() {
    // Key light. Warm, strong, and the only thing casting shadows.
    const sun = new THREE.DirectionalLight(0xFFF0D2, 2.5);
    sun.position.copy(this.sunDir).multiplyScalar(120);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 20;
    sun.shadow.camera.far = 260;
    const s = 62;
    sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
    sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.035;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    // Sky fill from above, bounce from the concrete below. Two hemisphere
    // terms are what stop the shadowed sides of things going flat grey.
    const hemi = new THREE.HemisphereLight(0xA8C8E8, 0x7A7568, 1.25);
    this.scene.add(hemi);
    this.hemi = hemi;

    // A cool rim from the opposite side keeps dark enemies from disappearing
    // into their own shadow when they cross a bright patch of floor.
    const rim = new THREE.DirectionalLight(0xA9D8F5, 0.62);
    rim.position.set(-60, 36, -48);
    this.scene.add(rim);
    this.rim = rim;
  }

  /* ------------------------------------------------------------ POST STACK */

  buildComposer() {
    if (this.composer) { this.composer.dispose(); this.composer = null; }
    const spec = TIER_SPEC[this.tier];
    if (!spec.bloom && !spec.aa) { this.grade = null; return; }

    const size = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size);

    const composer = new EffectComposer(this.renderer);
    composer.setPixelRatio(1);   // EffectComposer works in drawing-buffer space already
    composer.setSize(size.x, size.y);
    composer.addPass(new RenderPass(this.scene, this.camera));

    if (spec.bloom) {
      // Threshold sits above the brightest concrete so the floor never blooms.
      // Only emissive materials and additive VFX cross it.
      const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.55, 0.5, 1.05);
      composer.addPass(bloom);
      this.bloom = bloom;
    } else this.bloom = null;

    const grade = new ShaderPass(GradeShader);
    composer.addPass(grade);
    this.grade = grade;

    if (spec.aa) {
      const fx = new FXAAPass();
      composer.addPass(fx);
      this.fxaa = fx;
    } else this.fxaa = null;

    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  /* ---------------------------------------------------------------- QUALITY */

  /* The device pixel ratio this tier can actually afford.

     Capping on devicePixelRatio alone is the mistake that made this game
     unplayable on a 720x1560 phone: dpr there is 1.75, the medium tier
     allowed 1.35, and 1.35 of a 720x1560 viewport is 2.1 million pixels
     pushed through a bloom chain on a two-core GPU. The panel's density has
     no relationship to the fill rate behind it, so the budget is expressed
     in pixels and the ratio is derived from the viewport we actually have. */
  dprForTier(tier) {
    const spec = TIER_SPEC[tier];
    const want = Math.min(window.devicePixelRatio || 1, spec.dpr);
    const w = window.innerWidth || 1, h = window.innerHeight || 1;
    const budget = PIXEL_BUDGET[tier] || PIXEL_BUDGET.low;
    const px = w * h * want * want;
    if (px <= budget) return want;
    // Scale back to the budget, but never below the point where the image
    // stops being legible.
    return Math.max(0.55, Math.sqrt(budget / (w * h)));
  }

  applyTier(tier) {
    if (!TIER_SPEC[tier]) tier = 'high';
    this.tier = tier;
    const spec = TIER_SPEC[tier];

    this.dpr = this.dprForTier(tier);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.shadowMap.enabled = spec.shadows;
    this.sun.castShadow = spec.shadows;
    if (spec.shadows) this.sun.shadow.mapSize.set(spec.shadowSize, spec.shadowSize);
    this.sun.intensity = spec.sunIntensity;

    if (this.scene.fog) {
      this.scene.fog.near = 90 * spec.fogMul;
      this.scene.fog.far = 300 * spec.fogMul;
    }

    // Shadow maps that already exist keep their old size until disposed.
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    this.scene.traverse(o => { if (o.isMesh && o.material) markMaterials(o.material); });

    /* Tell the document how much GPU it is allowed to spend on chrome.

       The menus use backdrop-filter, which is the single most expensive thing
       a compositor can be asked for over changing content. The renderer has
       already worked out how weak this GPU is, so that answer should govern
       the material too rather than being rediscovered in CSS with a media
       query that cannot see a GPU at all. Measured on a Galaxy A30s: the
       results screen alone cost 16ms a frame at the full blur radius. */
    const weak = tier === 'floor' || tier === 'low';
    document.documentElement.classList.toggle('lowfx', weak);
    document.documentElement.classList.toggle('nofx', tier === 'floor');

    this.buildComposer();
    this.resize();
  }

  /** Continuous adaptation. Two things are worth knowing here:
   *  it only ever samples while actually rendering gameplay, and it settles
   *  for a second after a change so it does not chase its own tail. */
  sample(frameMs, dt) {
    if (this.settings.quality !== 'auto') return;
    if (this._settleT > 0) { this._settleT -= dt; this._samples.length = 0; return; }
    this._samples.push(frameMs);
    if (this._samples.length < 100) return;

    this._samples.sort((a, b) => a - b);
    // 90th percentile, not the mean: a game that averages 60fps but stutters
    // every second feels worse than one that runs at a steady 50.
    const p90 = this._samples[Math.floor(this._samples.length * 0.9)];
    this._samples.length = 0;
    this._settleT = 1.5;

    const i = TIERS.indexOf(this.tier);
    /* Drop hard, climb gently.

       Coming down a tier is cheap and the player is currently suffering, so
       one bad sample is enough. Going up risks oscillating between two tiers
       forever, which reads as the game breathing, so it needs real headroom
       and the current tier's resolution to already be paid for in full. */
    if (p90 > 21 && i > 0) this.applyTier(TIERS[i - 1]);
    else if (p90 > 24 && this.dpr > 0.56) {
      this.dpr = Math.max(0.55, this.dpr - 0.15);
      this.renderer.setPixelRatio(this.dpr);
      this.resize();
    } else if (p90 < 11.5 && i < TIERS.length - 1 && this.dpr >= this.dprForTier(this.tier) - 0.01) {
      this.applyTier(TIERS[i + 1]);
    }
  }

  /** One-shot benchmark used at boot to pick a starting tier without guessing
   *  from the user agent, which is wrong for every device released this year. */
  static guessTier() {
    const coarse = matchMedia('(pointer: coarse)').matches;
    const cores = navigator.hardwareConcurrency || 4;
    // deviceMemory is quantised to powers of two and rounded UP, so a 3.8GB
    // phone reports 4 — the same as a comfortable tablet. It is close to
    // useless as a capability signal on its own.
    const mem = navigator.deviceMemory || (coarse ? 4 : 8);

    /* Ask the GPU what it is. This is the one signal that actually correlates
       with fill rate, and it costs one throwaway context.

       The A30s that prompted this reports "Mali-G71 MP2": eight cores, 4GB by
       the rounded metric, and a GPU from 2016 with two shader cores. Every
       heuristic based on CPU and RAM put it on the medium tier, where it ran
       at nine frames a second. The renderer string knows better. */
    let gpu = '';
    try {
      const cv = document.createElement('canvas');
      const gl = cv.getContext('webgl2') || cv.getContext('webgl');
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        gpu = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || '');
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    } catch (e) { void e; }

    if (gpu) {
      // Known-weak mobile parts. Matching on family is deliberately coarse:
      // being one tier too low costs a little sharpness, being one too high
      // costs the entire game.
      if (/Mali-(4|T6|T7|T8|G3[01]|G5[12]|G7[12])|Adreno.*\b(3\d\d|4\d\d|50[05]|506|509|51[0-2])\b|PowerVR (SGX|GE)/i.test(gpu)) {
        return 'floor';
      }
      if (/Mali-G(5[67]|6\d|7[567])|Adreno.*\b(6[01]\d|62\d)\b/i.test(gpu)) return 'low';
      if (/SwiftShader|llvmpipe|Software/i.test(gpu)) return 'floor';
    }

    if (coarse && (mem <= 3 || cores <= 4)) return 'floor';
    if (coarse) return 'low';
    if (cores >= 8 && mem >= 8) return 'high';
    return 'med';
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      const size = new THREE.Vector2();
      this.renderer.getDrawingBufferSize(size);
      this.composer.setSize(size.x, size.y);
      if (this.bloom) this.bloom.resolution.set(size.x, size.y);
    }
  }

  /** Keep the shadow frustum tight around the player: a 4096 map spread over
   *  the whole arena is blurrier than a 1024 map spread over 60 metres. */
  followShadow(x, z) {
    this.sun.position.set(x + this.sunDir.x * 110, this.sunDir.y * 110, z + this.sunDir.z * 110);
    this.sun.target.position.set(x, 0, z);
    this.sun.target.updateMatrixWorld();
  }

  setGrade(o) {
    if (!this.grade) {
      // Without a composer the only knob available is exposure, so at least
      // the low tier still dims when you are dying.
      this.renderer.toneMappingExposure = 1.0 * (o.exposure ?? 1);
      return;
    }
    const u = this.grade.uniforms;
    u.uTime.value = this._time;
    if (o.exposure !== undefined) u.uExposure.value = o.exposure;
    if (o.damage !== undefined) u.uDamage.value = o.damage;
    if (o.damageDir) u.uDamageDir.value.set(o.damageDir.x, o.damageDir.y);
    if (o.chroma !== undefined) u.uChroma.value = o.chroma;
    if (o.lowHealth !== undefined) u.uLowHealth.value = o.lowHealth;
    if (o.saturation !== undefined) u.uSaturation.value = o.saturation;
  }

  render(dt) {
    this._time += dt;
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  get info() { return this.renderer.info; }
}


/* ------------------------------------------------------------------- SKY */

/** A painted equirectangular sky: horizon haze, zenith blue, a warm glow
 *  around the sun and a few soft cloud bands. 1024x512 is enough — it is
 *  never seen sharp, only as a backdrop and as pre-filtered ambient. */
function skyTexture(sunDir) {
  const W = 1024, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');

  // Vertical gradient: v=0 is straight up.
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0.00, '#2E6EA8');
  grad.addColorStop(0.30, '#5C9AD0');
  grad.addColorStop(0.48, '#9CC4E4');
  grad.addColorStop(0.52, '#D6E4EE');
  grad.addColorStop(0.62, '#C9C3B4');   // dusty ground haze below the horizon
  grad.addColorStop(1.00, '#8E8C7E');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  // Sun. Its screen position has to match the directional light or the
  // specular highlights will disagree with the backdrop.
  const theta = Math.atan2(sunDir.z, sunDir.x);
  const phi = Math.acos(THREE.MathUtils.clamp(sunDir.y, -1, 1));
  const sx = ((theta / (Math.PI * 2)) + 0.5) * W;
  const sy = (phi / Math.PI) * H;

  const glow = g.createRadialGradient(sx, sy, 0, sx, sy, W * 0.30);
  glow.addColorStop(0.00, 'rgba(255,250,232,1)');
  glow.addColorStop(0.03, 'rgba(255,240,205,0.92)');
  glow.addColorStop(0.16, 'rgba(255,226,178,0.30)');
  glow.addColorStop(1.00, 'rgba(255,226,178,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);

  // Cloud bands. Stretched horizontally and kept above the horizon so they
  // never look like they are lying on the floor.
  g.globalAlpha = 0.30;
  for (let i = 0; i < 26; i++) {
    const cy = H * (0.06 + Math.random() * 0.36);
    const cx = Math.random() * W;
    const rw = W * (0.05 + Math.random() * 0.13);
    const rh = H * (0.012 + Math.random() * 0.035);
    const cg = g.createRadialGradient(cx, cy, 0, cx, cy, rw);
    cg.addColorStop(0, 'rgba(255,255,255,0.95)');
    cg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = cg;
    g.save();
    g.translate(cx, cy); g.scale(1, rh / rw); g.translate(-cx, -cy);
    g.beginPath(); g.arc(cx, cy, rw, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  g.globalAlpha = 1;

  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function markMaterials(m) {
  if (Array.isArray(m)) { for (const x of m) x.needsUpdate = true; }
  else m.needsUpdate = true;
}
