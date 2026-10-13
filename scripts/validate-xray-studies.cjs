const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createRequire } = require("node:module");
const root = path.resolve(".");
const compiled = ts.transpileModule(fs.readFileSync("desktop/ui/xray-studies.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const helpers = { exports: {} };
vm.runInNewContext(compiled, { exports: helpers.exports, require });
const { groupXrays, studyKey, xrayView, comparisonView, pendingXrayInputs, xrayApplicable } =
  helpers.exports;
const metadata = {
  format: "NRRD",
  caseName: "Fixture",
  studyDescription: "Study",
  seriesDescription: "Series",
  patientId: "00042",
  patientIssuer: "Hospital-A",
  studyDate: "20261012",
  size: [2, 2, 1],
  spacing: [1, 1, 1],
  slices: 1,
};
const file = (id, route, extra = {}) => ({
  id,
  name: id,
  analysis: "xray",
  ready: true,
  warnings: [],
  metadata: { ...metadata, ...extra },
  classification: {
    route_to_segmentation: route,
    predicted_label: route,
    confidence: 1,
    probabilities: {},
  },
});
const three = [file("ap", "AP"), file("rt", "LAT_RT"), file("lt", "LAT_LT")];
assert.equal(groupXrays(three).length, 1);
assert.deepEqual(Array.from(groupXrays(three)[0].items, xrayView), ["LAT_LT", "AP", "LAT_RT"]);
for (let bits = 1; bits < 8; bits++) {
  const items = three.filter((_, i) => bits & (1 << i));
  const grouped = groupXrays(items);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].items.length, items.length);
  const ranks = Array.from(grouped[0].items, (r) =>
    ["LAT_LT", "AP", "LAT_RT"].indexOf(xrayView(r)),
  );
  assert.deepEqual(ranks, [...ranks].sort());
}
assert.notEqual(studyKey(three[0]), studyKey(file("other", "AP", { patientIssuer: "Hospital-B" })));
assert.notEqual(studyKey(three[0]), studyKey(file("other", "AP", { patientId: "42" })));
assert.notEqual(studyKey(three[0]), studyKey(file("other", "AP", { studyDate: "20261011" })));
assert.equal(
  groupXrays([file("a", "AP", { studyUid: "1" }), file("b", "AP", { studyUid: "2" })])[0].items
    .length,
  2,
  "Same-day repeat images remain distinct",
);
assert.notEqual(studyKey({ id: "a", name: "same" }), studyKey({ id: "b", name: "same" }));
assert.notEqual(
  studyKey(file("a", "AP", { patientIssuer: "", studyUid: "1" })),
  studyKey(file("b", "AP", { patientIssuer: "", studyUid: "2" })),
);
assert.equal(
  studyKey(file("a", "AP", { patientIssuer: "", studyUid: "1" })),
  studyKey(file("b", "LAT_RT", { patientIssuer: "", studyUid: "1" })),
);
assert.equal(
  studyKey({ id: "result", inputId: "a", name: "same" }),
  studyKey({ id: "a", name: "same" }),
);
assert.deepEqual(
  Array.from(pendingXrayInputs(three, [{ inputId: "ap" }], ["ap", "rt", "lt"]), (f) => f.id),
  ["rt", "lt"],
);
assert.equal(pendingXrayInputs([{ ...three[0], ready: false }], [], ["ap"]).length, 0);
assert.notEqual(
  studyKey(file("bad1", "AP", { studyDate: "20260230" })),
  studyKey(file("bad2", "LAT_LT", { studyDate: "20260230" })),
  "Invalid dates do not merge unrelated inputs",
);
assert.equal(xrayApplicable({ route: "LAT_LT" }, { label: 4 }), false);
assert.equal(xrayApplicable({ route: "AP" }, { label: 4 }), true);
assert.equal(
  comparisonView(groupXrays([file("a", "LAT_LT"), file("b", "LAT_LT", { patientId: "other" })])),
  "LAT_LT",
);
assert.equal(
  comparisonView(groupXrays([file("a", "LAT_RT"), file("b", "AP", { patientId: "other" })])),
  "AP",
);
assert.equal(comparisonView(groupXrays(three)), "AP");

