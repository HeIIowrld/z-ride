export const seatSectors = {
  FRONT_PASSENGER: [-90, 90],
  REAR_LEFT: [-180, -90],
  REAR_RIGHT: [90, 180]
};

export function relativeSeatAim(matchTime, ax, az) {
  const relative = Math.atan2(az, ax) - (matchTime * 0.35 + Math.PI / 2);
  return Math.atan2(Math.sin(relative), Math.cos(relative)) * 180 / Math.PI;
}

export function allowsSeatAim(seat, degrees) {
  const sector = seatSectors[seat];
  return Boolean(sector && degrees >= sector[0] && degrees <= sector[1]);
}
