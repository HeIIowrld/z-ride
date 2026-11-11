import * as THREE from 'three';
import { CABIN, VEHICLE_SEATS, windowMuzzle } from '@overrun/shared/vehicle.js';

const up = new THREE.Vector3(0, 1, 0);
const aimRotation = new THREE.Quaternion();
const handRotation = new THREE.Quaternion();

export function aimMountedWeapon(weapon, seat, pose, aim) {
  const ax = Math.cos(aim), az = Math.sin(aim);
  const port = pose && windowMuzzle(seat, pose.matchTime, ax, az, pose);
  if (!port) {
    weapon.position.set(.10, -.02, 0);
    weapon.rotation.set(0, -Math.PI / 2, 0);
    return;
  }
  const barrel = weapon.userData.muzzle.position.z;
  weapon.position.set(port.x - ax * barrel, CABIN.windowY, port.z - az * barrel);
  weapon.parent.worldToLocal(weapon.position);
  aimRotation.setFromAxisAngle(up, Math.PI / 2 - aim);
  weapon.parent.getWorldQuaternion(handRotation);
  weapon.quaternion.copy(handRotation.invert()).multiply(aimRotation);
}

export function buildVehicle() {
  const car = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0x517367, metalness: .3, roughness: .46 });
  const edge = new THREE.MeshStandardMaterial({ color: 0x24343a, metalness: .25, roughness: .6 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x15191e, roughness: .96 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x899da0, metalness: .55, roughness: .48 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x75c3c7, transparent: true, opacity: .24, depthWrite: false });
  const lamps = (color) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: .55 });
  const frontLight = lamps(0xd8edfa), tailLight = lamps(0xf64e41);
  const box = (x, y, z, w, h, d, material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = !material.transparent;
    mesh.receiveShadow = true;
    car.add(mesh);
    return mesh;
  };

  // Open roll cage keeps the four seats visible from the overhead camera.
  box(0, .54, 0, 2.1, .38, 4.26, edge);
  box(0, .79, 0, 2.03, .28, 4.16, paint);
  box(0, .98, 1.67, 1.95, .21, .86, paint).rotation.x = .065;
  box(0, .97, -1.72, 1.96, .24, .92, paint);
  box(0, .59, 2.17, 2.11, .22, .2, edge);
  box(0, .59, -2.17, 2.11, .22, .2, edge);
  box(0, .88, 2.11, .85, .17, .08, edge);
  const steering = new THREE.Mesh(new THREE.TorusGeometry(.21, .035, 7, 14), rubber);
  steering.position.set(.57, 1.28, 1.06);
  steering.rotation.x = .36;
  car.add(steering);
  for (const x of [-.71, .71]) {
    box(x, .92, 2.1, .42, .17, .08, frontLight);
    box(x, .92, -2.19, .37, .15, .07, tailLight);
  }

  const wheelGeometry = new THREE.CylinderGeometry(.47, .47, .34, 14).rotateZ(Math.PI / 2);
  const hubGeometry = new THREE.CylinderGeometry(.26, .26, .035, 10).rotateZ(Math.PI / 2);
  for (const side of [-1, 1]) {
    const x = side * CABIN.halfWidth;
    box(x, .94, 0, .12, .43, 2.48, paint);
    box(x, .68, 0, .22, .12, 2.7, edge);
    box(x, 1.57, 0, .09, .08, 2.48, metal);
    for (const z of [-CABIN.halfLength, 0, CABIN.halfLength]) box(x, 1.33, z, .11, .52, .13, edge);
    for (const z of [-1.48, 1.48]) {
      const wheel = new THREE.Mesh(wheelGeometry, rubber);
      wheel.position.set(side * 1.07, .48, z);
      wheel.castShadow = true;
      car.add(wheel);
      const hub = new THREE.Mesh(hubGeometry, metal);
      hub.position.set(side * 1.25, .48, z);
      car.add(hub);
      box(side * .98, .94, z, .34, .12, 1.02, edge);
    }
  }
  for (const z of [-CABIN.halfLength, CABIN.halfLength]) {
    box(0, 1.57, z, 2.1, .08, .1, metal);
    box(0, 1.33, z, .22, .46, .07, edge);
    for (const x of [-.55, .55]) box(x, 1.32, z, .83, .35, .04, glass);
  }
  for (const seat of [...Object.values(VEHICLE_SEATS), { x: .57, z: .62, color: 0x53656c }]) {
    const trim = new THREE.MeshStandardMaterial({ color: seat.color, roughness: .73 });
    box(seat.x, .84, seat.z, .68, .15, .64, edge);
    box(seat.x, 1.09, seat.z - .26, .58, .54, .13, trim);
    box(seat.x, 1.39, seat.z - .27, .29, .13, .13, trim);
  }
  car.visible = false;
  return car;
}
