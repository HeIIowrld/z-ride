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

/* Seeded PRNG.

   The single most important file for multiplayer. Every random decision the
   simulation makes — spawn position, arena layout, spread, personality jitter —
   must be reproducible from a seed, or the server and a reconnecting client
   will not agree on what the world looks like.

   mulberry32: 32-bit state, excellent distribution, ~2ns per call. */

export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9E3779B9;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    /** float in [0,1) */
    f: next,
    /** float in [lo,hi) — argument order mirrors the original game's rand(hi, lo) */
    range: (hi = 1, lo = 0) => lo + next() * (hi - lo),
    /** integer in [0,n) */
    int: (n) => (next() * n) | 0,
    pick: (arr) => arr[(next() * arr.length) | 0],
    bool: (p = 0.5) => next() < p,
    /** Fisher-Yates, non-mutating */
    shuffled(arr) {
      const a2 = arr.slice();
      for (let i = a2.length - 1; i > 0; i--) {
        const j = (next() * (i + 1)) | 0;
        const t = a2[i]; a2[i] = a2[j]; a2[j] = t;
      }
      return a2;
    },
    get state() { return a; },
    set state(v) { a = v >>> 0; }
  };
}

/** A hash good enough to turn a room code into a world seed. */
export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Presentation-only randomness. Never call this from inside the simulation. */
export const fx = {
  f: Math.random,
  range: (hi = 1, lo = 0) => lo + Math.random() * (hi - lo),
  int: (n) => (Math.random() * n) | 0,
  pick: (arr) => arr[(Math.random() * arr.length) | 0],
  bool: (p = 0.5) => Math.random() < p
};
