import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Box3, Group, Object3D, PerspectiveCamera, Quaternion, Vector3 } from "three";
import { SegmentRotation, ROTATION_RETURN_MS } from "../app/segment-rotation.ts";
import { tooltipPosition } from "../app/tooltip-position.ts";
import { sideFromTriangle } from "../app/model-side.ts";

assert.equal(sideFromTriangle("rectus_femoris", [1, 2, 3]), "left");
assert.equal(sideFromTriangle("rectus_femoris", [-1, -2, -3]), "right");
assert.equal(sideFromTriangle("rectus_femoris", [-1, 2, 3]), null);
assert.equal(sideFromTriangle("rectus_femoris", [0, 2, 3]), null);
assert.equal(sideFromTriangle("rectus_femoris", [NaN, 2, 3]), null);
assert.equal(sideFromTriangle("iliac", [1, 2, 3]), null);

// Each pointer quadrant opens toward the center; cards stay inside the canvas at its edges.
assert.deepEqual(tooltipPosition(200, 150, 800, 600, 300, 140), { left: 216, top: 166 });
assert.deepEqual(tooltipPosition(600, 150, 800, 600, 300, 140), { left: 284, top: 166 });
assert.deepEqual(tooltipPosition(200, 450, 800, 600, 300, 140), { left: 216, top: 294 });
assert.deepEqual(tooltipPosition(600, 450, 800, 600, 300, 140), { left: 284, top: 294 });
for (const [width, height, cardWidth, cardHeight] of [
  [800, 600, 300, 140],
  [320, 200, 300, 160],
]) {
  for (const x of [0, width / 2 - 1, width / 2, width]) {
    for (const y of [0, height / 2 - 1, height / 2, height]) {
      const position = tooltipPosition(x, y, width, height, cardWidth, cardHeight);
      assert.ok(position.left >= 8 && position.left + cardWidth <= width - 8);
      assert.ok(position.top >= 8 && position.top + cardHeight <= height - 8);
    }
  }
}

assert.equal(ROTATION_RETURN_MS, 700);
const pivot = new Group();
pivot.position.set(2, 3, 4);
const centerPoint = new Object3D();
pivot.add(centerPoint);
const rotation = new SegmentRotation(pivot.quaternion);
const neighbor = new Quaternion();
rotation.drag(90, 40, new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.6));
assert.ok(pivot.quaternion.angleTo(neighbor) > 0.5);
assert.deepEqual(centerPoint.getWorldPosition(new Vector3()).toArray(), [2, 3, 4]);
assert.deepEqual(neighbor.toArray(), [0, 0, 0, 1]);
const rotated = pivot.quaternion.clone();
rotation.restore(1000);
rotation.update(1350);
assert.ok(Math.abs(pivot.quaternion.angleTo(neighbor) - rotated.angleTo(neighbor) / 2) < 1e-8);
rotation.restore(1400); // Subsequent state changes must not restart the return.
rotation.update(1700);
assert.ok(pivot.quaternion.angleTo(neighbor) < 1e-8);
assert.equal(rotation.update(1701), false);
rotation.drag(80, 0, neighbor);
rotation.restore(2000);
rotation.update(2200);
rotation.drag(0, 0, neighbor); // Re-grabbing preserves the current orientation.
const interrupted = pivot.quaternion.clone();
assert.equal(rotation.update(3000), false);
assert.ok(pivot.quaternion.angleTo(interrupted) < 1e-8);
rotation.restore(3000, true);
assert.ok(pivot.quaternion.angleTo(neighbor) < 1e-8);
import {
  createExplosionLayout,
  EXPLOSION_DURATION_MS,
  transitionProgress,
} from "../app/explosion-layout.ts";
import { fitCamera, viewDirection } from "../app/camera-fit.ts";
import { PointerTap } from "../app/pointer-tap.ts";
assert.equal(EXPLOSION_DURATION_MS, 1700);
assert.equal(transitionProgress(-1), 0);
assert.equal(transitionProgress(0), 0);
assert.equal(transitionProgress(850), 0.5);
assert.ok(transitionProgress(1699) < 1);
assert.equal(transitionProgress(1700), 1);
assert.equal(transitionProgress(2000), 1);
assert.equal(transitionProgress(0, 0), 1);
for (let t = 1; t <= 1700; t++) assert.ok(transitionProgress(t) >= transitionProgress(t - 1));
import { atlasTools } from "../app/agent-tools.ts";
import {
  GROUPS,
  INITIAL_STATE,
  STRUCTURES,
  inGroup,
  searchStructures,
  selectStructure,
  changeGroup,
  toggleStructureVisibility,
  visibleStructures,
  structureColor,
} from "../app/anatomy.ts";
import { DEMO_MEASUREMENTS, volumeDifferencePercent } from "../app/demo-measurements.ts";

