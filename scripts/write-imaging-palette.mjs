import { writeFileSync } from "node:fs";
import { STRUCTURES } from "../app/anatomy.ts";
// Keep the original atlas palette; the extra iliacus class follows MRI's ontology.
writeFileSync(
  "dist-desktop/imaging-palette.json",
  JSON.stringify([
    ...STRUCTURES,
    { id: "iliacus", name: "Iliacus", group: "Pelvic", color: "#B2D4F2" },
  ]),
);
