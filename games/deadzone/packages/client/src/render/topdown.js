import { COL, ENEMY_TYPES } from '@overrun/shared/defs.js';
import { EV } from '@overrun/shared/events.js';
import { damp, TAU } from '@overrun/shared/math.js';
import { seatSectors } from '@overrun/shared/seat-aim.js';
import { HULL, VEHICLE_SEATS, windowMuzzle } from '@overrun/shared/vehicle.js';

const INK = '#101a21';
const MINT = '#52f1d0';
const ROSE = '#f18470';
const GOLD = '#ffcd86';
const TEAM = ['#72d5ed', '#ff906e', '#b8dd8c', '#c7b7ef'];
const radians = Math.PI / 180;
const hex = color => '#' + color.toString(16).padStart(6, '0');

export class Topdown {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.settings = settings;
    this.effects = [];
    this.resize();
    this.reset();
  }

  resize() {
    const { width, height } = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.scale = Math.min(this.width, this.height) / 42;
  }

  reset() {
    this.x = this.z = 0;
    this.following = false;
    this.effects.length = 0;
  }

  project(x, _height, z, out) {
    out.x = this.width / 2 + (x - this.x) * this.scale;
    out.y = this.height / 2 + (z - this.z) * this.scale;
    out.behind = false;
    return out;
  }

  screenToGround(x, y, out) {
    out.x = (x - this.width / 2) / this.scale + this.x;
    out.z = (y - this.height / 2) / this.scale + this.z;
    return out;
  }

  screenDirection(x, down) { return { x, z: down }; }

  event(e) {
    let color, radius, duration;
    switch (e.t) {
      case EV.SHOT: color = GOLD; radius = 0.85; duration = 0.1; break;
      case EV.HIT: color = e.crit ? GOLD : ROSE; radius = 0.65; duration = 0.24; break;
      case EV.EXPLODE: color = e.hostile ? ROSE : GOLD; radius = e.r; duration = 0.42; break;
      case EV.TELEGRAPH: color = ROSE; radius = e.r || 2.2; duration = e.d || 0.5; break;
      case EV.SPAWN: color = ROSE; radius = 1.4; duration = 0.32; break;
      case EV.KILL: case EV.DIE: case EV.PROP_BREAK:
        if (e.silent) return;
        color = ROSE; radius = (e.r || 1) * 1.6; duration = 0.26; break;
      case EV.PICKUP: case EV.HEAL: case EV.REVIVE: case EV.RESPAWN: case EV.DASH:
        color = MINT; radius = 1.7; duration = 0.28; break;
      case EV.ABILITY:
        color = MINT; radius = e.r || 2.3; duration = e.dur || 0.38; break;
      default: return;
    }
    if (!Number.isFinite(e.x) || !Number.isFinite(e.z) || !Number.isFinite(radius)) return;
    if (this.effects.length >= 160) this.effects.shift();
    this.effects.push({ ...e, color, radius, duration, age: 0 });
  }

  render(dt, view, world, seat, riders, pvp, damage) {
    const c = this.ctx;
    const follow = view.vehicle || view.player;
    if (follow) {
      const speed = view.vehicle ? 7 : 13;
      this.x = this.following ? damp(this.x, follow.x, speed, dt) : follow.x;
      this.z = this.following ? damp(this.z, follow.z, speed, dt) : follow.z;
      this.following = true;
    }

    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = '#0b1319';
    c.fillRect(0, 0, this.width, this.height);
    c.save();
    c.translate(this.width / 2, this.height / 2);
    c.scale(this.scale, this.scale);
    c.translate(-this.x, -this.z);
    c.lineJoin = 'round';
    c.lineCap = 'round';
    this.drawLot(world, view.shrink);
    if (view.vehicle) this.drawSector(view.vehicle, seat, view.player);
    for (const item of view.pickups) this.drawPickup(item);
    for (const turret of view.turrets) this.drawTurret(turret);
    for (const enemy of view.enemies) this.drawEnemy(enemy);
    if (view.vehicle) this.drawVehicle(view.vehicle);
    for (const player of view.mates) this.drawPlayer(player, false, riders?.get(player.id)?.seat, pvp);
    if (view.player) this.drawPlayer(view.player, true, seat, pvp);
    for (const shot of view.projectiles) this.drawProjectile(shot);
    this.drawEffects(dt);
    c.restore();

    if (damage > 0) {
      c.strokeStyle = `rgba(241,99,83,${damage * 0.5})`;
      c.lineWidth = 5;
      c.strokeRect(2, 2, this.width - 4, this.height - 4);
    }
  }

  drawLot(world, shrink) {
    const c = this.ctx;
    const r = world.radius;
    c.save();
    c.beginPath();
    c.arc(0, 0, r, 0, TAU);
    c.fillStyle = '#232e36';
    c.fill();
    c.clip();

    c.fillStyle = '#29353d';
    for (const z of [-r + 2, r - 11]) c.fillRect(-r, z, r * 2, 9);
    c.strokeStyle = '#526068';
    c.lineWidth = 0.12;
    c.beginPath();
    for (const z of [-r + 11, r - 11]) {
      const end = z + Math.sign(z) * 9;
      c.moveTo(-r, z);
      c.lineTo(r, z);
      for (let x = -r; x < r; x += 5) {
        c.moveTo(x, z);
        c.lineTo(x, end);
      }
    }
    c.stroke();
    c.setLineDash([2.4, 2.5]);
    c.strokeStyle = '#786e58';
    c.lineWidth = 0.13;
    for (const z of [-8, 8]) this.line(-r, z, r, z);
    c.setLineDash([]);
    for (const prop of world.props) {
      if (!prop.alive || prop.y < -0.3) continue;
      this.circle(prop.x, prop.z, prop.r, '#182027');
      this.circle(prop.x, prop.z, prop.r * 0.86, prop.type === 'crate' ? '#76634c' : '#4b5961');
    }
    c.restore();

    c.strokeStyle = '#627077';
    c.lineWidth = 0.22;
    this.circle(0, 0, r);
    if (shrink > 0 && shrink < r - 0.5) {
      c.strokeStyle = ROSE;
      c.setLineDash([0.8, 0.5]);
      this.circle(0, 0, shrink);
      c.setLineDash([]);
    }
  }

  drawSector(vehicle, seat, player) {
    const c = this.ctx;
    const [start, end] = seatSectors[seat];
    const forward = vehicle.angle + Math.PI / 2;
    const color = hex(VEHICLE_SEATS[seat].color);
    const reach = 32;
    c.beginPath();
    c.moveTo(vehicle.x, vehicle.z);
    c.arc(vehicle.x, vehicle.z, reach, forward + start * radians, forward + end * radians);
    c.closePath();
    c.fillStyle = color + '16';
    c.fill();
    c.strokeStyle = color + 'a0';
    c.lineWidth = 0.1;
    c.setLineDash([0.65, 0.55]);
    c.stroke();
    c.setLineDash([]);

    const ax = Math.cos(player.aimA), az = Math.sin(player.aimA);
    const muzzle = windowMuzzle(seat, vehicle.matchTime, ax, az, vehicle);
    if (!muzzle) return;
    c.strokeStyle = color;
    this.line(muzzle.x, muzzle.z, muzzle.x + ax * 2, muzzle.z + az * 2);
  }

  drawVehicle(vehicle) {
    const c = this.ctx;
    const { halfWidth: w, halfLength: l } = HULL;
    c.save();
    c.translate(vehicle.x, vehicle.z);
    c.rotate(vehicle.angle);
    c.fillStyle = '#0a1219';
    for (const x of [-w - 0.15, w - 0.18]) {
      for (const z of [-1.48, 0.78]) c.fillRect(x, z, 0.33, 0.75);
    }
    c.beginPath();
    c.roundRect(-w, -l, w * 2, l * 2, [0.33, 0.33, 0.42, 0.42]);
    c.fillStyle = '#7693a4';
    c.fill();
    c.lineWidth = 0.14;
    c.strokeStyle = '#c9e4ee';
    c.stroke();
    c.fillStyle = '#203849';
    c.fillRect(-0.81, -1.24, 1.62, 2.48);
    c.fillStyle = '#d2ebea';
    for (const x of [-0.82, 0.45]) c.fillRect(x, 1.76, 0.37, 0.15);
    c.fillStyle = ROSE;
    for (const x of [-0.82, 0.45]) c.fillRect(x, -1.91, 0.37, 0.13);
    c.restore();
  }

  drawPlayer(player, local, seat, pvp) {
    if (player.alive === false) return;
    const c = this.ctx;
    const x = player.x, z = player.z;
    const color = seat ? hex(VEHICLE_SEATS[seat].color) : pvp ? TEAM[player.team] : local ? MINT : TEAM[0];
    if (seat) {
      this.circle(x, z, local ? 0.36 : 0.29, color);
      return;
    }
    const aim = player.aimA || 0;
    c.save();
    c.translate(x, z);
    c.rotate(aim);
    this.circle(0, 0, 0.84, INK);
    this.circle(0, 0, 0.58, player.down ? ROSE : color);
    c.fillStyle = '#f6f4d9';
    c.fillRect(0.35, -0.13, 0.7, 0.26);
    c.restore();
    if (local) {
      c.strokeStyle = color;
      c.lineWidth = 0.11;
      this.circle(x, z, 1.06);
    }
  }

  drawEnemy(enemy) {
    const c = this.ctx;
    const r = enemy.r;
    const def = ENEMY_TYPES[enemy.key];
    c.save();
    c.translate(enemy.x, enemy.z);
    c.rotate(enemy.faceA || 0);
    c.globalAlpha = enemy.spawning ? 0.55 : 1;
    this.circle(0, 0, r * 1.06, INK);
    c.fillStyle = enemy.windup || enemy.flash ? '#ffe7be' : enemy.elite ? GOLD : ROSE;
    c.beginPath();
    c.ellipse(-r * 0.14, 0, r * 0.62, r * 0.85, 0, 0, TAU);
    c.fill();
    this.circle(r * 0.31, 0, r * 0.42, def?.ranged ? '#e6c5a0' : '#e7ab8c');
    c.restore();
    if ((enemy.elite || r > 1.2) && enemy.hpFrac < 1) {
      c.fillStyle = INK;
      c.fillRect(enemy.x - r, enemy.z - r - 0.4, r * 2, 0.22);
      c.fillStyle = ROSE;
      c.fillRect(enemy.x - r, enemy.z - r - 0.4, r * 2 * enemy.hpFrac, 0.22);
    }
  }

  drawPickup(item) {
    const c = this.ctx;
    const color = item.kind === 'health' ? MINT : item.kind === 'surge' ? ROSE : GOLD;
    c.fillStyle = INK;
    c.fillRect(item.x - 0.48, item.z - 0.48, 0.96, 0.96);
    c.strokeStyle = color;
    c.lineWidth = 0.12;
    c.strokeRect(item.x - 0.48, item.z - 0.48, 0.96, 0.96);
    this.line(item.x - 0.23, item.z, item.x + 0.23, item.z);
    if (item.kind === 'health') this.line(item.x, item.z - 0.23, item.x, item.z + 0.23);
  }

  drawTurret(turret) {
    const c = this.ctx;
    this.circle(turret.x, turret.z, 0.62, INK);
    this.circle(turret.x, turret.z, 0.39, GOLD);
    const angle = turret.aimA ?? turret.a ?? 0;
    c.strokeStyle = GOLD;
    c.lineWidth = 0.22;
    this.line(turret.x, turret.z, turret.x + Math.cos(angle), turret.z + Math.sin(angle));
  }

  drawProjectile(shot) {
    const c = this.ctx;
    c.strokeStyle = hex(shot.color ?? COL.amber);
    c.lineWidth = Math.max(0.13, (shot.size || 0.14) * 1.25);
    const speed = Math.hypot(shot.vx, shot.vz);
    const tail = speed > 0 ? Math.min(0.024, 1.7 / speed) : 0;
    if (tail) this.line(shot.x, shot.z, shot.x - shot.vx * tail, shot.z - shot.vz * tail);
    else this.circle(shot.x, shot.z, 0.1, c.strokeStyle);
  }

  drawEffects(dt) {
    const c = this.ctx;
    for (const e of this.effects) {
      e.age += dt;
      const progress = e.age / e.duration;
      if (progress >= 1) continue;
      c.globalAlpha = (1 - progress) * 0.9;
      c.strokeStyle = e.color;
      c.lineWidth = 0.16;
      if (e.t === EV.SHOT || (e.t === EV.TELEGRAPH && e.kind === 'lunge')) {
        const length = e.t === EV.SHOT ? 1.2 : e.radius;
        this.line(e.x, e.z, e.x + Math.cos(e.a) * length, e.z + Math.sin(e.a) * length);
      } else {
        const radius = e.t === EV.TELEGRAPH ? e.radius : e.radius * (0.35 + progress * 0.65);
        this.circle(e.x, e.z, radius);
      }
      if (this.settings.damageNumbers && (e.t === EV.HIT || e.t === EV.HEAL)) {
        c.font = '700 1.35px system-ui';
        c.textAlign = 'center';
        c.fillStyle = e.color;
        c.fillText(e.dmg ?? e.v, e.x, e.z - 1 - progress);
      }
    }
    c.globalAlpha = 1;
    this.effects = this.effects.filter(e => e.age < e.duration);
  }

  circle(x, y, r, fill) {
    const c = this.ctx;
    c.beginPath();
    c.arc(x, y, r, 0, TAU);
    if (fill) { c.fillStyle = fill; c.fill(); }
    else c.stroke();
  }

  line(x, y, endX, endY) {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(endX, endY);
    c.stroke();
  }
}
