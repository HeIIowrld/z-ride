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

/* ========================= SKINNED CHARACTERS ===========================

   Players, elites and bosses are real skinned meshes on a real skeleton, and
   every one of them — geometry, rig and motion — is generated in code.

   Two decisions worth explaining, because they are the reason this looks
   better than a downloaded model would on a phone:

   1. NO ANIMATION CLIPS. There is no run.fbx to blend into a strafe.fbx.
      Bone rotations are computed each frame from the character's actual
      state: real velocity drives stride length and cadence, the aim angle
      twists the torso independently of the hips, firing kicks the arms
      through a spring, and taking a hit adds an impulse that decays.
      Clip-based animation has to *blend toward* what the character is doing.
      This is what the character is doing, so it can never desync, never pops
      at a blend boundary, and never plays a run cycle while standing still.

   2. RIGID SKINNING WITH SOFT JOINTS. Each vertex belongs mostly to one bone,
      with a blend band near the joint. That is enough for a stylised, faceted
      figure, and it means no weight painting and no skin solver — the whole
      character is a few hundred triangles that deform correctly.

   Result: a fully articulated fighter costs about 700 triangles and zero
   bytes of download.                                                        */

import * as THREE from 'three';

const BONE_SPEC = [
  // name,        parent,      offset (from parent, in bind pose)
  ['root', null, [0, 0, 0]],
  ['hips', 'root', [0, 0.92, 0]],
  ['spine', 'hips', [0, 0.24, 0]],
  ['chest', 'spine', [0, 0.26, 0]],
  ['neck', 'chest', [0, 0.20, 0]],
  ['head', 'neck', [0, 0.14, 0]],
  ['shoulderL', 'chest', [0.20, 0.12, 0]],
  ['armL', 'shoulderL', [0.14, 0, 0]],
  ['foreL', 'armL', [0.28, 0, 0]],
  ['handL', 'foreL', [0.24, 0, 0]],
  ['shoulderR', 'chest', [-0.20, 0.12, 0]],
  ['armR', 'shoulderR', [-0.14, 0, 0]],
  ['foreR', 'armR', [-0.28, 0, 0]],
  ['handR', 'foreR', [-0.24, 0, 0]],
  ['thighL', 'hips', [0.13, -0.06, 0]],
  ['shinL', 'thighL', [0, -0.42, 0]],
  ['footL', 'shinL', [0, -0.40, 0]],
  ['thighR', 'hips', [-0.13, -0.06, 0]],
  ['shinR', 'thighR', [0, -0.42, 0]],
  ['footR', 'shinR', [0, -0.40, 0]]
];

/* Segment geometry: which bone owns which limb, and its shape. */
const SEGMENTS = [
  { bone: 'hips', shape: 'box', size: [0.40, 0.26, 0.26], offset: [0, 0.10, 0] },
  { bone: 'spine', shape: 'box', size: [0.38, 0.28, 0.25], offset: [0, 0.13, 0] },
  { bone: 'chest', shape: 'box', size: [0.46, 0.30, 0.28], offset: [0, 0.12, 0.01] },
  { bone: 'head', shape: 'ico', size: [0.17], offset: [0, 0.10, 0.01] },
  { bone: 'shoulderL', shape: 'ico', size: [0.11], offset: [0.06, 0, 0] },
  { bone: 'armL', shape: 'cap', size: [0.070, 0.24], offset: [0.14, 0, 0], axis: 'x' },
  { bone: 'foreL', shape: 'cap', size: [0.060, 0.20], offset: [0.12, 0, 0], axis: 'x' },
  { bone: 'handL', shape: 'box', size: [0.13, 0.10, 0.10], offset: [0.06, 0, 0] },
  { bone: 'shoulderR', shape: 'ico', size: [0.11], offset: [-0.06, 0, 0] },
  { bone: 'armR', shape: 'cap', size: [0.070, 0.24], offset: [-0.14, 0, 0], axis: 'x' },
  { bone: 'foreR', shape: 'cap', size: [0.060, 0.20], offset: [-0.12, 0, 0], axis: 'x' },
  { bone: 'handR', shape: 'box', size: [0.13, 0.10, 0.10], offset: [-0.06, 0, 0] },
  { bone: 'thighL', shape: 'cap', size: [0.090, 0.34], offset: [0, -0.20, 0], axis: 'y' },
  { bone: 'shinL', shape: 'cap', size: [0.075, 0.32], offset: [0, -0.19, 0], axis: 'y' },
  { bone: 'footL', shape: 'box', size: [0.13, 0.09, 0.26], offset: [0, -0.05, 0.06] },
  { bone: 'thighR', shape: 'cap', size: [0.090, 0.34], offset: [0, -0.20, 0], axis: 'y' },
  { bone: 'shinR', shape: 'cap', size: [0.075, 0.32], offset: [0, -0.19, 0], axis: 'y' },
  { bone: 'footR', shape: 'box', size: [0.13, 0.09, 0.26], offset: [0, -0.05, 0.06] }
];

