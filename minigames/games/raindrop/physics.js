const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mass = r => r * r * r;
import { travelDir } from '../../shared/motion.js';

export function createWorld({ width = 375, height = 500, rng = Math.random, seat = 'left' } = {}) {
  return { width, height, rng, seat, drops: [], trails: [], dust: [], particles: [], elapsed: 0, intensity: 0, tunnel: false, powerups: [], barX: width / 2, barWidth: width * .18, gauge: 0, missed: 0, score: 0, spawnCarry: 0, nextPowerup: 14, kingActive: false, wind: 0, vehicleSpeedKmh: 0, acceleration: 0, previousSpeed: null };
}

export function thresholdRadius(mu = 1, wind = 0) { return Math.cbrt(4.2 * mu / (1 + Math.abs(wind) * .018)); }
export function addDrop(world, { x = world.rng() * world.width, y = 0, r = 2 + world.rng() * 3, vx = 0, vy = 0, king = false } = {}) {
  if (world.drops.length >= 400) return null;
  const seed=((Math.sin(x*12.9898+y*78.233+r*37.719+world.drops.length*19.19)*43758.5453)%1+1)%1, drop = { x, y, r, vx, vy, state: 'stuck', dirty: false, king, item: null, slip: 0, dustId: null, age: 0, mass: mass(r), mu: 1,
    meanderPhase:seed*Math.PI*2, meanderRate:.55+seed*1.15, meanderScale:.4+((seed*17)%1)*.6, windSensitivity:.98+seed*.04, stallPhase:seed*9.7, _lastVx:0 };
  world.drops.push(drop); return drop;
}
export function addDust(world, x, y, radius = 6 + world.rng() * 8) { const d = { id: `${world.elapsed}:${world.dust.length}`, x, y, r: radius }; world.dust.push(d); return d; }
export function addItemParticle(world, x, y, item) { world.dust.push({ id: `item:${world.elapsed}:${world.dust.length}`, x, y, r: 7, item }); }
export function addTrail(world, points, { king = false, lifetime = king ? 15 : 8, width = king ? 12 : 4 } = {}) {
  if (points.length < 2) return null;
  const trail = { points: points.map(p => ({ ...p })), wetness: 1, age: 0, lifetime, width, king, beads: [] };
  if (world.trails.length >= 1500) world.trails.shift(); world.trails.push(trail); return trail;
}
function nearestTrail(world, d) {
  let best = null, dist = Infinity;
  for (const trail of world.trails) {
    if (trail.wetness <= .2) continue;
    for (let i = 1; i < trail.points.length; i++) {
      const a = trail.points[i - 1], b = trail.points[i], dx = b.x - a.x, dy = b.y - a.y;
      const t = clamp(((d.x - a.x) * dx + (d.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
      const x = a.x + t * dx, y = a.y + t * dy, n = Math.hypot(d.x - x, d.y - y);
      if (n < Math.max(8, trail.width + d.r) && n < dist) { best = { trail, dx, dy, dist: n }; dist = n; }
    }
  }
  return best;
}
function drive(d, world, localMu) { return d.mass * (1 + Math.max(-.5, world.wind * .025)) - 4.2 * d.r * localMu; }
// travelDir points from the front edge to the rear edge. Accelerating pushes drops toward the rear (+travelDir); braking toward the front.
function inertialDrive(d, world) { return travelDir(world.seat) * world.acceleration * d.mass * .75; }
export function windShear(world, speedKmh = world.vehicleSpeedKmh) { return travelDir(world.seat) * (Math.max(0,Number(speedKmh)||0) / 60) * 5; }
function startSlide(d, world, boost = 1) {
  d.state = 'sliding'; if (d.dirty) { d.slip = .5; boost *= 1.6; } d.vx *= .2; d.vy = Math.max(0, drive(d, world, d.mu) / Math.max(1, d.r) * 5) * boost; d.path = [{ x: d.x, y: d.y }];
}
function merge(a, b) {
  const ma = a.mass, mb = b.mass, total = ma + mb;
  a.x = (a.x * ma + b.x * mb) / total; a.y = (a.y * ma + b.y * mb) / total;
  a.vx = (a.vx * ma + b.vx * mb) / total; a.vy = (a.vy * ma + b.vy * mb) / total;
  a.mass = total; a.r = Math.cbrt(total); a.king ||= b.king; a.dirty ||= b.dirty;
  if (b.item) a.item = b.item;
}
export function step(world, dt, options = {}) {
  const started = globalThis.performance?.now?.() ?? 0;
  dt = clamp(dt, 0, .05); world.elapsed += dt;
  if (Number.isFinite(options.speedKmh)) {
    const nextSpeed = Math.max(0, options.speedKmh), previous = world.previousSpeed ?? nextSpeed;
    const raw = clamp((nextSpeed - previous) / 3.6 / Math.max(dt, 1e-4), -6, 6);
    world.acceleration += (raw - world.acceleration) * (1 - Math.exp(-dt * 5)); world.previousSpeed = nextSpeed; world.vehicleSpeedKmh = nextSpeed;
  }
  world.intensity = Math.max(0, Math.floor(Math.max(0, world.elapsed - 30) / 30));
  world.wind += ((world.rng() - .5) * (1 + world.intensity * .12) - world.wind) * Math.min(1, dt * (options.gust ? 3 : .7));
  const dryRate = world.elapsed < 30 ? 1.25 : world.elapsed < 90 ? 2.1 : 3.2 + world.intensity * .15;
  world.spawnCarry += dt * dryRate;
  while (world.spawnCarry >= 1) { world.spawnCarry--; addDrop(world, { x: world.rng() * world.width, y: 32 + world.rng() * world.height * .5, r: 1.8 + world.rng() * 3.2 }); }
  if (world.elapsed >= world.nextPowerup) { addItemParticle(world, world.rng() * world.width, 32 + world.rng() * world.height * .35, options.powerup?.() ?? { id: 'wide', name: 'Wide' }); world.nextPowerup += 12 + world.rng() * 8; }
  for (const dust of world.dust) if (!dust.item && world.rng() < dt * (world.tunnel ? .32 + world.intensity * .02 : .018)) addDust(world, world.rng() * world.width, world.rng() * world.height * .6);
  for (const trail of world.trails) { trail.age += dt; trail.wetness = clamp(1 - trail.age / trail.lifetime, 0, 1); }
  world.trails = world.trails.filter(t => t.wetness > .01);
  for (let i = 0; i < world.drops.length; i++) {
    const d = world.drops[i]; d.age += dt;
    if (d.state === 'stuck') {
      const near = nearestTrail(world, d), wet = near && near.trail.wetness > .2, localMu = (wet ? .25 : 1) * (d.dirty ? 1.3 : 1) * (options.coating ? .6 : 1);
      d.mu = localMu;
      if (wet) {
        const len = Math.hypot(near.dx, near.dy) || 1, tx = near.dx / len * Math.sign(near.dy || 1), ty = Math.abs(near.dy / len);
        d.vx += (tx * 55 - d.vx) * Math.min(1, dt * 9); d.vy += (ty * 70 - d.vy) * Math.min(1, dt * 9);
      }
      const inertial = inertialDrive(d, world);
      if (drive(d, world, localMu) + Math.abs(inertial) > 0) startSlide(d, world);
      d.leanX = clamp((inertial + world.wind * d.mass * 2) / Math.max(1, d.mass * 6), -1, 1);
      for (let j = world.dust.length - 1; j >= 0; j--) { const dust = world.dust[j]; if (Math.hypot(d.x - dust.x, d.y - dust.y) <= d.r + dust.r) { world.dust.splice(j, 1); if (dust.item) { d.item = dust.item; } else { d.state = 'stuck'; d.dirty = true; d.dustId = dust.id; d.vx = d.vy = 0; d.mu = 4; } } }
    } else {
      const before = { x: d.x, y: d.y }, near = nearestTrail(world, d), wet = near && near.trail.wetness > .2, mu = (wet ? .25 : 1) * (d.dirty ? 1.3 : 1) * (options.coating ? .6 : 1);
      const force = drive(d, world, mu), target = Math.max(0, force / Math.max(1, d.r) * 7) * (d.dirty ? .7 : 1);
      const tau = .18 + d.r * .13;
      d.vy += (target - d.vy) * (1 - Math.exp(-dt * 5));
      const sizeFactor=clamp(2.8/Math.max(.8,d.r),.65,2.8),meander=Math.sin(d.age*d.meanderRate+d.meanderPhase)*sizeFactor*d.meanderScale*2;
      const zigzag=Math.sign(Math.sin(d.age*(1.1+d.meanderRate*.3)+d.stallPhase))*sizeFactor*.8;
      const stall=d.r<2.2&&Math.sin(d.age*1.9+d.stallPhase)>.88?.1:0;
      const shear=windShear(world)*d.windSensitivity + travelDir(world.seat)*world.wind*5*d.windSensitivity;
      const lateralWobble=Math.sin(d.age*d.meanderRate+d.meanderPhase)*Math.min(1.4,2.8/Math.max(.8,d.r))*d.meanderScale;
      const lateralForce = shear + lateralWobble + inertialDrive(d, world) / Math.max(1,d.mass);
      d.vx += (lateralForce - d.vx) * (1 - Math.exp(-dt / tau));
      const maxDelta = Math.max(.1, 30 * dt); d.vx = clamp(d.vx, d._lastVx - maxDelta, d._lastVx + maxDelta); d._lastVx = d.vx;
      if (wet) { const len = Math.hypot(near.dx, near.dy) || 1, tx = near.dx / len * Math.sign(near.dy || 1), ty = Math.abs(near.dy / len); d.vx += (tx * d.vy - d.vx) * Math.min(1, dt * 10); d.vy += (ty * d.vy - d.vy) * Math.min(1, dt * 10); }
      if (d.slip > 0) { d.vy *= 1 + Math.min(.8, d.slip * 1.6); d.slip = Math.max(0, d.slip - dt); }
      d.x += d.vx * dt; d.y += d.vy * dt; d.mass = Math.max(1, d.mass - Math.hypot(d.x - before.x, d.y - before.y) * d.r * .004); d.r = Math.cbrt(d.mass);
      if (d.path && Math.hypot(d.x - d.path.at(-1).x, d.y - d.path.at(-1).y) > 5) d.path.push({ x: d.x, y: d.y });
      if (drive(d, world, wet ? .25 : 1) <= 0 && !wet) { d.state = 'stuck'; d.vx = d.vy = 0; if (d.path?.length > 1) addTrail(world, d.path, { king: d.king }); d.path = null; }
      if (d.y >= world.height - 36 && Math.abs(d.x - world.barX) <= world.barWidth / 2) { world.gauge += d.mass; world.score += Math.max(1, Math.round(d.r * 2)); if (d.item) world.collected = (world.collected ?? []).concat(d.item); d.gone = true; }
      else if (d.y >= world.height) { world.missed++; world.gauge += 1; d.gone = true; }
    }
    for (let j = i + 1; j < world.drops.length; j++) { const b = world.drops[j]; if (!b.gone && Math.hypot(d.x - b.x, d.y - b.y) < d.r + b.r) { if (d.state === 'sliding' || b.state === 'sliding') { merge(d, b); b.gone = true; if (d.dirty && drive(d, world, 1) > 0) { d.slip = .5; d.state = 'sliding'; d.vy = Math.max(d.vy, 70); } } } }
  }
  world.drops = world.drops.filter(d => !d.gone && d.y < world.height);
  world.dust = world.dust.slice(-400); world.trails = world.trails.slice(-1500);
  const ended = globalThis.performance?.now?.() ?? started; world.lastStepMs = ended - started; return world;
}
export function getState(world) { return { drops: world.drops.length, stuck: world.drops.filter(d => d.state === 'stuck').length, sliding: world.drops.filter(d => d.state === 'sliding').length, trails: world.trails.length, dust: world.dust.length, stuckOnDust: world.drops.filter(d => d.state === 'stuck' && d.dirty).length, kingActive: world.drops.some(d => d.king), powerups: world.powerups, intensity: world.intensity, gauge: Math.min(100, world.missed / .9), missed: world.missed, elapsed: world.elapsed }; }
