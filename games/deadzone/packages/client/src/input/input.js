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

/* ================================ INPUT =================================

   Four control schemes that all produce the same nine-field input struct,
   because the simulation must not be able to tell them apart:

     touch     floating dual sticks, adaptive dead-zone, assisted aim
     mouse     WASD + free aim at the ground plane
     gamepad   twin sticks with radial dead-zone and response curve
     hybrid    all of the above at once, last-used wins

   The two decisions that matter most for how the game feels on a phone:

   1. THE STICK APPEARS UNDER THE THUMB. It is never drawn in a fixed corner
      that the thumb then has to find. The origin is wherever the touch began,
      and it *drifts* toward the thumb if the thumb travels past the stick's
      radius — so a long drag never runs out of range mid-fight.

   2. AIM ASSIST IS THE AIMING. On a touchscreen, an unassisted right stick is
      not a skill test, it is a tax. The assist is a magnetism cone that
      biases toward the most threatening target inside it. It is applied here,
      on the client, before the input is sent — so the server never has to
      guess what the player meant, and the assist is honest input rather than
      server-side snapping.                                                  */

import { clamp, lerp, TAU } from '@overrun/shared/math.js';

const DEAD_MIN = 6;
const DEAD_MAX = 14;
const STICK_RADIUS = 58;

export class Input {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;

    this.keys = Object.create(null);
    this.mouse = { x: 0, y: 0, down: false, present: false };
    this.touching = false;
    this.lastScheme = 'mouse';

    this.moveStick = null;   // {id, ox, oy, x, y}
    this.aimStick = null;
    this.state = {
      mx: 0, mz: 0, ax: 1, az: 0,
      fire: false, dash: false, ab0: false, ab1: false, weapon: 0
    };
    this.pendingDash = false;
    this.pendingAb = [false, false];
    this.pendingWeaponCycle = false;
    this.onPause = null;
    this.gamepadIndex = null;