function segmentGeometry(seg) {
  let g;
  if (seg.shape === 'box') g = new THREE.BoxGeometry(seg.size[0], seg.size[1], seg.size[2], 1, 1, 1);
  else if (seg.shape === 'ico') g = new THREE.IcosahedronGeometry(seg.size[0], 1);
  else {
    g = new THREE.CapsuleGeometry(seg.size[0], seg.size[1], 3, 8);
    if (seg.axis === 'x') g.rotateZ(Math.PI / 2);
  }
  g.translate(seg.offset[0], seg.offset[1], seg.offset[2]);
  return g;
}

/** Build the bind-pose skeleton and a single merged skinned geometry. */
export function buildHumanoid(opts = {}) {
  // 1.25 rather than 1: at this camera distance a strictly human-scaled figure
  // is about forty pixels tall on a phone, which is not enough silhouette to
  // read facing from. Characters are deliberately a head taller than realism.
  const scale = opts.scale || 1.25;
  const bones = {};
  const boneList = [];

  for (const [name, parent, off] of BONE_SPEC) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(off[0] * scale, off[1] * scale, off[2] * scale);
    bones[name] = b;
    boneList.push(b);
    if (parent) bones[parent].add(b);
  }
  const skeleton = new THREE.Skeleton(boneList);
  const index = Object.fromEntries(boneList.map((b, i) => [b.name, i]));

  // Bind-pose world positions, needed to place each segment's vertices in the
  // skeleton's space before skinning takes over.
  bones.root.updateMatrixWorld(true);
  const worldOf = {};
  for (const b of boneList) worldOf[b.name] = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);

  const positions = [], normals = [], skinIndices = [], skinWeights = [], uvs = [], colors = [];
  const tmp = new THREE.Vector3();
  const palette = opts.palette || defaultPalette();

  for (const seg of SEGMENTS) {
    const g = segmentGeometry({ ...seg, size: seg.size.map(v => v * scale), offset: seg.offset.map(v => v * scale) });
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    const origin = worldOf[seg.bone];
    const bi = index[seg.bone];
    const parentName = BONE_SPEC.find(s => s[0] === seg.bone)[1];
    const pi = parentName ? index[parentName] : bi;
    const col = segColor(seg.bone, palette);

    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i);
      // Soft joint: vertices close to the parent joint share weight with the
      // parent bone, so an elbow creases instead of scissoring apart.
      const distToJoint = tmp.length();
      const band = 0.11 * scale;
      const w = THREE.MathUtils.clamp(distToJoint / band, 0, 1);
      const wSelf = 0.5 + w * 0.5;

      positions.push(tmp.x + origin.x, tmp.y + origin.y, tmp.z + origin.z);
      normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      skinIndices.push(bi, pi, 0, 0);
      skinWeights.push(wSelf, 1 - wSelf, 0, 0);
      uvs.push(0.5, 0.5);
      colors.push(col.r, col.g, col.b);
    }
    g.dispose();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geo.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.55,
    metalness: 0.35,
    emissive: new THREE.Color(opts.emissive ?? 0x000000),
    emissiveIntensity: opts.emissiveIntensity ?? 0
  });

  const mesh = new THREE.SkinnedMesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = false;     // self-shadowing on a 700-tri figure is all artifact
  mesh.frustumCulled = false;
  mesh.add(bones.root);
  mesh.bind(skeleton);

  return { mesh, skeleton, bones, material };
}

function defaultPalette() {
  return {
    suit: new THREE.Color(0xE8EDF0),
    armor: new THREE.Color(0x39485A),
    accent: new THREE.Color(0xFFB53D),
    dark: new THREE.Color(0x1D2730)
  };
}

function segColor(bone, p) {
  if (bone === 'head' || bone.startsWith('hand')) return p.skin || p.accent;
  if (bone.startsWith('chest') || bone.startsWith('spine')) return p.armor;
  if (bone.startsWith('hand') || bone.startsWith('foot')) return p.dark;
  if (bone.startsWith('shoulder')) return p.armor;
  return p.suit;
}