(async () => {
  const directory = await fsp.mkdtemp(path.join(root, "outputs/xray-study-check-"));
  const input = path.join(directory, "input.nrrd");
  await fsp.writeFile(input, "fixture");
  const palette = path.join(directory, "palette.json");
  await fsp.writeFile(palette, "[]");
  await fsp.writeFile(
    path.join(directory, "library.json"),
    JSON.stringify(
      [...three, { ...file("ct", "AP"), analysis: "ct" }].map((f) => ({ ...f, input })),
    ),
  );
  const resultDir = path.join(directory, "runs/result");
  await fsp.mkdir(resultDir, { recursive: true });
  await fsp.writeFile(
    path.join(resultDir, "published.json"),
    JSON.stringify({
      summary: {
        id: "result",
        inputId: "ap",
        analysis: "xray",
        metadata,
        createdAt: "2026-10-12",
        rows: [],
      },
      record: { ...three[0], input },
      mask: input,
      result: resultDir,
    }),
  );
  let handlers = new Map();
  const electron = {
    dialog: {},
    ipcMain: {
      handle: (name, fn) => handlers.set(name, fn),
      removeHandler: (name) => handlers.delete(name),
    },
    powerSaveBlocker: {},
  };
  const localRequire = createRequire(path.join(root, "desktop/imaging.cjs"));
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync("desktop/imaging.cjs", "utf8"), {
    require: (name) => (name === "electron" ? electron : localRequire(name)),
    module,
    console,
    process,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
  });
  const frame = { url: "atlas://app/" };
  const window = { webContents: { mainFrame: frame, send() {} } };
  const event = { sender: window.webContents, senderFrame: frame };
  const setup = () =>
    module.exports.installImaging(window, {
      engineRoot: root,
      storageRoot: directory,
      scriptsRoot: path.join(root, "desktop"),
      palette,
    });
  const call = (name, ...args) => handlers.get("exmo:imaging:" + name)(event, ...args);
  let service = setup();
  assert.equal(
    (
      await call("assignXrayStudy", ["ap"], {
        patientId: "00042",
        patientIssuer: "Site",
        studyDate: "2026-02-30",
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await call("assignXrayStudy", ["ct"], {
        patientId: "00042",
        patientIssuer: "Site",
        studyDate: "2026-10-12",
      })
    ).ok,
    false,
  );
  const study = { patientId: "00042", patientIssuer: "Site", studyDate: "2026-10-12" };
  const replies = await Promise.all([
    call("assignXrayStudy", ["ap"], study),
    call("assignXrayStudy", ["lt", "rt"], study),
  ]);
  assert(replies.every((r) => r.ok));
  assert.equal(
    (await call("list", "xray")).value.filter(
      (f) => f.metadata.studyAssignment?.patientId === "00042",
    ).length,
    3,
  );
  assert.equal(
    (await call("results", "xray")).value[0].metadata.studyAssignment.studyDate,
    "20261012",
  );
  await assert.rejects(() =>
    handlers.get("exmo:imaging:assignXrayStudy")(
      { ...event, senderFrame: { url: "https://invalid.test/" } },
      ["ap"],
      study,
    ),
  );
  await service.dispose();
  handlers = new Map();
  service = setup();
  assert.equal(
    (await call("list", "xray")).value.filter(
      (f) => f.metadata.studyAssignment?.patientId === "00042",
    ).length,
    3,
    "Assignment survives reopening",
  );
  assert.equal(
    (await call("results", "xray")).value[0].metadata.studyAssignment.patientIssuer,
    "Site",
  );
  await service.dispose();
  console.log(
    "PASS: seven partial-view combinations, ordering, identity isolation, duplicate views, pending-only analysis, legacy label applicability, IPC validation, concurrent assignments and reload persistence",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
