// Synthetic UI fixtures; no model inference or writes to the user's library.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const root = path.resolve(".");
const output = fs.mkdtempSync(path.join(root, "outputs/xray-study-ui-"));
app.setPath("userData", path.join(output, "userdata"));
if (process.env.EXMO_TEST_SOFTWARE_RENDERING === "1") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
}
const base = {
  format: "NRRD",
  caseName: "TEST_PATIENT",
  studyDescription: "SYNTHETIC UI TEST",
  seriesDescription: "Projection",
  patientId: "00042",
  patientIssuer: "TEST_SITE",
  studyDate: "20261012",
  size: [2, 2, 1],
  spacing: [1, 1, 1],
  slices: 1,
};
const views = ["LAT_LT", "AP", "LAT_RT"];
let files = [],
  results = [],
  job = null,
  runIds = [];
function input(id, route, day) {
  return {
    id,
    name: id,
    analysis: "xray",
    ready: true,
    warnings: [],
    metadata: { ...base, studyDate: day, studyUid: "study-" + day },
    classification: {
      route_to_segmentation: route,
      predicted_label: route,
      confidence: 1,
      probabilities: {},
    },
  };
}
function result(file) {
  return {
    id: "result-" + file.id,
    inputId: file.id,
    name: file.name,
    analysis: "xray",
    metadata: file.metadata,
    route: file.classification.route_to_segmentation,
    rows: [
      {
        id: "bone",
        name: "Bone",
        label: 1,
        group: "Bone",
        color: "#bbbbbb",
        value: 100,
        count: 100,
        present: true,
        fat: null,
        hu: null,
        entropy: null,
        components: null,
      },
      {
        id: "medial_thigh",
        name: "Medial thigh",
        label: file.classification.route_to_segmentation === "AP" ? 2 : 4,
        group: "All",
        color: "#55bbcc",
        value: file.classification.route_to_segmentation === "AP" ? 50 : 0,
        count: 50,
        present: true,
        fat: null,
        hu: null,
        entropy: null,
        components: null,
      },
    ],
    unit: "cm²",
    variant: "raw",
    meshBytes: null,
    laterality: null,
    qc: {
      flags: [],
      entropy: null,
      ttaDisagreement: null,
      missing: [],
      unexpected: [],
      tta: "None",
    },
    seconds: 1,
    createdAt: "2026-10-12T09:00:00Z",
  };
}
for (let mask = 7; mask >= 1; mask--) {
  for (let v = 0; v < 3; v++)
    if (mask & (1 << v)) {
      const file = input(
        "case" + mask + "-" + views[v],
        views[v],
        "202610" + String(mask).padStart(2, "0"),
      );
      files.push(file);
      results.push(result(file));
    }
}
const repeat = input("repeatAP", "AP", "20261007");
files.push(repeat);
results.push(result(repeat));
const pending = input("pendingRT", "LAT_RT", "20261001");
files.push(pending);
const orphan = input("unlinked", "AP", "");
orphan.metadata = { ...base, patientId: "", patientIssuer: "", studyDate: "" };
files.push(orphan);
const errors = [];
app.on("web-contents-created", (_, contents) =>
  contents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  }),
);
console.log("Loading Desktop");
require(path.join(root, "desktop/main.cjs"));
console.log("Waiting for Desktop ready");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeout = setTimeout(() => {
  console.error("X-ray UI check timed out");
  app.exit(1);
}, 90000);
(async () => {
  await app.whenReady();
  console.log("Desktop ready");
  const win = BrowserWindow.getAllWindows()[0];
  win.hide();
  win.setSize(1500, 1000);
  win.setPosition(80, 80);
  win.showInactive();
  win.webContents.setBackgroundThrottling(false);
  const handle = (name, fn) => {
    ipcMain.removeHandler("exmo:imaging:" + name);
    ipcMain.handle("exmo:imaging:" + name, async (_, ...args) => ({
      ok: true,
      value: await fn(...args),
    }));
  };
  handle("status", () => ({ reviewAvailable: true, estimationAvailable: true, device: "GPU" }));
  handle("list", (analysis) => (analysis === "xray" ? files : []));
  handle("results", (analysis) => (analysis === "xray" ? results : []));
  handle("job", () => job);
  handle("run", (_, ids) => {
    runIds = ids;
    job = {
      id: "test-job",
      analysis: "xray",
      state: "failed",
      current: "",
      stage: "완료",
      progress: null,
      total: ids.length,
      completed: [],
      failed: ids.map((id) => ({ id, name: id, error: "Fixture failure" })),
    };
    return job;
  });
  handle("assignXrayStudy", (ids, study) => {
    for (const f of files)
      if (ids.includes(f.id))
        f.metadata = {
          ...f.metadata,
          studyAssignment: { ...study, studyDate: study.studyDate.replaceAll("-", "") },
        };
    for (const r of results)
      if (ids.includes(r.inputId)) r.metadata = files.find((f) => f.id === r.inputId).metadata;
  });
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZA0AAAAASUVORK5CYII=";
  const preview = () => ({
    image: png,
    index: 0,
    count: 1,
    view: "projection",
    sides: [],
    metadata: base,
    warnings: [],
  });
  handle("preview", preview);
  handle("resultPreview", preview);
  if (win.webContents.isLoading())
    await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  await win.loadURL("atlas://app/");
  console.log("Desktop loaded");
  const exec = (fn, ...args) =>
    win.webContents.executeJavaScript("(" + fn + ")(" + args.map(JSON.stringify).join(",") + ")");
  const wait = async (fn) => {
    for (let i = 0; i < 150; i++) {
      if (await exec(fn)) return;
      await sleep(80);
    }
    throw Error("UI timeout: " + fn);
  };
  const click = async (text) => {
    await exec((text) => {
      const b = [...document.querySelectorAll("button")].find(
        (b) =>
          b.getClientRects().length &&
          (b.getAttribute("role") === "tab"
            ? b.textContent.trim().startsWith(text)
            : b.textContent.trim() === text),
      );
      if (!b || b.disabled) throw Error("Unavailable: " + text);
      b.click();
    }, text);
    await sleep(100);
  };
  await wait(() => document.querySelector(".protocol-table button"));
  await exec(() => document.querySelector('button[aria-label="X-ray 허벅지 근육 분석"]').click());
  await wait(() => document.querySelector(".xray-study-list tbody tr"));
  // Imported inputs start unchecked; analyzed studies are collapsed separately.
  assert.equal(await exec(() => document.querySelectorAll('.xray-study-list input:checked').length), 0);
  assert.equal(await exec(() => document.querySelector('.analysis-history-header button').getAttribute('aria-expanded')), 'false');
  await exec(() => document.querySelector('.analysis-history-header button').click());
  assert.equal(await exec(() => document.querySelectorAll('.analysis-history .study-header-row').length), 7);
  // Label folds without selecting, while right space selects the whole case.
  await exec(() => document.querySelector('.analysis-history .date-level .group-disclosure').click());
  assert.equal(await exec(() => document.querySelectorAll('.xray-study-list input:checked').length), 0);
  await exec(() => document.querySelector('.analysis-history .date-level .group-disclosure').click());
  await exec(() => {
    const buttons = document.querySelectorAll('.analysis-history .date-level .group-select-area');
    buttons[0].click();
  });
  await exec(() => {
    const buttons = document.querySelectorAll('.analysis-history .date-level .group-select-area');
    buttons[3].dispatchEvent(new MouseEvent('click', {bubbles:true, shiftKey:true}));
  });
  assert.equal(await exec(() => [...document.querySelectorAll('.analysis-history .date-level > input')].slice(0,4).every(i=>i.checked)), true);
  // Filtered range/select-all does not silently include unmatched images.
  await exec(() => {
    const input = document.querySelector('.xray-workspace .clinical-search');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'pendingRT');
    input.dispatchEvent(new Event('input', {bubbles:true}));
  });
  await wait(() => document.querySelectorAll('.xray-study-list tr[data-input-id]').length === 1);
  await exec(() => document.querySelector('.xray-study-list thead input').click());
  assert.equal(await exec(() => document.querySelector('tr[data-input-id="pendingRT"] input').checked), true);
  await exec(() => {
    const input = document.querySelector('.xray-workspace .clinical-search');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
    input.dispatchEvent(new Event('input', {bubbles:true}));
  });
  await exec(() => document.querySelector('.xray-study-list thead input').click());
  await click("선택 영상 검토");
  await wait(() => document.querySelectorAll('.xray-projections article').length === 15);
  assert.equal(await exec(() => [...document.querySelectorAll('.grouped-review .group-disclosure')].every(b => b.getAttribute('aria-expanded') === 'true')), true);
  assert.equal(await exec(() => document.querySelectorAll('.grouped-review input:checked').length), 0);
  assert.deepEqual(await exec(() => [...document.querySelectorAll('.xray-projections')[0].querySelectorAll('.xray-direction-column')].map(e=>e.dataset.view)), views);
  assert.equal(await exec(() => document.querySelectorAll('.xray-projections')[0].querySelectorAll('[data-view="AP"] article').length), 2, 'Repeated projections are all visible');
  assert.ok(await exec(() => document.querySelectorAll('.xray-missing-view').length));
  await click('분석 가능한 영상 전체 선택');
  assert.deepEqual((await exec(() => [...document.querySelectorAll('.review-case[data-selected="true"]')].map(e=>e.dataset.inputId))).sort(), ['pendingRT','unlinked']);
  await exec(() => document.querySelector('.review-case[data-input-id="pendingRT"] input').click());
  assert.equal(await exec(() => document.querySelectorAll('.xray-projections article').length), 15, 'Unchecking never removes review cards');
  await exec(() => document.querySelector('.grouped-review .date-level .group-disclosure').click());
  await click('영상·Series');
  await click('선택 영상 검토');
  assert.equal(await exec(() => [...document.querySelectorAll('.grouped-review .group-disclosure')].every(b => b.getAttribute('aria-expanded') === 'true')), true, 'Review reentry expands all groups');
  await exec(() => [...document.querySelectorAll('.review-case[data-input-id="case7-AP"] button')].find(b=>b.textContent === '재분석 선택').click());
  assert.equal(await exec(() => document.querySelector('.review-case[data-input-id="case7-AP"] input').checked), true);
  await exec(() => [...document.querySelectorAll('.review-case[data-input-id="case7-AP"] button')].find(b=>b.textContent === '재분석 선택 취소').click());
  await click('선택 해제');
  await exec(() => [...document.querySelectorAll('.review-case[data-input-id="case7-AP"] button')].find(b=>b.textContent === '재분석 선택').click());
  await click('선택 영상 분석 (1개)');
  assert.deepEqual(runIds, ['case7-AP'], 'Reanalysis requires explicit selection and sends exactly that projection');
  assert.equal(results.length, 13, 'Existing result versions are retained');
  await click('분석 가능한 영상 전체 선택');
  await sleep(400);
  fs.writeFileSync(path.join(output,'review-all-studies.png'), (await win.webContents.capturePage(undefined, {stayHidden:true, stayAwake:true})).toPNG());
  await click("분석 결과");
  assert.equal(
    await exec(() => document.querySelectorAll(".xray-workspace .results-list tbody tr").length),
    7,
  );
  for (let mask = 7; mask >= 1; mask--) {
    await exec((mask) => {
      const rows = [...document.querySelectorAll(".xray-workspace .results-list tbody tr")];
      rows
        .find((r) => r.textContent.includes("202610" + String(mask).padStart(2, "0")))
        .querySelector("button")
        .click();
    }, mask);
    await wait(() => document.querySelector(".xray-result-workspace .case-canvas"));
    const expected = views.filter((_, index) => mask & (1 << index));
    assert.equal(
      await exec(() => document.querySelectorAll(".xray-result-workspace .case-canvas").length),
      expected.length,
    );
    assert.deepEqual(
      await exec(() =>
        [...document.querySelectorAll(".case-canvas .case-title span:first-of-type")].map(
          (e) => e.textContent.split(" · ")[0],
        ),
      ),
      expected,
    );
    if (mask === 7) {
      assert.equal(
        await exec(() => document.querySelectorAll(".xray-result-controls select").length),
        1,
      );
      assert.equal(
        await exec(() =>
          [...document.querySelectorAll('tr[data-structure="medial_thigh"] td')]
            .slice(1)
            .map((e) => e.textContent)
            .join("|"),
        ),
        "해당 없음|50.0|해당 없음",
      );
      fs.writeFileSync(
        path.join(output, "three-views.png"),
        (await win.webContents.capturePage(undefined, {stayHidden:true, stayAwake:true})).toPNG(),
      );
    }
    await click("← 결과 목록으로");
  }
  await exec(() => {
    const rows = [...document.querySelectorAll(".xray-workspace .results-list tbody tr")];
    for (const date of ["20261007", "20261002"])
      rows.find((r) => r.textContent.includes(date)).click();
  });
  await click("선택 검사 비교 (2/3)");
  await wait(() => document.querySelectorAll(".case-canvas").length === 2);
  await exec(() =>
    [...document.querySelectorAll(".xray-result-controls button")]
      .find((b) => b.textContent === "LT")
      .click(),
  );
  await wait(() => document.querySelectorAll(".case-canvas").length === 1);
  assert(
    (await exec(() => document.querySelector(".xray-result-controls").textContent)).includes(
      "비교 영상 없음",
    ),
  );
  await click("← 결과 목록으로");
  await click("선택 영상 검토");
  await click("선택 영상 분석 (2개)");
  assert.deepEqual([...runIds].sort(), ["pendingRT", "unlinked"]);
  await wait(() =>
    [...document.querySelectorAll("button")].some((b) => b.textContent === "실패한 영상만 재시도"),
  );
  await click("실패한 영상만 재시도");
  assert.deepEqual([...runIds].sort(), ["pendingRT", "unlinked"]);
  // Publish one completed projection while another still runs: it must join its existing study.
  const added = result(pending);
  results.push(added);
  job = {
    ...job,
    state: "running",
    completed: [added],
    failed: [],
    active: [
      { id: "unlinked", name: "unlinked", stage: "Segmentation", progress: 20, lane: "gpu" },
    ],
  };
  await click("분석 결과");
  await wait(() =>
    [...document.querySelectorAll(".xray-workspace .results-list tbody tr")].some(
      (r) => r.textContent.includes("20261001") && r.textContent.includes("RT · 완료"),
    ),
  );
  await exec(() =>
    [...document.querySelectorAll(".xray-workspace .results-list tbody tr")]
      .find((r) => r.textContent.includes("20261001"))
      .querySelector("button")
      .click(),
  );
  await wait(() => document.querySelectorAll(".case-canvas").length === 2);
  job = { ...job, state: "complete", active: [] };
  await click("← 결과 목록으로");
  // Home displays grouped studies, then reopens all views of the selected study.
  await exec(() => document.querySelector(".desktop-brand").click());
  await wait(() => document.querySelector(".recent-section tbody tr"));
  assert.equal(await exec(() => document.querySelectorAll(".recent-section tbody tr").length), 7);
  await exec(() =>
    [...document.querySelectorAll(".recent-section tbody tr")]
      .find((r) => r.textContent.includes("20261007"))
      .click(),
  );
  await wait(
    () => document.querySelectorAll(".desktop-workspace:not([hidden]) .case-canvas").length === 3,
  );
  await click("← 결과 목록으로");
  await exec(() => document.querySelector(".desktop-brand").click());
  await wait(() => document.querySelector(".recent-section tbody tr"));
  await exec(() =>
    [...document.querySelectorAll(".recent-section tbody tr")]
      .find((r) => r.textContent.includes("20261007"))
      .click(),
  );
  await wait(
    () => document.querySelectorAll(".desktop-workspace:not([hidden]) .case-canvas").length === 3,
  );
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "row selection",
          "LT/AP/RT review order",
          "7 partial combinations",
          "duplicate view selector",
          "not-applicable metrics",
          "same-view comparison with missing view",
          "completed input exclusion",
          "failed retry",
          "early result joins study",
          "grouped recent results and reopening",
        ],
        inferenceRun: false,
      },
      null,
      2,
    ),
  );
  console.log("PASS: X-ray study Desktop interaction checks. " + output);
  clearTimeout(timeout);
  app.exit(0);
})().catch((error) => {
  console.error(error);
  console.error(errors);
  clearTimeout(timeout);
  app.exit(1);
});
