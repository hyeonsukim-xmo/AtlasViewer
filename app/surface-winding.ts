import { Vector3, type BufferGeometry } from "three";

export function orientClosedSurface(geometry: BufferGeometry) {
  const positions = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const count = index?.count ?? positions.count;
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  let volume = 0;
  for (let i = 0; i < count; i += 3) {
    a.fromBufferAttribute(positions, index ? index.getX(i) : i);
    b.fromBufferAttribute(positions, index ? index.getX(i + 1) : i + 1);
    c.fromBufferAttribute(positions, index ? index.getX(i + 2) : i + 2);
    volume += a.dot(b.cross(c));
  }
  if (volume >= 0) return;
  // Older exports did not reverse winding after a reflected patient-space transform.
  const indices = Array.from({ length: count }, (_, i) => index ? index.getX(i) : i);
  for (let i = 0; i < count; i += 3)
    [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  geometry.setIndex(indices);
}
