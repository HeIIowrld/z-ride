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

/* =============================== PROTOCOL ===============================

   Wire format. This file exists because JSON would cost roughly 200 kbit/s
   per player, and a chunk of the audience for this game is on a mobile
   connection where that is the difference between playable and not.

   Everything is quantised:
     • positions  — 16-bit fixed point over a ±80m world, ~2.4mm precision
     • angles     — 8 bits, 1.4 degrees, which is finer than anyone can see
     • velocities — 8 bits over ±50 m/s, used only to smooth interpolation
     • health     — a percentage byte for enemies, a raw byte for players

   Measured by tools/simtest.mjs: 281 B for a solo co-op snapshot, 1,173 B
   for a full 8-player team deathmatch. At the 20Hz tick that is roughly
   45–190 kbit/s down depending on how busy the arena is.

   Enemies go out every tick. It is tempting to halve their rate and
   interpolate — see the note in MatchRoom.js for why that is wrong here:
   they change direction far too abruptly to survive being guessed at.
   Projectiles are the ones that get thinned, and only during a storm.       */

const POS_SCALE = 400;        // 16-bit signed / 400 = ±81.9m
const VEL_SCALE = 2.5;        // 8-bit signed / 2.5 = ±50 m/s
const ANG_SCALE = 256 / (Math.PI * 2);

export const MSG = {
  // client -> server
  HELLO: 1,
  INPUT: 2,
  PING: 3,
  CHAT: 4,
  PICK: 5,        // upgrade choice
  READY: 6,
  VEHICLE_ACTION: 7,
  // server -> client
  WELCOME: 128,
  SNAPSHOT: 129,
  EVENTS: 130,
  PONG: 131,
  LOBBY: 132,
  CHOICE: 133,
  END: 134,
  KICK: 135,
  CHATOUT: 136
};

export class Writer {
  constructor(size = 4096) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
    this.o = 0;
  }
  _need(n) {
    if (this.o + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.o + n));
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }
  u8(v) { this._need(1); this.buf[this.o++] = v & 0xff; return this; }
  i8(v) { this._need(1); this.view.setInt8(this.o++, clampi(v, -128, 127)); return this; }
  u16(v) { this._need(2); this.view.setUint16(this.o, v & 0xffff); this.o += 2; return this; }
  i16(v) { this._need(2); this.view.setInt16(this.o, clampi(v, -32768, 32767)); this.o += 2; return this; }
  u32(v) { this._need(4); this.view.setUint32(this.o, v >>> 0); this.o += 4; return this; }
  f32(v) { this._need(4); this.view.setFloat32(this.o, v); this.o += 4; return this; }
  pos(v) { return this.i16(Math.round(v * POS_SCALE)); }
  vel(v) { return this.i8(Math.round(v * VEL_SCALE)); }
  ang(v) { let a = v % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return this.u8(Math.round(a * ANG_SCALE) & 0xff); }
  str(s) {
    const b = ENC.encode(s.slice(0, 255));
    this.u8(b.length); this._need(b.length);
    this.buf.set(b, this.o); this.o += b.length;
    return this;
  }
  bytes() { return this.buf.subarray(0, this.o); }
}

export class Reader {
  constructor(buf) {
    this.buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.o = 0;
  }
  get left() { return this.buf.length - this.o; }
  u8() { return this.buf[this.o++]; }
  i8() { return this.view.getInt8(this.o++); }
  u16() { const v = this.view.getUint16(this.o); this.o += 2; return v; }
  i16() { const v = this.view.getInt16(this.o); this.o += 2; return v; }
  u32() { const v = this.view.getUint32(this.o); this.o += 4; return v; }
  f32() { const v = this.view.getFloat32(this.o); this.o += 4; return v; }
  pos() { return this.i16() / POS_SCALE; }
  vel() { return this.i8() / VEL_SCALE; }
  ang() { return this.u8() / ANG_SCALE; }
  str() { const n = this.u8(); const s = DEC.decode(this.buf.subarray(this.o, this.o + n)); this.o += n; return s; }
}

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const clampi = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ------------------------------------------------------------------ INPUT */

/** 8 bytes per input frame, 30 per second: 240 B/s up. Nothing to optimise. */
export function encodeInput(seq, i) {
  const w = new Writer(16);
  w.u8(MSG.INPUT);
  w.u16(seq & 0xffff);
  w.i8(Math.round(i.mx * 100));
  w.i8(Math.round(i.mz * 100));
  w.ang(Math.atan2(i.az, i.ax));
  let flags = 0;
  if (i.fire) flags |= 1;
  if (i.dash) flags |= 2;
  if (i.ab0) flags |= 4;
  if (i.ab1) flags |= 8;
  w.u8(flags);
  w.u8(i.weapon & 0xff);
  return w.bytes();
}

