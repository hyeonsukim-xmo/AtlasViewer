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
    for (const analysis of ["ct", "mri", "xray"]) {
      const parent = path.join(fixtures.directory, `multi-folder-${analysis}`);
      const first = path.join(parent, "first", "nested");
      const second = path.join(parent, "second");
      await fsp.mkdir(first, {recursive: true});
      await fsp.mkdir(second, {recursive: true});
      await fsp.copyFile(fixtures[analysis], path.join(first, "images.zip"));
      // Distinct patient/series IDs: copying identical DICOMs would test duplicate
      // slices in one series rather than multiple studies selected together.
      require("node:child_process").execFileSync(path.join(engineRoot, "envs/ct/Scripts/python.exe"), ["-c", `
import io, sys, zipfile, pydicom
from pydicom.uid import generate_uid
uids = {}
with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], 'w') as target:
    for name in source.namelist():
        if name.endswith('/') or name == 'DICOMDIR': continue
        ds = pydicom.dcmread(io.BytesIO(source.read(name)))
        for key in ['StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID', 'FrameOfReferenceUID']:
            if key in ds:
                old = str(ds.get(key))
                ds[key].value = uids.setdefault(old, generate_uid())
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
        ds.PatientID = 'MULTI_FOLDER_SECOND'
        buffer = io.BytesIO()
        ds.save_as(buffer, enforce_file_format=True)
        target.writestr(name, buffer.getvalue())
`, fixtures[analysis], path.join(second, "images.zip")]);
      choices = [path.dirname(first), second];
      const multiple = await call("choose", analysis, true, "en");
      assert.equal(multiple.ok, true, multiple.error);
      const expected = analysis === "xray" ? 6 : 4;
      assert.equal(multiple.value.length, expected, "Every selected directory is imported");
      assert(multiple.value.some(row => row.metadata.patientId === "MULTI_FOLDER_SECOND"));
      if (analysis !== "xray") assert(multiple.value.every(row => row.ready));
      assert(dialogs.at(-1).properties.includes("openDirectory"));
      assert(dialogs.at(-1).properties.includes("multiSelections"));
      choices = [first, parent, second, parent];
      const overlapping = await call("choose", analysis, true, "en");
      assert.equal(overlapping.ok, true, overlapping.error);
      assert.equal(overlapping.value.length, expected, "Parent/child selections are collected once");
      if (analysis !== "xray") assert(overlapping.value.every(row => row.ready));
      console.log(analysis.toUpperCase() + ": multiple and overlapping folders passed");
    }
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