/* ========================== PROCEDURAL ANIMATOR =========================

   State in, bone rotations out. Called once per frame per visible character.
   Roughly 40 microseconds each, so eight players and a boss cost nothing.   */

const T2 = Math.PI * 2;

export class Animator {
  constructor(bones, opts = {}) {
    this.b = bones;
    this.phase = 0;          // gait cycle, 0..1
    this.speed = 0;          // smoothed ground speed
    this.lean = 0;
    this.turn = 0;
    this.recoil = 0;
    this.hit = 0;
    this.hitDir = 0;
    this.breathe = Math.random() * T2;
    this.dashT = 0;
    this.deathT = 0;
    this.downT = 0;
    this.aimPitch = 0;
    this.stride = opts.stride || 1;
    this.cadence = opts.cadence || 1;
    this._lastFootL = 0;
    this._lastFootR = 0;
    this.onFootstep = opts.onFootstep || null;
  }

  kick(amount) { this.recoil = Math.min(1.6, this.recoil + amount); }
  impulse(dirAngle, amount) { this.hit = Math.min(1, this.hit + amount); this.hitDir = dirAngle; }

  /**
   * @param dt        seconds
   * @param s.vx,s.vz world velocity
   * @param s.faceA   body facing (radians)
   * @param s.aimA    aim direction (radians)
   * @param s.dashing bool
   * @param s.down    bool  — crawling, downed
   * @param s.dead    bool
   */
  update(dt, s) {
    const b = this.b;
    const speed = Math.hypot(s.vx || 0, s.vz || 0);
    this.speed += (speed - this.speed) * Math.min(1, dt * 12);
    this.breathe += dt * 1.6;
    this.recoil = Math.max(0, this.recoil - dt * 6.5);
    this.hit = Math.max(0, this.hit - dt * 3.2);
    this.dashT = Math.max(0, this.dashT - dt * 5);
    if (s.dashing) this.dashT = 1;
    this.deathT = s.dead ? Math.min(1, this.deathT + dt * 3) : Math.max(0, this.deathT - dt * 4);
    this.downT = s.down ? Math.min(1, this.downT + dt * 4) : Math.max(0, this.downT - dt * 4);

    // --- gait ---------------------------------------------------------
    // Cadence rises with speed but sub-linearly, the way real running does:
    // you lengthen your stride before you increase your step rate.
    const norm = Math.min(1, this.speed / 14.2);
    const cadence = (1.4 + norm * 2.4) * this.cadence;
    this.phase = (this.phase + dt * cadence) % 1;
    const stride = norm * 0.95 * this.stride;
    const p = this.phase * T2;

    // Which direction the legs are actually travelling relative to the body.
    // This is what makes strafing look like strafing rather than like running
    // sideways with forward-facing legs.
    const moveA = Math.atan2(s.vz || 0, s.vx || 0);
    const rel = wrap(moveA - (s.faceA || 0));
    const fwd = Math.cos(rel), side = Math.sin(rel);

    const swingL = Math.sin(p) * stride;
    const swingR = Math.sin(p + Math.PI) * stride;
    const liftL = Math.max(0, Math.sin(p + 0.6)) * stride;
    const liftR = Math.max(0, Math.sin(p + 0.6 + Math.PI)) * stride;

    b.thighL.rotation.x = swingL * 0.95 * fwd - liftL * 0.35;
    b.thighR.rotation.x = swingR * 0.95 * fwd - liftR * 0.35;
    b.thighL.rotation.z = -side * stride * 0.55 - 0.04;
    b.thighR.rotation.z = -side * stride * 0.55 + 0.04;
    // Knees only bend one way. Clamping at zero is what stops the classic
    // procedural-walk failure where a leg folds backwards.
    b.shinL.rotation.x = Math.max(0, -swingL * 1.5 + liftL * 1.35);
    b.shinR.rotation.x = Math.max(0, -swingR * 1.5 + liftR * 1.35);
    b.footL.rotation.x = -b.shinL.rotation.x * 0.45 + swingL * 0.25;
    b.footR.rotation.x = -b.shinR.rotation.x * 0.45 + swingR * 0.25;

    // Footstep callbacks fire on the down-stroke, not on a timer, so the
    // sound is always exactly on the contact.
    if (this.onFootstep && norm > 0.15) {
      const fl = Math.sin(p), fr = Math.sin(p + Math.PI);
      if (this._lastFootL > 0 && fl <= 0) this.onFootstep(0, norm);
      if (this._lastFootR > 0 && fr <= 0) this.onFootstep(1, norm);
      this._lastFootL = fl; this._lastFootR = fr;
    }

    // Vertical bob and pelvis roll, both driven by the same phase so they
    // agree with the feet.
    const bob = Math.abs(Math.sin(p)) * stride * 0.09;
    b.hips.position.y = 0.92 - bob - this.downT * 0.55 - this.deathT * 0.7;
    b.hips.rotation.z = Math.sin(p) * stride * 0.06;
    b.hips.rotation.y = -side * stride * 0.22;

    // --- torso: aims independently of the hips -------------------------
    const twist = wrap((s.aimA || 0) - (s.faceA || 0));
    const lean = norm * 0.14 + this.dashT * 0.22;
    this.lean += (lean - this.lean) * Math.min(1, dt * 10);

    b.spine.rotation.y = twist * 0.35;
    b.spine.rotation.x = this.lean * 0.6 + this.downT * 0.9 + this.deathT * 0.5;
    b.chest.rotation.y = twist * 0.45;
    b.chest.rotation.x = this.lean * 0.4 - this.recoil * 0.10 + Math.sin(this.breathe) * 0.012;
    b.chest.rotation.z = -side * stride * 0.10 + this.hit * Math.sin(this.hitDir) * 0.25;
    b.neck.rotation.y = twist * 0.20;
    b.head.rotation.x = -this.lean * 0.5 + this.aimPitch * 0.4 + this.deathT * 0.6;
    b.head.rotation.y = twist * 0.15;

    // --- arms: a two-handed weapon hold that tracks the aim ------------
    // The right hand holds the grip, the left supports the fore-end. Both
    // arms are posed from the same target so the weapon never floats.
    const aimUp = this.aimPitch;
    const ready = 1;
    b.shoulderR.rotation.z = -0.20;
    b.armR.rotation.z = -1.10 * ready + this.recoil * 0.32;
    b.armR.rotation.y = -0.45 - twist * 0.10;
    b.armR.rotation.x = -0.30 + aimUp * 0.5 + this.recoil * 0.30;
    b.foreR.rotation.z = -0.55 + this.recoil * 0.55;
    b.foreR.rotation.y = 0.30;
    b.handR.rotation.z = 0.15;

    b.shoulderL.rotation.z = 0.20;
    b.armL.rotation.z = 1.05 * ready - this.recoil * 0.18;
    b.armL.rotation.y = 0.62 - twist * 0.10;
    b.armL.rotation.x = -0.34 + aimUp * 0.5 + this.recoil * 0.16;
    b.foreL.rotation.z = 0.72 - this.recoil * 0.30;
    b.foreL.rotation.y = -0.40;
    b.handL.rotation.z = -0.12;

    // Idle sway. Without it a stationary character reads as paused.
    if (norm < 0.05) {
      const s2 = Math.sin(this.breathe * 0.8) * 0.02;
      b.chest.rotation.z += s2;
      b.hips.rotation.z += s2 * 0.5;
      b.armR.rotation.x += s2 * 0.4;
      b.armL.rotation.x -= s2 * 0.4;
    }

    // Death: fold at the waist and drop. Not a ragdoll — a ragdoll needs a
    // solver and looks worse than a good scripted collapse at this scale.
    if (this.deathT > 0.01) {
      const d = this.deathT;
      b.hips.rotation.x = d * 1.2;
      b.spine.rotation.x += d * 0.7;
      b.thighL.rotation.x += d * 1.1;
      b.thighR.rotation.x += d * 0.9;
      b.shinL.rotation.x += d * 1.5;
      b.shinR.rotation.x += d * 1.3;
      b.armR.rotation.z += d * 0.9;
      b.armL.rotation.z -= d * 0.9;
    }

    // Downed: on one knee, weapon lowered, still trying.
    if (this.downT > 0.01) {
      const d = this.downT;
      b.thighL.rotation.x = -1.4 * d;
      b.shinL.rotation.x = 2.1 * d;
      b.thighR.rotation.x = 0.5 * d;
      b.shinR.rotation.x = 0.9 * d;
      b.armR.rotation.z = -0.4 * d + b.armR.rotation.z * (1 - d);
      b.armL.rotation.z = 0.4 * d + b.armL.rotation.z * (1 - d);
    }
  }
}