export function decodeInput(r) {
  const seq = r.u16();
  const mx = r.i8() / 100;
  const mz = r.i8() / 100;
  const a = r.ang();
  const flags = r.u8();
  const weapon = r.u8();
  return {
    seq, mx, mz,
    ax: Math.cos(a), az: Math.sin(a),
    fire: !!(flags & 1), dash: !!(flags & 2), ab0: !!(flags & 4), ab1: !!(flags & 8),
    weapon
  };
}

/* --------------------------------------------------------------- SNAPSHOT */

const ENEMY_KEY_INDEX = ['rusher', 'shard', 'bruiser', 'spitter', 'splitter', 'stalker', 'sapper', 'warden', 'elite', 'boss'];
const PICKUP_KEY_INDEX = ['score', 'health', 'ammo', 'surge', 'fuse'];

export function encodeSnapshot(s, opts = {}) {
  const w = new Writer(8192);
  w.u8(MSG.SNAPSHOT);
  w.u32(s.tick);
  w.u16(Math.round(s.matchTime * 10) & 0xffff);
  w.u16(Math.round(s.shrink * 100) & 0xffff);
  w.u8(s.wave & 0xff);
  w.u8(PHASES.indexOf(s.phase) + 1);
  w.u8(Math.round(s.intensity * 255));
  w.u8(s.teamScore.length);
  for (const t of s.teamScore) w.u16(t);

  // players
  w.u8(s.players.length);
  for (const p of s.players) {
    w.u16(p.id);
    w.pos(p.x); w.pos(p.z);
    w.vel(p.vx); w.vel(p.vz);
    w.ang(p.a);
    w.u8(Math.min(255, p.hp));
    w.u8(Math.min(255, p.sh));
    w.u8(p.w);
    w.u8((p.alive ? 1 : 0) | (p.down ? 2 : 0) | (p.prot ? 4 : 0));
    w.u8(Math.min(255, p.dash));
    w.u8(Math.min(255, p.combo));
    w.u8(Math.min(255, Math.round(p.rev * 40)));
    w.u16(Math.min(65535, p.k));
    w.u16(Math.min(65535, p.d));
    w.u32(p.sc);
    w.u8(p.team);
    w.u16(p.seq & 0xffff);
    w.u8(Math.min(255, p.st));
  }

  // enemies — the bulk of the payload, so the tightest encoding
  const enemies = s.enemies;
  w.u16(enemies.length);
  for (const e of enemies) {
    w.u16(e.e & 0xffff);
    w.u8(Math.max(0, ENEMY_KEY_INDEX.indexOf(e.k)));
    w.pos(e.x); w.pos(e.z);
    w.ang(e.a);
    w.u8(e.hp);
    w.u8((e.w ? 1 : 0) | (e.b ? 2 : 0) | (e.s ? 4 : 0));
  }

  // projectiles
  const projs = opts.skipProjectiles ? [] : s.projectiles;
  w.u16(projs.length);
  for (const p of projs) {
    w.u16(p.e & 0xffff);
    w.pos(p.x); w.pos(p.z);
    w.vel(p.vx / 4); w.vel(p.vz / 4);      // projectile speeds run to 175 m/s
    w.u8(Math.round(p.s * 100));
    w.u32(p.c);
    w.u8(p.h);
  }

  // pickups
  w.u8(Math.min(255, s.pickups.length));
  for (let i = 0; i < Math.min(255, s.pickups.length); i++) {
    const p = s.pickups[i];
    w.u16(p.e & 0xffff);
    w.u8(Math.max(0, PICKUP_KEY_INDEX.indexOf(p.k)));
    w.pos(p.x); w.pos(p.z);
  }

  // turrets
  w.u8(s.turrets.length);
  for (const t of s.turrets) {
    w.u16(t.e & 0xffff);
    w.pos(t.x); w.pos(t.z); w.ang(t.a);
    w.u8(Math.min(255, Math.round(t.l * 8)));
  }

  w.u8(s.over ? 1 : 0);
  if (s.over) { w.u8(s.over.winner ?? 255); w.str(s.over.reason || ''); }
  // Optional trailer. Older readers stop at the match result.
  if (s.defense) {
    const d = s.defense;
    w.u8(d.hp).u8(d.maxHp).u8(d.fuses).u8(Math.round(d.flash * 10)).u8(d.carriers.length);
    for (const id of d.carriers) w.u16(id);
  }
  return w.bytes();
}