    this._bind();
  }

  _bind() {
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys[e.code] = true;
      this.lastScheme = 'mouse';
      switch (e.code) {
        case 'Escape': this.onPause && this.onPause(); break;
        case 'KeyQ': this.pendingWeaponCycle = true; break;
        case 'Space': case 'ShiftLeft': this.pendingDash = true; e.preventDefault(); break;
        case 'KeyE': this.pendingAb[0] = true; break;
        case 'KeyF': this.pendingAb[1] = true; break;
        default:
          if (e.code.startsWith('Digit')) {
            const n = +e.code.slice(5) - 1;
            if (n >= 0) this.state.weapon = n;
          }
      }
    });
    addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    addEventListener('blur', () => { this.keys = Object.create(null); this.mouse.down = false; });

    const down = (e) => {
      if (e.pointerType === 'mouse') {
        this.mouse.present = true;
        this.lastScheme = 'mouse';
        if (e.button === 0) this.mouse.down = true;
        if (e.button === 2) this.pendingDash = true;
        return;
      }
      this.touching = true;
      this.lastScheme = 'touch';
      const half = window.innerWidth * 0.5;
      const s = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
      if (e.clientX < half && !this.moveStick) this.moveStick = s;
      else if (e.clientX >= half && !this.aimStick) this.aimStick = s;
    };
    const move = (e) => {
      if (e.pointerType === 'mouse') {
        this.mouse.x = e.clientX; this.mouse.y = e.clientY;
        this.mouse.present = true;
        return;
      }
      const s = (this.moveStick && e.pointerId === this.moveStick.id) ? this.moveStick
        : (this.aimStick && e.pointerId === this.aimStick.id) ? this.aimStick : null;
      if (!s) return;
      s.x = e.clientX; s.y = e.clientY;
      const dx = s.x - s.ox, dy = s.y - s.oy;
      const d = Math.hypot(dx, dy);
      if (d > 3) s.moved = true;
      // Origin drift: once the thumb passes the stick radius, the origin
      // follows it. Without this a long strafe silently caps out.
      if (d > STICK_RADIUS) {
        const k = (d - STICK_RADIUS) / d;
        s.ox += dx * k;
        s.oy += dy * k;
      }
    };
    const up = (e) => {
      if (e.pointerType === 'mouse') { if (e.button === 0) this.mouse.down = false; return; }
      if (this.moveStick && e.pointerId === this.moveStick.id) this.moveStick = null;
      if (this.aimStick && e.pointerId === this.aimStick.id) {
        // A tap with no drag is "shoot where I am already looking".
        const s = this.aimStick;
        if (!s.moved && performance.now() - s.t < 220) this._tapFire = 0.18;
        this.aimStick = null;
      }
    };

    this.canvas.addEventListener('pointerdown', down);
    addEventListener('pointermove', move, { passive: true });
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
    addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('gesturestart', (e) => e.preventDefault());

    addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
    addEventListener('gamepaddisconnected', () => { this.gamepadIndex = null; });

    this._tapFire = 0;
  }

  /** Wire an on-screen button. Returns a disposer. */
  bindButton(el, onPress, onRelease) {
    const d = (e) => { e.preventDefault(); e.stopPropagation(); onPress(); };
    const u = (e) => { e.preventDefault(); onRelease && onRelease(); };
    el.addEventListener('pointerdown', d);
    if (onRelease) { el.addEventListener('pointerup', u); el.addEventListener('pointerleave', u); }
    return () => { el.removeEventListener('pointerdown', d); el.removeEventListener('pointerup', u); };
  }

  /** Resolve raw device state into the input struct.
   *  @param ctx.player  the local player (for mouse aim origin)
   *  @param ctx.rig     the camera rig (for screen->ground)
   *  @param ctx.targets iterable of aim-assist candidates {x,z,r,elite,alive} */
  sample(dt, ctx) {
    const s = this.state;
    this._tapFire = Math.max(0, this._tapFire - dt);

    /* ---- movement ---- */
    let mx = 0, mz = 0;
    if (this.keys.KeyW || this.keys.ArrowUp) mz -= 1;
    if (this.keys.KeyS || this.keys.ArrowDown) mz += 1;
    if (this.keys.KeyA || this.keys.ArrowLeft) mx -= 1;
    if (this.keys.KeyD || this.keys.ArrowRight) mx += 1;

    if (this.moveStick) {
      const st = this.moveStick;
      const dx = st.x - st.ox, dy = st.y - st.oy;
      const d = Math.hypot(dx, dy);
      // Adaptive dead-zone: tighter once the player has clearly committed to a
      // direction, wider at rest, so a resting thumb never drifts you into a
      // wall but a moving one responds immediately.
      const dead = lerp(DEAD_MAX, DEAD_MIN, clamp(this.speedHint || 0, 0, 1));
      if (d > dead) {
        const mag = clamp((d - dead) / (STICK_RADIUS - dead), 0, 1);
        // Slight expo curve: precise near centre, full tilt at the edge.
        const curved = mag * mag * 0.45 + mag * 0.55;
        mx = (dx / d) * curved;
        mz = (dy / d) * curved;
      }
    }

    const gp = this._gamepad();
    if (gp) {
      const [gx, gy] = radialDeadzone(gp.axes[0], gp.axes[1], 0.18);
      if (gx || gy) { mx = gx; mz = gy; this.lastScheme = 'gamepad'; }
    }

    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    s.mx = mx; s.mz = mz;
    this.speedHint = ml;

    /* ---- aim ---- */
    let ax = s.ax, az = s.az, wantFire = false;

    if (this.aimStick) {
      const st = this.aimStick;
      const dx = st.x - st.ox, dy = st.y - st.oy;
      const d = Math.hypot(dx, dy);
      if (d > 10) { ax = dx / d; az = dy / d; }
      wantFire = true;
    } else if (gp && (Math.abs(gp.axes[2]) > 0.2 || Math.abs(gp.axes[3]) > 0.2)) {
      const [rx, ry] = radialDeadzone(gp.axes[2], gp.axes[3], 0.2);
      const l = Math.hypot(rx, ry);
      if (l > 0.01) { ax = rx / l; az = ry / l; }
      wantFire = gp.buttons[7] && gp.buttons[7].value > 0.35;
    } else if (this.mouse.present && this.lastScheme === 'mouse') {
      const g = ctx.rig.screenToGround(this.mouse.x, this.mouse.y, TMPV);
      const dx = g.x - ctx.player.x, dz = g.z - ctx.player.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.2) { ax = dx / d; az = dz / d; }
      wantFire = this.mouse.down;
    }

    // Moving without ever aiming should still point you where you are going.
    if (ml > 0.1 && !this.aimStick && !this.mouse.present && !gp) { ax = mx; az = mz; }

    // Touch autofire: if the player is not touching the right side at all,
    // the character still engages anything it is already facing. Holding a
    // fire button on a phone is a tax on the thumb that aims.
    if (this.lastScheme === 'touch' && !this.aimStick) {
      wantFire = this._tapFire > 0 || this._autoTargetInCone(ctx, ax, az);
    }

    const assisted = this._assist(ctx, ax, az);
    s.ax = assisted.x; s.az = assisted.z;
    s.fire = wantFire;

    /* ---- one-shot actions ---- */
    s.dash = this.pendingDash || (gp && gp.buttons[0] && gp.buttons[0].pressed && !this._gpA);
    s.ab0 = this.pendingAb[0] || (gp && gp.buttons[2] && gp.buttons[2].pressed && !this._gpX);
    s.ab1 = this.pendingAb[1] || (gp && gp.buttons[3] && gp.buttons[3].pressed && !this._gpY);
    if (gp) {
      this._gpA = gp.buttons[0] && gp.buttons[0].pressed;
      this._gpX = gp.buttons[2] && gp.buttons[2].pressed;
      this._gpY = gp.buttons[3] && gp.buttons[3].pressed;
      if (gp.buttons[1] && gp.buttons[1].pressed && !this._gpB) this.pendingWeaponCycle = true;
      this._gpB = gp.buttons[1] && gp.buttons[1].pressed;
    }
    this.pendingDash = false;
    this.pendingAb[0] = this.pendingAb[1] = false;

    return s;
  }

  _gamepad() {
    if (this.gamepadIndex === null || !navigator.getGamepads) return null;
    const gp = navigator.getGamepads()[this.gamepadIndex];
    return gp && gp.connected ? gp : null;
  }

  _autoTargetInCone(ctx, ax, az) {
    for (const e of ctx.targets) {
      if (!e.alive) continue;
      const dx = e.x - ctx.player.x, dz = e.z - ctx.player.z;
      const d = Math.hypot(dx, dz);
      if (d > 26 || d < 0.5) continue;
      if ((dx / d) * ax + (dz / d) * az > 0.72) return true;
    }
    return false;
  }

  /** Magnetism cone. Biases the aim vector toward the most threatening target
   *  inside roughly thirty degrees, scaled by the player's own slider.
   *  Generous by design, and dialled right down for mouse users who did not
   *  ask for help. */
  _assist(ctx, ax, az) {
    const scale = this.settings.aimAssist * (this.lastScheme === 'mouse' ? 0.3 : 1);
    if (scale <= 0.01) return { x: ax, z: az };

    let best = null, bestScore = -1;
    const range = 34;
    for (const e of ctx.targets) {
      if (!e.alive) continue;
      const dx = e.x - ctx.player.x, dz = e.z - ctx.player.z;
      const d = Math.hypot(dx, dz);
      if (d > range || d < 0.5) continue;
      const dot = (dx / d) * ax + (dz / d) * az;
      if (dot < 0.86) continue;
      // Prefer things that are closer, more dangerous, and more centred.
      const score = dot * 2 + (1 - d / range) + (e.elite ? 0.4 : 0) + (e.threat || 0);
      if (score > bestScore) { bestScore = score; best = { x: dx / d, z: dz / d }; }
    }
    if (!best) return { x: ax, z: az };

    const k = 0.55 * scale;
    const nx = lerp(ax, best.x, k), nz = lerp(az, best.z, k);
    const l = Math.hypot(nx, nz) || 1;
    return { x: nx / l, z: nz / l };
  }

  takeWeaponCycle() {
    const v = this.pendingWeaponCycle;
    this.pendingWeaponCycle = false;
    return v;
  }

  get isTouch() { return this.lastScheme === 'touch'; }
}

function radialDeadzone(x, y, dz) {
  const m = Math.hypot(x, y);
  if (m < dz) return [0, 0];
  const scaled = (m - dz) / (1 - dz);
  return [(x / m) * scaled, (y / m) * scaled];
}

const TMPV = { x: 0, y: 0, z: 0 };

/* ------------------------------------------------------------- HAPTICS */

/** Distinct vibration patterns per event. A phone that buzzes identically for
 *  everything teaches the player to ignore it; distinguishable patterns turn
 *  it into a third feedback channel alongside sound and image. */
export const HAPTIC = {
  shootLight: 6,
  shootHeavy: [10],
  hit: 4,
  crit: [6, 14, 8],
  kill: 9,
  killElite: [12, 26, 16],
  hurt: [30],
  down: [40, 60, 90],
  dash: 12,
  ability: [8, 22, 8],
  pickup: 4,
  levelUp: [10, 40, 10, 40, 20],
  ui: 3
};

let hapticsEnabled = true;
export function setHaptics(on) { hapticsEnabled = on; }
export function haptic(pattern) {
  if (!hapticsEnabled || !navigator.vibrate) return;
  try { navigator.vibrate(pattern); } catch (e) { void e; }
}
void TAU;
