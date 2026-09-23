import type { StructureId } from "./anatomy.ts";

export type Side = "left" | "right";

// The verified export preserves LPS +X (patient left), then centers the GLB.
// X=0 separates all faces of this asset's 24 paired classes; see validate-atlas.mjs.
export function sideFromTriangle(
  id: StructureId,
  x: readonly [number, number, number],
): Side | null {
  if (id === "iliac" || id === "mulifidus" || id === "rectus_abdominis") return null;
  if (!x.every(Number.isFinite)) return null;
  if (x.every((value) => value > 0)) return "left";
  if (x.every((value) => value < 0)) return "right";
  return null;
}