const PHASES = ['idle', 'wave', 'valley', 'choice'];

export function decodeSnapshot(r) {
  const s = {};
  s.tick = r.u32();
  s.matchTime = r.u16() / 10;
  s.shrink = r.u16() / 100;
  s.wave = r.u8();
  s.phase = PHASES[r.u8() - 1] || 'idle';
  s.intensity = r.u8() / 255;
  const tn = r.u8();
  s.teamScore = [];
  for (let i = 0; i < tn; i++) s.teamScore.push(r.u16());

  const pn = r.u8();
  s.players = [];
  for (let i = 0; i < pn; i++) {
    const p = {};
    p.id = r.u16();
    p.x = r.pos(); p.z = r.pos();
    p.vx = r.vel(); p.vz = r.vel();
    p.a = r.ang();
    p.hp = r.u8(); p.sh = r.u8(); p.w = r.u8();
    const f = r.u8();
    p.alive = !!(f & 1); p.down = !!(f & 2); p.prot = !!(f & 4);
    p.dash = r.u8(); p.combo = r.u8(); p.rev = r.u8() / 40;
    p.k = r.u16(); p.d = r.u16(); p.sc = r.u32();
    p.team = r.u8(); p.seq = r.u16(); p.st = r.u8();
    s.players.push(p);
  }

  const en = r.u16();
  s.enemies = [];
  for (let i = 0; i < en; i++) {
    const e = {};
    e.e = r.u16();
    e.k = ENEMY_KEY_INDEX[r.u8()] || 'rusher';
    e.x = r.pos(); e.z = r.pos();
    e.a = r.ang();
    e.hp = r.u8();
    const f = r.u8();
    e.w = !!(f & 1); e.b = !!(f & 2); e.s = !!(f & 4);
    s.enemies.push(e);
  }

  const jn = r.u16();
  s.projectiles = [];
  for (let i = 0; i < jn; i++) {
    const p = {};
    p.e = r.u16();
    p.x = r.pos(); p.z = r.pos();
    p.vx = r.vel() * 4; p.vz = r.vel() * 4;
    p.s = r.u8() / 100;
    p.c = r.u32();
    p.h = r.u8();
    s.projectiles.push(p);
  }

  const kn = r.u8();
  s.pickups = [];
  for (let i = 0; i < kn; i++) {
    const p = {};
    p.e = r.u16();
    p.k = PICKUP_KEY_INDEX[r.u8()] || 'score';
    p.x = r.pos(); p.z = r.pos();
    s.pickups.push(p);
  }

  const un = r.u8();
  s.turrets = [];
  for (let i = 0; i < un; i++) {
    s.turrets.push({ e: r.u16(), x: r.pos(), z: r.pos(), a: r.ang(), l: r.u8() / 8 });
  }

  s.over = r.u8() ? { winner: r.u8(), reason: r.str() } : null;
  if (s.over && s.over.winner === 255) s.over.winner = null;
  s.defense = null;
  if (r.left >= 5) {
    const hp = r.u8(), maxHp = r.u8(), fuses = r.u8(), flash = r.u8() / 10, count = r.u8();
    if (r.left >= count * 2) {
      const carriers = Array.from({ length: count }, () => r.u16());
      s.defense = { hp, maxHp, fuses, flash, carriers };
    }
  }
  return s;
}

/* ----------------------------------------------------------------- EVENTS
   Events are low-volume and highly variable, so they ride as JSON inside a
   single framed message. Trying to pack them would cost more in code than it
   saves on the wire. */

export function encodeEvents(list) {
  const w = new Writer(2048);
  w.u8(MSG.EVENTS);
  const json = JSON.stringify(list);
  const b = ENC.encode(json);
  w.u16(b.length);
  w._need(b.length);
  w.buf.set(b, w.o); w.o += b.length;
  return w.bytes();
}

export function decodeEvents(r) {
  const n = r.u16();
  const json = DEC.decode(r.buf.subarray(r.o, r.o + n));
  r.o += n;
  try { return JSON.parse(json); } catch { return []; }
}

/* JSON control messages: lobby state, welcome, upgrade choices, chat. */
export function encodeJson(type, obj) {
  const w = new Writer(2048);
  w.u8(type);
  const b = ENC.encode(JSON.stringify(obj));
  w.u16(b.length);
  w._need(b.length);
  w.buf.set(b, w.o); w.o += b.length;
  return w.bytes();
}

export function decodeJson(r) {
  const n = r.u16();
  const json = DEC.decode(r.buf.subarray(r.o, r.o + n));
  r.o += n;
  try { return JSON.parse(json); } catch { return null; }
}
