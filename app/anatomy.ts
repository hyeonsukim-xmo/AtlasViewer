export const STRUCTURES = [
  { id: "femoral", name: "Femur", group: "Bone", color: "#AAB8BC" },
  { id: "iliac", name: "Iliac", group: "Bone", color: "#B7CAE9" },
  { id: "iliopsoas", name: "Iliopsoas", group: "Pelvic", color: "#16A6B6" },
  { id: "pectineus", name: "Pectineus", group: "Pelvic", color: "#D6A33D" },
  { id: "obturator_internus", name: "Obturator internus", group: "Pelvic", color: "#2C8E86" },
  { id: "obturator_externus", name: "Obturator externus", group: "Pelvic", color: "#7D4A9E" },
  { id: "quadratus_femoris", name: "Quadratus femoris", group: "Pelvic", color: "#9A6F55" },
  { id: "piriformis", name: "Piriformis", group: "Pelvic", color: "#C85870" },
  { id: "gluteus_maximus", name: "Gluteus maximus", group: "Gluteal", color: "#FF8150" },
  { id: "gluteus_medius", name: "Gluteus medius", group: "Gluteal", color: "#F0693F" },
  { id: "gluteus_minimus", name: "Gluteus minimus", group: "Gluteal", color: "#D94F5D" },
  { id: "tensor_fascia_latae", name: "Tensor fasciae latae", group: "Anterior", color: "#36CDE5" },
  { id: "sartorius", name: "Sartorius", group: "Anterior", color: "#F14D9B" },
  { id: "rectus_femoris", name: "Rectus femoris", group: "Anterior", color: "#34B6ED" },
  { id: "vastus_lateralis", name: "Vastus lateralis", group: "Anterior", color: "#147FD1" },
  { id: "vastus_intermedius", name: "Vastus intermedius", group: "Anterior", color: "#5D9FE6" },
  { id: "vastus_medialis", name: "Vastus medialis", group: "Anterior", color: "#405CC6" },
  { id: "adductor_longus", name: "Adductor longus", group: "Medial", color: "#FF86B5" },
  { id: "adductor_brevis", name: "Adductor brevis", group: "Medial", color: "#EF5890" },
  { id: "adductor_magnus", name: "Adductor magnus", group: "Medial", color: "#C93B7C" },
  { id: "gracilis", name: "Gracilis", group: "Medial", color: "#A83D94" },
  { id: "biceps_femoris", name: "Biceps femoris", group: "Posterior", color: "#8063DF" },
  { id: "semitendinosus", name: "Semitendinosus", group: "Posterior", color: "#C66DE9" },
  { id: "semimembranosus", name: "Semimembranosus", group: "Posterior", color: "#5C46BE" },
  { id: "abdominal_oblique", name: "Abdominal oblique", group: "Trunk", color: "#52B77D" },
  { id: "mulifidus", name: "Multifidus", group: "Trunk", color: "#4DB3DB" },
  { id: "rectus_abdominis", name: "Rectus abdominis", group: "Trunk", color: "#35A861" },
] as const;

export type Structure = (typeof STRUCTURES)[number];
export type StructureId = Structure["id"];
export const GROUPS = [
  "Lower Body",
  "All",
  "Bone",
  "Pelvic",
  "Gluteal",
  "Anterior",
  "Medial",
  "Posterior",
  "Trunk",
] as const;
export type Group = (typeof GROUPS)[number];
export type View = "front" | "back" | "side" | "three-quarter";
export interface SceneState {
  group: Group;
  hidden: StructureId[];
  selected: StructureId[];
  isolate: boolean;
  contextOpacity: number;
  explode: number;
  view: View;
  rotate: boolean;
  reset: number;
}
export const INITIAL_STATE: SceneState = {
  group: "Lower Body",
  hidden: [],
  selected: [],
  isolate: false,
  contextOpacity: 0.12,
  explode: 0,
  view: "front",
  rotate: false,
  reset: 0,
};
export function inGroup(structure: Structure, group: Group) {
  return (
    group === "All" ||
    (group === "Lower Body" ? structure.group !== "Trunk" : structure.group === group)
  );
}
export function visibleStructures(state: SceneState) {
  return STRUCTURES.filter(
    (s) =>
      (inGroup(s, state.group) || (!state.explode && state.selected.includes(s.id))) &&
      !state.hidden.includes(s.id) &&
      (!state.isolate || state.selected.includes(s.id)),
  );
}
export function searchStructures(query: string) {
  const words = query.toLowerCase().replace(/_/g, " ").trim().split(/\s+/);
  return STRUCTURES.filter((s) =>
    words.every((word) =>
      (s.name + " " + s.id.replace(/_/g, " ") + " " + s.group).toLowerCase().includes(word),
    ),
  );
}
export function selectStructure(state: SceneState, id: StructureId, toggle = false): SceneState {
  if (toggle && state.selected.includes(id)) {
    const selected = state.selected.filter((item) => item !== id);
    return { ...state, selected, isolate: selected.length > 0 && state.isolate };
  }
  const structure = STRUCTURES.find((s) => s.id === id)!;
  return {
    ...state,
    selected: toggle && !state.explode ? [...state.selected, id] : [id],
    hidden: state.hidden.includes(id)
      ? state.hidden.filter((hidden) => hidden !== id)
      : state.hidden,
    group: inGroup(structure, state.group) ? state.group : "All",
    rotate: false,
  };
}
export function toggleStructureVisibility(state: SceneState, id: StructureId): SceneState {
  if (visibleStructures(state).some((s) => s.id === id)) {
    const selected = state.selected.filter((item) => item !== id);
    return {
      ...state,
      hidden: [...state.hidden, id],
      selected,
      isolate: selected.length > 0 && state.isolate,
    };
  }
  const structure = STRUCTURES.find((s) => s.id === id)!;
  return {
    ...state,
    hidden: state.hidden.includes(id) ? state.hidden.filter((item) => item !== id) : state.hidden,
    group: inGroup(structure, state.group) ? state.group : "All",
    isolate: false,
  };
}

export function changeGroup(state: SceneState, group: Group): SceneState {
  return {
    ...state,
    group,
    selected: state.explode ? [] : state.selected,
    isolate: false,
    rotate: false,
  };
}
