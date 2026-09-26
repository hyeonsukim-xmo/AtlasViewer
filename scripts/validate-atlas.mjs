import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Box3, Matrix4, Quaternion, Vector3 } from "three";
import { STRUCTURES } from "../app/anatomy.ts";
import { sideFromTriangle } from "../app/model-side.ts";

const bytes = await readFile(new URL("../public/models/exmo-1001921.glb", import.meta.url));
assert.equal(
  createHash("sha256").update(bytes).digest("hex"),
  "555dbad58e9642dd5aaf18040b1008cf0f6ac1809bd88d98a0ba925a30306b0c",
  "Source model bytes changed",
);
assert.equal(bytes.length, 7660116);
assert.equal(bytes.readUInt32LE(0), 0x46546c67);
assert.equal(bytes.readUInt32LE(4), 2);
assert.equal(bytes.readUInt32LE(8), bytes.length);
const jsonLength = bytes.readUInt32LE(12);
assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
const binaryOffset = 20 + jsonLength;
const binaryLength = bytes.readUInt32LE(binaryOffset);
assert.equal(bytes.readUInt32LE(binaryOffset + 4), 0x004e4942);
assert.equal(binaryOffset + 8 + binaryLength, bytes.length);
const binary = bytes.subarray(binaryOffset + 8);
assert.equal(gltf.buffers.length, 1);
assert.ok(!gltf.buffers[0].uri);
assert.ok(gltf.buffers[0].byteLength <= binary.length);
assert.equal(new Set(STRUCTURES.map((s) => s.id)).size, 27);
// Preserve the approved class palette independently of the live catalogue.
assert.deepEqual(
  Object.fromEntries(STRUCTURES.map(({ id, color }) => [id, color])),
  {
    femoral: "#AAB8BC",
    iliac: "#B7CAE9",
    iliopsoas: "#16A6B6",
    pectineus: "#D6A33D",
    obturator_internus: "#2C8E86",
    obturator_externus: "#7D4A9E",
    quadratus_femoris: "#9A6F55",
    piriformis: "#C85870",
    gluteus_maximus: "#FF8150",
    gluteus_medius: "#F0693F",
    gluteus_minimus: "#D94F5D",
    tensor_fascia_latae: "#36CDE5",
    sartorius: "#F14D9B",
    rectus_femoris: "#34B6ED",
    vastus_lateralis: "#147FD1",
    vastus_intermedius: "#5D9FE6",
    vastus_medialis: "#405CC6",
    adductor_longus: "#FF86B5",
    adductor_brevis: "#EF5890",
    adductor_magnus: "#C93B7C",
    gracilis: "#A83D94",
    biceps_femoris: "#8063DF",
    semitendinosus: "#C66DE9",
    semimembranosus: "#5C46BE",
    abdominal_oblique: "#52B77D",
    mulifidus: "#4DB3DB",
    rectus_abdominis: "#35A861",
  },
  "Approved segment class colors changed",
);
assert.deepEqual(gltf.meshes.map((m) => m.name).sort(), STRUCTURES.map((s) => s.id).sort());

function accessor(index) {
  const a = gltf.accessors[index],
    view = gltf.bufferViews[a.bufferView];
  assert.ok(!a.sparse);
  const count = { SCALAR: 1, VEC3: 3 }[a.type];
  const component = {
    5121: [1, "readUInt8"],
    5123: [2, "readUInt16LE"],
    5125: [4, "readUInt32LE"],
    5126: [4, "readFloatLE"],
  }[a.componentType];
  assert.ok(count && component);
  assert.equal(view.buffer, 0);
  const [size, method] = component;
  const stride = view.byteStride ?? size * count;
  const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  assert.ok((view.byteOffset ?? 0) + view.byteLength <= binary.length);
  assert.ok((a.byteOffset ?? 0) + (a.count - 1) * stride + count * size <= view.byteLength);
  const values = Array.from({ length: a.count }, (_, i) =>
    Array.from({ length: count }, (_, c) => binary[method](offset + i * stride + c * size)),
  );
  assert.ok(values.flat().every(Number.isFinite));
  return { a, values };
}
let vertices = 0,
  triangles = 0;
