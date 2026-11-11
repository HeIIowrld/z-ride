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

/* The simulation never touches a renderer, a speaker, or the DOM. It appends
   plain-object events to a ring buffer, and whoever is presenting the game
   drains them. That separation is what lets the exact same file run inside a
   Cloudflare Durable Object, where none of those things exist. */

export const EV = {
  SHOT: 1,
  HIT: 2,
  KILL: 3,
  EXPLODE: 4,
  DASH: 5,
  HURT: 6,
  PICKUP: 7,
  WAVE: 8,
  BANNER: 9,
  ABILITY: 10,
  SPAWN: 11,
  TELEGRAPH: 12,
  DOWN: 13,
  REVIVE: 14,
  RESPAWN: 15,
  DIE: 16,
  UPGRADE: 17,
  MATCH_END: 18,
  BOUNCE: 19,
  PROP_BREAK: 20,
  STREAK: 21,
  HEAL: 22
};

export class EventQueue {
  constructor(cap = 512) {
    this.cap = cap;
    this.list = [];
  }
  push(type, data) {
    if (this.list.length >= this.cap) this.list.shift();
    data = data || {};
    data.t = type;
    this.list.push(data);
    return data;
  }
  drain(fn) {
    const l = this.list;
    for (let i = 0; i < l.length; i++) fn(l[i]);
    l.length = 0;
  }
  clear() { this.list.length = 0; }
}
