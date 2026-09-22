import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";

// Extract data only. Never evaluate the supplied HTML or bundled JavaScript.
const source = await readFile(new URL("../EXMO_Segmentation_Atlas.html", import.meta.url));
const match = source.toString().match(/="data:model\/gltf-binary;base64,([A-Za-z0-9+/=]+)"/);
assert.ok(match, "The source HTML must contain an embedded binary glTF model.");
const glb = Buffer.from(match[1], "base64");
assert.equal(glb.readUInt32LE(0), 0x46546c67);
assert.equal(glb.readUInt32LE(4), 2);
assert.equal(glb.readUInt32LE(8), glb.length);
const model = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
assert.equal(model.meshes.length, 27);
const directory = new URL("../public/models/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL("exmo-1001921.glb", directory), glb);
console.log(
  "Extracted " +
    glb.length.toLocaleString() +
    " bytes, 27 meshes. Source SHA256: " +
    createHash("sha256").update(source).digest("hex"),
);
