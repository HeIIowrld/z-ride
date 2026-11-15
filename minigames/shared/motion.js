// Looking out the RIGHT window the car's front is on the LEFT of the screen, so the outside
// world moves left -> right (+1). The left window is mirrored (-1).
export function travelDir(seat) { return seat === 'left' ? -1 : 1; }
export function frontEdgeX(width, seat) { return travelDir(seat) < 0 ? width : 0; }
export function rearEdgeX(width, seat) { return travelDir(seat) < 0 ? 0 : width; }
