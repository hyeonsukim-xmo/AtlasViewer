// Real importer/Python worker with only the native picker and Electron IPC substituted.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "..");
const fixtures = JSON.parse(
  fs.readFileSync(path.join(root, "outputs/zip-import-fixtures.json"), "utf8"),
);
const engineRoot = path.resolve(process.argv[2] || path.join(root, "work/modality-integration"));
const storageRoot = fs.mkdtempSync(path.join(fixtures.directory, "library-"));
const handlers = new Map(),
  progress = [],
  dialogs = [];
let choices = [];
const frame = { url: "atlas://app/" };
const window = { webContents: { mainFrame: frame, send: (_, value) => progress.push(value) } };
const event = { sender: window.webContents, senderFrame: frame };
const electron = {
  dialog: {
    showOpenDialog: async (_, options) => {
      dialogs.push(options);
      return { canceled: false, filePaths: choices };
    },
  },
  ipcMain: {
    handle: (key, fn) => handlers.set(key, fn),
    removeHandler: (key) => handlers.delete(key),
  },
};
const localRequire = createRequire(path.join(root, "desktop/imaging.cjs"));
const context = {
  module: { exports: {} },
  require: (name) => (name === "electron" ? electron : localRequire(name)),
  process,
  console,
  setTimeout,
  clearTimeout,
  URL,
  AbortController,
};
vm.runInNewContext(fs.readFileSync(path.join(root, "desktop/imaging.cjs"), "utf8"), context);
const backend = context.module.exports.installImaging(window, {
  engineRoot,
  storageRoot,
  scriptsRoot: path.join(root, "desktop"),
  palette: path.join(root, "dist-desktop/imaging-palette.json"),
});
const call = (name, ...args) => handlers.get("exmo:imaging:" + name)(event, ...args);
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
(async () => {
  const originals = Object.fromEntries(
    ["ct", "mri", "xray", "broken"].map((a) => [a, digest(fixtures[a])]),
  );
  try {
    for (const analysis of ["ct", "mri", "xray"]) {
      choices = [fixtures[analysis]];
      const reply = await call("choose", analysis, false, "en");
      assert.equal(reply.ok, true, reply.error);
      assert.equal(reply.value.length, analysis === "xray" ? 3 : 2);
      assert(
        reply.value.every((r) => r.metadata),
        JSON.stringify(reply.value),
      );
      assert(
        reply.value.every((r) => !Object.hasOwn(r, "input")),
        "Private paths do not cross IPC",
      );
      if (analysis === "xray") {
        assert(
          reply.value.every(
            (r) => r.metadata.patientId === "00042" && r.metadata.studyDate === "20261013",
          ),
        );
        assert(
          reply.value.every((r) => !r.ready),
          "ZIP does not bypass DICOM segmentation validation",
        );
      } else {
        assert(
          reply.value.every((r) => r.ready),
          JSON.stringify(reply.value),
        );
        assert(reply.value.every((r) => r.metadata.size[2] === 3));
      }
      assert(dialogs.at(-1).filters[0].extensions.includes("zip"));
      console.log(
        analysis.toUpperCase() + ": ZIP -> real Python inspection -> persisted records passed",
      );
    }
    const folder = path.join(fixtures.directory, "folder-input", "nested");
    await fsp.mkdir(folder, { recursive: true });
    await fsp.copyFile(fixtures.ct, path.join(folder, "ct.zip"));
    choices = [path.dirname(folder)];
    const folderReply = await call("choose", "ct", true, "en");
    assert.equal(folderReply.ok, true, folderReply.error);
    assert.equal(folderReply.value.length, 2);
    assert(folderReply.value.every((r) => r.ready));
    const saved = await fsp.readFile(path.join(storageRoot, "library.json"), "utf8");
    choices = [fixtures.broken];
    const bad = await call("choose", "ct", false, "en");
    assert.equal(bad.ok, false);
    assert.equal(
      await fsp.readFile(path.join(storageRoot, "library.json"), "utf8"),
      saved,
      "Bad ZIP preserves the library",
    );
    assert(progress.some((p) => p.phase === "extract"));
    assert.equal((await call("status", "ct")).value.importProgress, null);
    for (const directory of await fsp.readdir(path.join(storageRoot, "imports"))) {
      assert(!fs.existsSync(path.join(storageRoot, "imports", directory, "extracted")));
      assert(!fs.existsSync(path.join(storageRoot, "imports", directory, "snapshots")));
    }
    for (const [key, hash] of Object.entries(originals)) assert.equal(digest(fixtures[key]), hash);
    fs.writeFileSync(
      path.join(fixtures.directory, "integration-report.json"),
      JSON.stringify(
        {
          passed: true,
          modalities: ["ct", "mri", "xray"],
          segmentationRun: false,
          originalsUnchanged: true,
          failedArchivePreservesLibrary: true,
          temporaryFilesRemoved: true,
        },
        null,
        2,
      ),
    );
    console.log(
      "PASS: CT/MRI/X-ray ZIP import, progress, original integrity, cleanup and existing-library preservation",
    );
  } finally {
    await backend.dispose();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