function wrap(a) {
  a %= T2;
  if (a > Math.PI) a -= T2;
  if (a < -Math.PI) a += T2;
  return a;
}

/* ============================== WEAPON MESH ============================ */

/** A stylised weapon that reads at a distance. Attached to the right hand
 *  bone so it inherits every bit of arm motion for free. */
export function buildWeapon(kind = 'smg') {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x1E2830, roughness: 0.42, metalness: 0.75 });
  const light = new THREE.MeshStandardMaterial({ color: 0x5B6C78, roughness: 0.5, metalness: 0.6 });
  const hot = new THREE.MeshStandardMaterial({ color: 0x22292F, roughness: 0.35, metalness: 0.8, emissive: 0xFFB53D, emissiveIntensity: 0.5 });

  /* Silhouettes are designed for the camera that actually exists.

     The rig looks down at roughly 56 degrees from 26 metres. From up there a
     weapon is a shape on the ground plane, and its side profile — where all
     the character of a gun normally lives — is almost entirely edge-on and
     invisible. Six weapons built as three stacked boxes with different
     proportions therefore all read as the same short grey smudge, which is
     exactly what they were.

     So each weapon gets one element that is distinctive in PLAN view: a drum
     that sticks out sideways, a pair of rails, a fat cylinder, a hoop. Cheap
     geometry, but you can tell what you are holding at a glance, and that is
     the entire job. */
  const box = (w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    return m;
  };
  const cyl = (r, len, mat, x, y, z, axis = 'z') => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    if (axis === 'x') m.rotation.z = Math.PI / 2;
    m.position.set(x, y, z);
    return m;
  };

  const parts = [];
  // Every weapon shares a receiver and a grip, so the hand always looks right.
  parts.push(box(0.09, 0.11, 0.46, dark, 0, 0, 0.18));
  parts.push(box(0.07, 0.16, 0.10, dark, 0, -0.10, 0.04));

  if (kind === 'shotgun') {
    // Drum magazine, offset sideways — the one shape unmistakable from above.
    parts.push(cyl(0.15, 0.09, light, 0.10, 0, 0.20, 'x'));
    parts.push(cyl(0.055, 0.46, dark, 0, 0, 0.62));
    parts.push(box(0.12, 0.04, 0.30, light, 0, 0.06, 0.52));
  } else if (kind === 'rail') {
    // Two long parallel rails with the gap between them lit: reads as a line.
    parts.push(box(0.028, 0.05, 0.86, light, -0.052, 0.02, 0.62));
    parts.push(box(0.028, 0.05, 0.86, light, 0.052, 0.02, 0.62));
    parts.push(box(0.055, 0.035, 0.80, hot, 0, 0.02, 0.60));
    parts.push(cyl(0.10, 0.07, dark, 0, 0, 0.26, 'x'));
  } else if (kind === 'arc') {
    // An open hoop at the muzzle. A ring in plan view is unlike anything else.
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.028, 7, 16), hot);
    ring.position.set(0, 0.01, 0.60);
    parts.push(ring);
    parts.push(cyl(0.04, 0.34, light, 0, 0, 0.44));
  } else if (kind === 'beam') {
    // Fat emitter with two cooling fins fanned out to either side.
    parts.push(cyl(0.085, 0.36, light, 0, 0, 0.52));
    parts.push(box(0.20, 0.02, 0.16, dark, 0, 0.05, 0.40));
    parts.push(cyl(0.055, 0.10, hot, 0, 0, 0.72));
  } else if (kind === 'launcher') {
    // Wide tube, visibly the biggest footprint of the six.
    parts.push(cyl(0.125, 0.62, light, 0, 0.02, 0.44));
    parts.push(cyl(0.135, 0.06, dark, 0, 0.02, 0.72));
    parts.push(box(0.05, 0.13, 0.16, dark, 0, 0.12, 0.26));
  } else {
    // SMG: compact, with a magazine forward of the grip and a stubby barrel.
    parts.push(cyl(0.035, 0.34, light, 0, 0, 0.52));
    parts.push(box(0.055, 0.20, 0.09, light, 0, -0.11, 0.22));
    parts.push(box(0.10, 0.03, 0.22, dark, 0, 0.06, 0.24));
  }

  for (const m of parts) { m.castShadow = true; g.add(m); }

  // Muzzle marker: everything that needs to spawn at the barrel reads this.
  const muzzle = new THREE.Object3D();
  // Matched to where each barrel above actually ends, so the flash and the
  // tracer leave the weapon rather than the middle of it.
  const MUZZLE = { smg: 0.70, shotgun: 0.86, rail: 1.06, arc: 0.74, beam: 0.78, launcher: 0.76 };
  const len = MUZZLE[kind] ?? 0.70;
  muzzle.position.set(0, 0, len);
  g.add(muzzle);
  g.userData.muzzle = muzzle;

  // Held in the right hand, pointing along the arm.
  g.rotation.set(0, -Math.PI / 2, 0);
  g.position.set(0.10, -0.02, 0);
  return g;
}
