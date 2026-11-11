import { allowsSeatAim, relativeSeatAim } from './seat-aim.js';

// Local +Z is forward. Looking forward, local -X is the passenger side.
export const CABIN = { halfWidth: 1.05, halfLength: 1.24, windowY: 1.32 };
export const HULL = { halfWidth: 1.05, halfLength: 2.13 };
export const VEHICLE_SEATS = {
  FRONT_PASSENGER: { x: -.57, z: .62, camera: -1.05, color: 0x62dbe6 },
  REAR_LEFT: { x: .57, z: -.62, camera: 2.2, color: 0xffc774 },
  REAR_RIGHT: { x: -.57, z: -.62, camera: -2.2, color: 0xbcabff },
};

export function vehiclePose(matchTime) {
  const angle = matchTime * .35;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { matchTime, angle, cos, sin, x: cos * 5, z: sin * 5 };
}

export function vehiclePoint(pose, x, z) {
  return { x: pose.x + pose.cos * x - pose.sin * z, z: pose.z + pose.sin * x + pose.cos * z };
}

// A shot must exit through the shooter's own opening. A legal sector can
// still point into a door pillar, the opposite seat, or solid bodywork.
export function windowMuzzle(seatId, matchTime, ax, az, pose = vehiclePose(matchTime)) {
  const seat = VEHICLE_SEATS[seatId];
  if (!seat || !allowsSeatAim(seatId, relativeSeatAim(matchTime, ax, az))) return null;
  const dx = pose.cos * ax + pose.sin * az;
  const dz = -pose.sin * ax + pose.cos * az;
  const wallX = Math.sign(dx) * CABIN.halfWidth;
  const wallZ = Math.sign(dz) * CABIN.halfLength;
  const tx = Math.abs(dx) > 1e-6 ? (wallX - seat.x) / dx : Infinity;
  const tz = Math.abs(dz) > 1e-6 ? (wallZ - seat.z) / dz : Infinity;
  const t = Math.min(tx, tz);
  if (!Number.isFinite(t)) return null;
  const x = seat.x + dx * t, z = seat.z + dz * t;
  const sameSide = x * seat.x > 0;
  const sameRow = z * seat.z > 0;
  const opening = tx < tz
    ? sameSide && sameRow && Math.abs(z) >= .16 && Math.abs(z) <= 1.12
    : sameRow && sameSide && Math.abs(x) >= .12 && Math.abs(x) <= .92;
  return opening ? vehiclePoint(pose, x + dx * .08, z + dz * .08) : null;
}

export function hullImpact(pose, x, z, endX, endZ, radius = 0) {
  const dx = x - pose.x, dz = z - pose.z;
  const fromX = pose.cos * dx + pose.sin * dz;
  const fromZ = -pose.sin * dx + pose.cos * dz;
  const vx = endX - x, vz = endZ - z;
  const localVx = pose.cos * vx + pose.sin * vz;
  const localVz = -pose.sin * vx + pose.cos * vz;
  let enter = 0, exit = 1;
  for (const [start, delta, half] of [
    [fromX, localVx, HULL.halfWidth + radius],
    [fromZ, localVz, HULL.halfLength + radius],
  ]) {
    if (Math.abs(delta) < 1e-6) {
      if (Math.abs(start) > half) return null;
      continue;
    }
    const first = (-half - start) / delta, second = (half - start) / delta;
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (enter > exit) return null;
  }
  return { x: x + enter * vx, z: z + enter * vz };
}