// Demo comparisons must use symmetric percentage differences, not a one-sided denominator.
assert.equal(volumeDifferencePercent(90, 110), 20);
assert.equal(volumeDifferencePercent(110, 90), 20);
assert.equal(volumeDifferencePercent(100, 100), 0);
assert.equal(volumeDifferencePercent(0, 0), null);
assert.equal(volumeDifferencePercent(0, 10), 200);
for (const structure of STRUCTURES) {
  assert.equal(structureColor(structure, "class"), structure.color);
  assert.equal(
    structureColor(structure, "anatomical"),
    structure.group === "Bone" ? "#D9CFB6" : "#B95550",
  );
  const sample = DEMO_MEASUREMENTS[structure.id];
  if (structure.group !== "Bone" && structure.group !== "Trunk") assert.ok(sample);
  if (!sample) continue;
  assert.ok(sample.volumeCm3.every((value) => Number.isFinite(value) && value > 0));
  if (structure.group === "Bone") assert.equal(sample.fatInfiltrationPercent, undefined);
  else
    assert.ok(
      sample.fatInfiltrationPercent.every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 100,
      ),
    );
}
assert.equal(DEMO_MEASUREMENTS.iliac, undefined); // Missing bilateral data must stay missing.

const bytes = await readFile(new URL("../public/models/exmo-1001921.glb", import.meta.url));
const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
const parts = gltf.meshes.map((m) => {
  const a = gltf.accessors[m.primitives[0].attributes.POSITION];
  return { id: m.name, bounds: [a.min.map((v) => v * 0.0033), a.max.map((v) => v * 0.0033)] };
});
for (const group of GROUPS)
  for (const aspect of [0.35, 0.55, 1, 1.8, 3.2]) {
    const ids = STRUCTURES.filter((s) => inGroup(s, group)).map((s) => s.id);
    const layout = createExplosionLayout(
      parts.filter((p) => ids.includes(p.id)),
      aspect,
    );
    const cells = [...layout.cells.values()];
    assert.equal(cells.length, ids.length);
    for (let i = 0; i < cells.length; i++) {
      const a = cells[i];
      assert.ok(Math.abs(a.x) + a.width / 2 <= layout.width / 2 + 1e-8);
      assert.ok(Math.abs(a.y) + a.height / 2 <= layout.height / 2 + 1e-8);
      for (const b of cells.slice(i + 1))
        assert.ok(
          Math.abs(a.x - b.x) >= (a.width + b.width) / 2 - 1e-8 ||
            Math.abs(a.y - b.y) >= (a.height + b.height) / 2 - 1e-8,
          "Exploded structures overlap",
        );
    }
    const box = new Box3(
      new Vector3(-layout.width / 2, -layout.height / 2, -0.3),
      new Vector3(layout.width / 2, layout.height / 2, 0.3),
    );
    for (const view of ["front", "back", "side", "three-quarter"]) {
      const camera = new PerspectiveCamera(30, aspect, 0.01, 100);
      const fit = fitCamera(box, viewDirection(view), aspect, 30);
      camera.position.copy(fit.position);
      camera.lookAt(fit.target);
      camera.updateMatrixWorld();
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
          for (const z of [box.min.z, box.max.z]) {
            const projected = new Vector3(x, y, z).project(camera);
            assert.ok(
              Math.abs(projected.x) <= 1 &&
                Math.abs(projected.y) <= 1 &&
                Math.abs(projected.z) <= 1,
              "Camera cropped geometry",
            );
          }
    }
  }
