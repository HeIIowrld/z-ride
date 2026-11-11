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

/* ================================ CAMERA ================================

   The old camera sat at a fixed height and looked straight down a fixed line.
   It was legible and completely inert.

   This one is a rig with four independent inputs, all of which are gameplay:

     • pitch     lies down as you move fast, so speed is something you see
     • distance  pulls back when you are surrounded, so being swarmed stays
                 readable — a mechanic, not a bug
     • shoulder  offsets laterally toward your aim, giving you more of the
                 screen in the direction you care about
     • impulse   directional shake with a real spring, so a shotgun blast
                 pushes the frame away from the muzzle instead of jittering
                 it uniformly

   Everything is critically damped and frame-rate independent. The camera
   should never be the reason a frame feels late.                            */

import * as THREE from 'three';
import { T } from '@overrun/shared/constants.js';
import { clamp, damp, lerp } from '@overrun/shared/math.js';

export class CameraRig {
  constructor(camera) {
    this.cam = camera;
    this.x = 0; this.z = 0;
    this.pitch = T.camera.pitch;
    this.dist = T.camera.distance;
    this.fov = T.camera.fov;

    this.targetPitch = this.pitch;
    this.targetDist = this.dist;

    // Shake as a spring rather than a decaying sine: an impulse has direction
    // and the frame recoils then settles, which reads as force.
    this.shake = new THREE.Vector3();
    this.shakeVel = new THREE.Vector3();
    this.trauma = 0;

    this.fovKick = 0;
    this.roll = 0;
    this.userYaw = 0;          // player-adjustable orbit, remembered per session
    this.lookAt = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this.shakeScale = 1;
  }

  /** Directional kick. `angle` is the world direction the force came FROM. */
  impulse(angle, amount) {
    const a = amount * this.shakeScale;
    this.shakeVel.x -= Math.cos(angle) * a * 9;
    this.shakeVel.z -= Math.sin(angle) * a * 9;
    this.shakeVel.y += a * 3.5;
    this.trauma = Math.min(T.feel.shakeMax, this.trauma + a * 0.5);
  }

  /** Undirected rumble, for things with no obvious source. */
  rumble(amount) {
    this.trauma = Math.min(T.feel.shakeMax, this.trauma + amount * this.shakeScale);
  }

  kickFov(v) { this.fovKick = Math.max(this.fovKick, v); }

  /**
   * @param s.x,s.z    the point to follow (already interpolated)
   * @param s.aimA     aim direction
   * @param s.speed    current ground speed
   * @param s.density  0..1, how surrounded the player is
   * @param s.zoom     extra multiplier, used by the scoreboard and death cam
   */
  update(dt, s) {
    // --- distance: base + crowding + speed ---------------------------
    const crowd = clamp(s.density || 0, 0, 1);
    const speedN = clamp((s.speed || 0) / T.player.speed, 0, 1);
    this.targetDist = T.camera.distance
      * (1 + crowd * T.camera.densityPull + speedN * 0.06)
      * (s.zoom || 1);
    this.targetDist = clamp(this.targetDist, T.camera.minDist, T.camera.maxDist);
    this.dist = damp(this.dist, this.targetDist, 1.9, dt);

    // --- pitch: lies down at speed, stands up when crowded ------------
    this.targetPitch = T.camera.pitch - speedN * T.camera.pitchRelax + crowd * 0.10;
    this.targetPitch = clamp(this.targetPitch, T.camera.minPitch, T.camera.maxPitch);
    this.pitch = damp(this.pitch, this.targetPitch, 2.4, dt);

    // --- planar target: follow + aim lead + shoulder ------------------
    const lead = T.camera.aimLead * this.dist * 0.5;
    const shoulder = T.camera.shoulder;
    const ax = Math.cos(s.aimA || 0), az = Math.sin(s.aimA || 0);
    const tx = s.x + ax * lead - az * shoulder;
    const tz = s.z + az * lead + ax * shoulder;
    this.x = damp(this.x, tx, T.camera.follow, dt);
    this.z = damp(this.z, tz, T.camera.follow, dt);

    // --- shake spring -------------------------------------------------
    // Stiffness 260, damping 26: a single overshoot then still. Any less
    // damping and a burst weapon turns the screen into a blender.
    const k = 260, c = 26;
    this.shakeVel.addScaledVector(this.shake, -k * dt);
    this.shakeVel.multiplyScalar(Math.max(0, 1 - c * dt));
    this.shake.addScaledVector(this.shakeVel, dt);

    this.trauma = Math.max(0, this.trauma - T.feel.shakeDecay * dt);
    const t2 = this.trauma * this.trauma;
    const now = performance.now() * 0.001;
    const nx = Math.sin(now * 47.3) * t2 * 0.9 * this.shakeScale;
    const ny = Math.sin(now * 61.7 + 2.1) * t2 * 0.7 * this.shakeScale;
    this.roll = damp(this.roll, Math.sin(now * 39.1) * t2 * 0.035 * this.shakeScale, 14, dt);

    // --- place the camera --------------------------------------------
    const yaw = this.userYaw;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const dirX = Math.sin(yaw) * cp;
    const dirZ = Math.cos(yaw) * cp;

    // Spherical placement: pitch sets the height, yaw lets the player orbit,
    // and distance is measured along the view ray so the two stay independent.
    this.cam.position.set(
      this.x + this.shake.x + nx + dirX * this.dist,
      sp * this.dist + this.shake.y + ny + 1.0,
      this.z + this.shake.z + dirZ * this.dist
    );

    this.lookAt.set(this.x + this.shake.x * 0.5, 1.1, this.z + this.shake.z * 0.5);
    this.cam.lookAt(this.lookAt);
    this.cam.rotation.z += this.roll;

    // --- fov ----------------------------------------------------------
    this.fovKick = damp(this.fovKick, 0, 9, dt);
    const wantFov = T.camera.fov + this.fovKick * T.camera.fovKick + speedN * 2.2;
    if (Math.abs(this.cam.fov - wantFov) > 0.01) {
      this.cam.fov = lerp(this.cam.fov, wantFov, Math.min(1, dt * 14));
      this.cam.updateProjectionMatrix();
    }
  }

  /** Screen position of a world point, in CSS pixels. */
  project(x, y, z, out) {
    this._tmp.set(x, y, z).project(this.cam);
    out.x = (this._tmp.x * 0.5 + 0.5) * window.innerWidth;
    out.y = (-this._tmp.y * 0.5 + 0.5) * window.innerHeight;
    out.behind = this._tmp.z > 1;
    return out;
  }

  /** Ground point under a screen position — how a mouse aims.
   *  `out` may be any {x,y,z} holder, so callers outside the render layer do
   *  not have to import three just to read a coordinate. */
  screenToGround(sx, sy, out) {
    NDC.x = (sx / window.innerWidth) * 2 - 1;
    NDC.y = -(sy / window.innerHeight) * 2 + 1;
    RAY.setFromCamera(NDC, this.cam);
    if (!RAY.ray.intersectPlane(GROUND, HIT)) HIT.set(this.x, 0.9, this.z + 10);
    if (out) { out.x = HIT.x; out.y = HIT.y; out.z = HIT.z; return out; }
    return HIT;
  }
}

const NDC = new THREE.Vector2();
const RAY = new THREE.Raycaster();
const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.9);
const HIT = new THREE.Vector3();
