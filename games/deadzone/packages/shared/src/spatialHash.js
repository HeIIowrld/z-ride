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

/* One uniform grid drives every neighbour query in the game: separation,
   projectile hits, explosion radius, aim assist, camera density, AI squad
   awareness. Rebuilt from scratch each tick — cheaper than incremental
   maintenance at these entity counts, and impossible to get stale. */

export class SpatialHash {
  constructor(cell = 4.2) {
    this.cell = cell;
    this.map = new Map();
    this.OFFSET = 512;  // keeps every coordinate positive before the |0 truncation
  }

  _key(cx, cz) { return (cx * 73856093) ^ (cz * 19349663); }

  clear() {
    for (const a of this.map.values()) a.length = 0;
  }

  insert(e) {
    const c = this.cell;
    const cx = ((e.x + this.OFFSET) / c) | 0;
    const cz = ((e.z + this.OFFSET) / c) | 0;
    const k = this._key(cx, cz);
    let a = this.map.get(k);
    if (!a) { a = []; this.map.set(k, a); }
    a.push(e);
  }

  /** Fills `out` with candidates near (x,z) within radius. Returns the count.
   *  Callers must still do an exact distance test — this is a broad phase. */
  query(x, z, radius, out) {
    let n = 0;
    const c = this.cell;
    const span = Math.max(1, Math.ceil(radius / c));
    const cx = ((x + this.OFFSET) / c) | 0;
    const cz = ((z + this.OFFSET) / c) | 0;
    const cap = out.length;
    for (let i = -span; i <= span; i++) {
      for (let j = -span; j <= span; j++) {
        const a = this.map.get(this._key(cx + i, cz + j));
        if (!a) continue;
        for (let k = 0; k < a.length; k++) {
          out[n++] = a[k];
          if (n >= cap) return n;
        }
      }
    }
    return n;
  }
}