assert.equal(createExplosionLayout([]).cells.size, 0);
assert.equal(viewDirection("front").dot(viewDirection("back")), -1);
assert.equal(visibleStructures(INITIAL_STATE).length, 24);
assert.equal(visibleStructures({ ...INITIAL_STATE, group: "All" }).length, 27);
assert.equal(searchStructures("multifidus")[0].id, "mulifidus");
assert.equal(searchStructures("mulifidus")[0].name, "Multifidus");
assert.equal(searchStructures("tensor fasciae")[0].id, "tensor_fascia_latae");
assert.equal(searchStructures("femur")[0].id, "femoral");
assert.equal(searchStructures(" femoral ")[0].name, "Femur");
assert.equal(searchStructures("pelvic").length, 6);
assert.equal(searchStructures("no such structure").length, 0);
const chosen = selectStructure({ ...INITIAL_STATE, hidden: ["mulifidus"] }, "mulifidus");
assert.equal(chosen.group, "All");
assert.deepEqual(chosen.hidden, []);
const deselected = selectStructure({ ...chosen, isolate: true }, "mulifidus", true);
assert.deepEqual(deselected.selected, []);
assert.equal(deselected.isolate, false);
assert.equal(deselected.hidden, chosen.hidden);
assert.equal(visibleStructures(deselected).length, 27);
assert.deepEqual(selectStructure(chosen, "mulifidus").selected, ["mulifidus"]);
assert.deepEqual(selectStructure(chosen, "femoral", true).selected, ["mulifidus", "femoral"]);
assert.deepEqual(selectStructure({ ...chosen, explode: 1 }, "femoral", true).selected, ["femoral"]);
const bone = selectStructure(changeGroup(INITIAL_STATE, "Bone"), "femoral", true);
const posterior = changeGroup(bone, "Posterior");
assert.equal(posterior.group, "Posterior");
assert.deepEqual(posterior.selected, ["femoral"]);
assert.equal(visibleStructures(posterior).length, 4);
const pair = selectStructure(posterior, "biceps_femoris", true);
assert.deepEqual(pair.selected, ["femoral", "biceps_femoris"]);
assert.deepEqual(
  visibleStructures({ ...pair, isolate: true }).map((s) => s.id),
  pair.selected,
);
const removed = selectStructure({ ...pair, isolate: true }, "femoral", true);
assert.deepEqual(removed.selected, ["biceps_femoris"]);
assert.equal(removed.isolate, true);
assert.deepEqual(toggleStructureVisibility(pair, "femoral").selected, ["biceps_femoris"]);
const boneAgain = changeGroup(pair, "Bone");
assert.equal(boneAgain.group, "Bone");
assert.deepEqual(boneAgain.selected, pair.selected);
assert.equal(visibleStructures(boneAgain).length, 3);
assert.deepEqual(changeGroup({ ...pair, explode: 1 }, "Pelvic").selected, []);
assert.deepEqual(
  visibleStructures({ ...chosen, isolate: true }).map((s) => s.id),
  ["mulifidus"],
);
assert.equal(
  selectStructure(INITIAL_STATE, "femoral").hidden,
  INITIAL_STATE.hidden,
  "Ordinary selection must preserve camera fit dependencies",
);
const revealed = toggleStructureVisibility(INITIAL_STATE, "mulifidus");
assert.equal(revealed.group, "All");
assert.ok(visibleStructures(revealed).some((s) => s.id === "mulifidus"));
const revealedWhileIsolated = toggleStructureVisibility({ ...chosen, isolate: true }, "femoral");
assert.equal(revealedWhileIsolated.isolate, false);
assert.ok(visibleStructures(revealedWhileIsolated).some((s) => s.id === "femoral"));
const hiddenSelection = toggleStructureVisibility({ ...chosen, isolate: true }, "mulifidus");
assert.deepEqual(hiddenSelection.selected, []);
assert.equal(hiddenSelection.isolate, false);
assert.ok(!visibleStructures(hiddenSelection).some((s) => s.id === "mulifidus"));
let selected = null;
const [find, inspect] = atlasTools((id) => {
  selected = id;
});
assert.equal(find.execute({ query: "femur" })[0].id, "femoral");
inspect.execute({ id: "femoral" });
assert.equal(selected, "femoral");
for (const value of [null, [], { id: "missing" }, { id: 4 }])
  assert.throws(() => inspect.execute(value));
assert.equal(selected, "femoral");
for (const value of [null, [], { query: " " }, { query: 4 }])
  assert.throws(() => find.execute(value));
const tap = new PointerTap();
tap.down(1, 10, 10, 5);
assert.equal(tap.up(1, 12, 11), true);
tap.down(1, 10, 10, 5);
tap.move(1, 40, 10);
assert.equal(tap.up(1, 10, 10), false);
tap.down(1, 10, 10, 12);
tap.down(2, 20, 20, 12);
assert.equal(tap.up(2, 20, 20), false);
assert.equal(tap.up(1, 10, 10), false);
tap.down(1, 10, 10, 5);
tap.cancel(1);
assert.equal(tap.up(1, 10, 10), false);
tap.down(1, 10, 10, 5);
assert.equal(tap.up(1, 10, 10), true);
console.log(
  "Interactions: demo comparisons/palettes, 45 group/aspect layouts, all four camera directions, search aliases, reveal/isolate, tool validation, tap/drag/multitouch/cancellation passed.",
);
