import { STRUCTURES, searchStructures, type StructureId } from "./anatomy.ts";
type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean };
  execute: (input: unknown) => unknown;
};
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected an object.");
  return input as Record<string, unknown>;
}
export function atlasTools(inspect: (id: StructureId) => void): Tool[] {
  return [
    {
      name: "find_anatomy",
      description: "Search the 27 EXMO segmentation classes by name, source identifier, or group.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", minLength: 1 } },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute(input) {
        const { query } = record(input);
        if (typeof query !== "string" || !query.trim())
          throw new Error("A nonempty query is required.");
        return searchStructures(query);
      },
    },
    {
      name: "inspect_anatomical_structure",
      description: "Reveal and select an EXMO structure in the 3D viewer.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute(input) {
        const { id } = record(input);
        const structure = STRUCTURES.find((s) => s.id === id);
        if (!structure) throw new Error("That structure is not present in this atlas.");
        inspect(structure.id);
        return structure;
      },
    },
  ];
}
export function registerAtlasTools(inspect: (id: StructureId) => void) {
  const context = (
    document as Document & {
      modelContext?: {
        registerTool: (tool: Tool, options: { signal: AbortSignal }) => void | Promise<void>;
      };
    }
  ).modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  for (const tool of atlasTools(inspect)) {
    try {
      void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(
        () => {},
      );
    } catch {
      /* Optional browser capability. All actions have visible controls. */
    }
  }
  return () => lifecycle.abort();
}
