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

/* Pure math helpers. No DOM, no THREE — this file runs on the Cloudflare
   edge runtime as happily as it does in a browser. */

export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist2 = (ax, az, bx, bz) => {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
};
export const dist = (ax, az, bx, bz) => Math.sqrt(dist2(ax, az, bx, bz));

/** Frame-rate independent exponential smoothing. */
export const damp = (a, b, l, dt) => lerp(a, b, 1 - Math.exp(-l * dt));

/** Shortest signed angular difference, in (-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function dampAngle(a, b, l, dt) {
  return a + angleDelta(a, b) * (1 - Math.exp(-l * dt));
}

/** Smoothstep, the only easing the simulation is allowed to know about. */
export const smoothstep = (t) => t * t * (3 - 2 * t);

/** Distance from point (px,pz) to segment (ax,az)->(bx,bz), squared.
 *  This is how every bullet in the game decides whether it hit. */
export function segPointDist2(ax, az, bx, bz, px, pz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-9) return dist2(ax, az, px, pz);
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1);
  const cx = ax + dx * t - px, cz = az + dz * t - pz;
  return cx * cx + cz * cz;
}