const meshData = [];
const meshBounds = gltf.meshes.map((mesh) => {
  assert.equal(mesh.primitives.length, 1);
  const primitive = mesh.primitives[0];
  assert.equal(primitive.mode ?? 4, 4);
  const { a, values } = accessor(primitive.attributes.POSITION);
  const box = new Box3().setFromPoints(values.map((v) => new Vector3(...v)));
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(box.min.getComponent(c) - a.min[c]) < 0.0001);
    assert.ok(Math.abs(box.max.getComponent(c) - a.max[c]) < 0.0001);
  }
  const indices = accessor(primitive.indices).values.flat();
  assert.equal(indices.length % 3, 0);
  assert.ok(
    indices.every((index) => Number.isInteger(index) && index >= 0 && index < values.length),
  );
  for (let i = 0; i < indices.length; i += 3)
    assert.equal(new Set(indices.slice(i, i + 3)).size, 3);
  vertices += values.length;
  triangles += indices.length / 3;
  meshData.push({ values, indices });
  return box;
});
assert.equal(vertices, 212316);
assert.equal(triangles, 424456);
const sceneBounds = new Box3(),
  seen = new Set(),
  meshNames = [];
function visit(index, parent) {
  assert.ok(!seen.has(index), "Cyclic or repeated scene node");
  seen.add(index);
  const node = gltf.nodes[index];
  const matrix = node.matrix
    ? new Matrix4().fromArray(node.matrix)
    : new Matrix4().compose(
        new Vector3(...(node.translation ?? [0, 0, 0])),
        new Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
        new Vector3(...(node.scale ?? [1, 1, 1])),
      );
  assert.ok(matrix.elements.every(Number.isFinite));
  matrix.premultiply(parent);
  if (node.mesh !== undefined) {
    assert.equal(node.name, gltf.meshes[node.mesh].name);
    meshNames.push(node.name);
    sceneBounds.union(meshBounds[node.mesh].clone().applyMatrix4(matrix));
    const { values, indices } = meshData[node.mesh];
    const x = values.map((point) => new Vector3(...point).applyMatrix4(matrix).x);
    const sides = new Set();
    for (let i = 0; i < indices.length; i += 3) {
      sides.add(sideFromTriangle(node.name, [x[indices[i]], x[indices[i + 1]], x[indices[i + 2]]]));
    }
    assert.deepEqual(
      [...sides].sort(),
      ["iliac", "mulifidus", "rectus_abdominis"].includes(node.name) ? [null] : ["left", "right"],
      node.name +
        ": every paired surface triangle must have a stable side without crossing the midline",
    );
  }
  for (const child of node.children ?? []) visit(child, matrix);
}
for (const root of gltf.scenes[gltf.scene ?? 0].nodes) visit(root, new Matrix4());
assert.equal(meshNames.length, 27);
assert.ok(!sceneBounds.isEmpty());
const groups = Object.fromEntries(
  [...new Set(STRUCTURES.map((s) => s.group))].map((group) => [
    group,
    STRUCTURES.filter((s) => s.group === group).length,
  ]),
);
assert.deepEqual(groups, {
  Bone: 2,
  Pelvic: 6,
  Gluteal: 3,
  Anterior: 6,
  Medial: 4,
  Posterior: 3,
  Trunk: 3,
});
console.log(
  "GLB: 27 unique structures, " +
    vertices.toLocaleString() +
    " vertices, " +
    triangles.toLocaleString() +
    " triangles; buffers, indices, bounds, transforms, groups and 24 paired class sides valid.",
);
console.log("GLB SHA256: " + createHash("sha256").update(bytes).digest("hex"));
