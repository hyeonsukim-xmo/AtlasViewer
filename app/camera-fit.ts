import { Box3, MathUtils, Vector3 } from "three";
import type { View } from "./anatomy";

export function viewDirection(view: View) {
  return new Vector3(
    ...({ front: [0, 0, 1], back: [0, 0, -1], side: [1, 0, 0], "three-quarter": [0.65, 0.15, 1] }[
      view
    ] as [number, number, number]),
  ).normalize();
}
/** Fit all eight corners in camera space, including portrait and side views. */
export function fitCamera(box: Box3, direction: Vector3, aspect: number, fov: number) {
  const target = box.getCenter(new Vector3());
  const forward = direction.clone().normalize();
  const right = new Vector3().crossVectors(new Vector3(0, 1, 0), forward).normalize();
  const up = new Vector3().crossVectors(forward, right).normalize();
  const tanY = Math.tan(MathUtils.degToRad(fov / 2));
  const tanX = tanY * Math.max(0.1, aspect);
  let distance = 0.25;
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const corner = new Vector3(x, y, z).sub(target);
        distance = Math.max(
          distance,
          corner.dot(forward) +
            1.16 * Math.max(Math.abs(corner.dot(right)) / tanX, Math.abs(corner.dot(up)) / tanY),
        );
      }
  return { target, distance, position: target.clone().addScaledVector(forward, distance) };
}
