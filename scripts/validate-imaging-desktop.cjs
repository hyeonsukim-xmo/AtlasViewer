// Real Electron/preload/IPC/worker. Only the native file picker is substituted.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { app, BrowserWindow, dialog } = require("electron");
const root = path.resolve(".");
const output = path.resolve(process.env.EXMO_VALIDATION_OUTPUT || path.join(root, "outputs/imaging-check"));
fs.mkdirSync(output, { recursive: true });
const appRoot = path.resolve(process.argv[2] || ".");
app.setPath("userData", process.env.EXMO_VALIDATION_USER_DATA || path.join(output, "userdata"));
process.env.EXMO_ENGINE_ROOT ||= path.join(root, "work/modality-integration");
const imagingStore = path.join(app.getPath("userData"), "imaging");
const original = path.join(
  process.env.EXMO_ENGINE_ROOT,
  "packages/EXMO_XRAY/samples/AP/AP_01/input.nrrd",
);
const hash = () => createHash("sha256").update(fs.readFileSync(original)).digest("hex");
const originalHash = hash();
const protectedSources = new Map();
for (const name of fs.readdirSync(path.join(imagingStore, "runs"))) {
  const file = path.join(imagingStore, "runs", name, "published.json");
  if (!fs.existsSync(file)) continue;
  const publication = JSON.parse(fs.readFileSync(file, "utf8"));
  if (publication.summary.analysis === "xray") continue;
  for (const source of [
    publication.mask,
    ...[
      "raw/mask.nrrd",
      "raw/metrics.json",
      "pp500/mask.nrrd",
      "pp500/metrics.json",
      "entropy.nrrd",
      "qc.json",
    ].map((p) => path.join(publication.result, p)),
  ])
    if (fs.existsSync(source))
      protectedSources.set(
        source,
        createHash("sha256").update(fs.readFileSync(source)).digest("hex"),
      );
}
let picker = [];
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: picker });
const errors = [];
app.on("web-contents-created", (_, contents) =>
  contents.on("console-message", (_, details) => {
    if (details.level === "error") errors.push(details.message);
  }),
);
require(path.join(appRoot, "desktop/main.cjs"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = setTimeout(() => {
  console.error("Imaging validation timed out");
  app.exit(1);
}, 15 * 60000);
(async () => {
  await app.whenReady();
  const window = BrowserWindow.getAllWindows()[0],
    contents = window.webContents;
  if (contents.isLoading())
    await new Promise((resolve) => contents.once("did-finish-load", resolve));
  const run = (fn, ...args) =>
    contents.executeJavaScript(`(${fn})(${args.map((v) => JSON.stringify(v)).join(",")})`);
  async function wait(fn, seconds = 60) {
    for (let i = 0; i < seconds * 5; i++) {
      if (await run(fn)) return;
      await sleep(200);
    }
    throw new Error("UI timeout: " + fn);
  }
  const click = (text) =>
    run((text) => {
      const button = [...document.querySelectorAll("button")].find(
        (b) =>
          (b.getAttribute("role") === "tab"
            ? b.textContent.trim().startsWith(text)
            : b.textContent.trim() === text) && b.getClientRects().length,
      );
      if (!button || button.disabled) throw new Error("Button unavailable: " + text);
      button.click();
    }, text);
  async function capture(name) {
    await sleep(600);
    fs.writeFileSync(path.join(output, name + ".png"), (await contents.capturePage()).toPNG());
  }
  async function checkLaterality(analysis) {
    await wait(
      () =>
        ![...document.querySelectorAll(".desktop-workspace:not([hidden]) button")].find(
          (b) => b.textContent === "3D anatomy",
        )?.disabled,
      360,
    );
    const saved = await run(
      async (analysis) => (await window.exmoDesktop.results(analysis)).value,
      analysis,
    );
    for (const result of saved.filter((r) => r.laterality?.method)) {
      assert.equal(result.laterality.method, "femur_components_lps_v1");
      assert.ok(
        result.parts.some((part) => part.side === "left") &&
          result.parts.some((part) => part.side === "right"),
      );
      assert.ok(
        !result.mask && !result.sideMask && !result.result,
        "Private side map must not cross IPC",
      );
      for (const row of result.rows) {
        assert.equal(
          row.sides.left.count + row.sides.right.count + row.sides.unassigned.count,
          row.count,
        );
        assert.ok(
          Math.abs(
            row.sides.left.value + row.sides.right.value + row.sides.unassigned.value - row.value,
          ) < 1e-6,
        );
        if (row.sides.unassigned.count || !row.sides.left.count || !row.sides.right.count)
          assert.equal(row.sides.differencePercent, null);
        for (const part of result.parts.filter((part) => part.structureId === row.id))
          assert.equal(part.color, row.color);
      }
    }
    await capture(analysis + "-laterality-metrics");
    const tableLayout = await run(() => {
      const panel = document.querySelector(".desktop-workspace:not([hidden]) .metrics-panel");
      return {
        extraControls: !!panel.querySelector(
          "tbody input, tbody .bilateral-values, .laterality-controls",
        ),
        rows: [...panel.querySelectorAll("tbody tr")].map((row) => ({
          name: row.dataset.structure,
          height: row.getBoundingClientRect().height,
        })),
      };
    });
    assert.ok(
      !tableLayout.extraControls && tableLayout.rows.every((row) => row.height < 85),
      "Metrics stay compact: " + JSON.stringify(tableLayout),
    );
  }
  await wait(() => document.querySelector(".protocol-table"));
  assert.equal(await run(() => typeof window.require), "undefined");
  assert.equal(
    await run(() => document.body.textContent.includes("어떤 영상으로 분석할까요")),
    false,
  );
  await capture("catalog");
  await run(() => document.querySelector(".protocol-table tbody tr td:nth-child(2)").click());
  await wait(() =>
    document.querySelector(".desktop-workspace:not([hidden]) .series-table tbody tr"),
  );
  await wait(
    () => document.querySelector(".desktop-workspace:not([hidden]) .medical-image img"),
    120,
  );
  await capture("ct-series");
  const ct = await run(async () => (await window.exmoDesktop.list("ct")).value[0]);
  assert.ok(
    ct.ready && !ct.input && !ct.path,
    "Renderer receives opaque input IDs, not private paths",
  );
  const views = await run(async (id) => {
    const result = [];
    for (const view of ["axial", "coronal", "sagittal"]) {
      const reply = await window.exmoDesktop.preview("ct", id, { view, index: 1 });
      if (!reply.ok) throw new Error(reply.error);
      result.push({
        view,
        count: reply.value.count,
        index: reply.value.index,
        sides: reply.value.sides,
      });
    }
    return result;
  }, ct.id);
  assert.ok(views.every((v) => v.count > 1 && v.index === 1 && v.sides.length === 4));
  assert.equal((await run(async (id) => window.exmoDesktop.preview("mri", id), ct.id)).ok, false);
  assert.equal(
    (await run(async (id) => window.exmoDesktop.preview("ct", id, { index: -1 }), ct.id)).ok,
    false,
  );
  await click("분석 결과");
  await run(() =>
    document
      .querySelector(".desktop-workspace:not([hidden]) .results-list tbody tr td:nth-child(3)")
      .click(),
  );
  await wait(() =>
    document.querySelector(".desktop-workspace:not([hidden]) .results-list input:checked"),
  );
  assert.equal(
    await run(() => !!document.querySelector(".desktop-workspace:not([hidden]) .result-workspace")),
    false,
    "Comparison row selects without opening the result",
  );
  await click("결과 열기");
  await wait(() => document.querySelector(".result-workspace .medical-image img"));
  await checkLaterality("ct");
  const initialSlice = await run(() =>
    Number(document.querySelector('input[aria-label="Slice"]').value),
  );
  const imageRect = await run(() => {
    const r = document.querySelector(".result-workspace .medical-image").getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  contents.sendInputEvent({ type: "mouseDown", button: "middle", clickCount: 1, ...imageRect });
  contents.sendInputEvent({
    type: "mouseMove",
    x: imageRect.x,
    y: imageRect.y + 40,
    modifiers: ["middleButtonDown"],
  });
  contents.sendInputEvent({
    type: "mouseUp",
    button: "middle",
    clickCount: 1,
    x: imageRect.x,
    y: imageRect.y + 40,
  });
  await sleep(400);
  assert.equal(
    await run(() => Number(document.querySelector('input[aria-label="Slice"]').value)),
    initialSlice + 10,
    "Middle drag scrolls the hovered viewport",
  );
  contents.sendInputEvent({ type: "mouseMove", x: imageRect.x, y: imageRect.y + 80 });
  await sleep(200);
  assert.equal(
    await run(() => Number(document.querySelector('input[aria-label="Slice"]').value)),
    initialSlice + 10,
    "Released drag must stop",
  );
  await capture("ct-result-overlay");
  contents.sendInputEvent({ type: "mouseWheel", ...imageRect, deltaY: -120, deltaX: 0 });
  await sleep(500);
  assert.notEqual(
    await run(() => Number(document.querySelector('input[aria-label="Slice"]').value)),
    initialSlice + 10,
    "Mouse wheel scrolls the actual image viewport",
  );
  await click("3D anatomy");
  await wait(
    () =>
      document.querySelector(".result-scene canvas") && !document.querySelector(".scene-loading"),
    120,
  );
  await run(() =>
    [...document.querySelectorAll(".metric-name")]
      .find((b) => b.textContent.includes("rectus femoris"))
      .click(),
  );
  await sleep(500);
  await capture("ct-real-3d");
  assert.equal(
    await run(() => document.querySelector(".result-workspace").textContent.includes("Demo data")),
    false,
  );
  await click("Explode anatomy");
  await sleep(1900);
  await capture("ct-real-explode");
  window.setSize(900, 660);
  await sleep(700);
  assert.ok(
    await run(() => document.documentElement.scrollWidth <= innerWidth + 1),
    "No horizontal page overflow",
  );
  await capture("compact-result");
  window.setSize(1440, 960);
  await sleep(400);
  await run(() => document.querySelector(".desktop-brand").click());
  await run(() => document.querySelector('button[aria-label="MRI 허벅지 근육 분석"]').click());
  await wait(() =>
    document.querySelector(".desktop-workspace:not([hidden]) .series-table tbody tr"),
  );
  await click("분석 결과");
  await run(() =>
    [
      ...document.querySelectorAll(
        '.desktop-workspace:not([hidden]) .results-list input[type="checkbox"]',
      ),
    ]
      .slice(0, 3)
      .forEach((input) => input.click()),
  );
  await click("선택 검사 비교 (3/3)");
  await wait(
    () =>
      document.querySelectorAll(".desktop-workspace:not([hidden]) .case-canvas img").length === 3,
  );
  await checkLaterality("mri");
  const palettes = await run(async () => ({
    ct: (await window.exmoDesktop.results("ct")).value[0].rows,
    mri: (await window.exmoDesktop.results("mri")).value[0].rows,
  }));
  for (const row of palettes.ct) {
    const peer = palettes.mri.find((r) => r.id === row.id);
    if (peer) assert.equal(row.color, peer.color, row.id + " must use MRI's color");
  }
  assert.ok(
    await run(() =>
      [
        ...document.querySelectorAll(".desktop-workspace:not([hidden]) .metric-table tbody tr"),
      ].every((r) => r.cells.length === 4),
    ),
    "Metrics show all three case columns",
  );
  await capture("mri-comparison-metrics");
  await click("QC·후처리");
  assert.ok(
    await run(() =>
      [...document.querySelectorAll(".desktop-workspace:not([hidden]) .qc-table tbody tr")].every(
        (r) => r.cells.length === 4,
      ),
    ),
    "QC shows all three case columns",
  );
  await capture("mri-comparison-qc");
  window.setSize(900, 660);
  await sleep(350);
  assert.ok(
    await run(() => {
      const panel = document.querySelector(".desktop-workspace:not([hidden]) .metric-scroll");
      return (
        panel.scrollWidth <= panel.clientWidth + 1 &&
        document.documentElement.scrollWidth <= innerWidth + 1
      );
    }),
    "All QC columns fit the comparison panel at compact width",
  );
  await capture("mri-compact-qc");
  window.setSize(1440, 960);
  await sleep(300);
  await click("측정값");
  await click("3D anatomy");
  await wait(
    () =>
      document.querySelectorAll(".desktop-workspace:not([hidden]) .result-scene canvas").length ===
        3 && !document.querySelector(".desktop-workspace:not([hidden]) .scene-loading"),
    120,
  );
  await capture("mri-3case-comparison");
  // Real canvas click in a peer case must select immediately across all three views.
  const peerRect = await run(() => {
    const r = document
      .querySelectorAll(".desktop-workspace:not([hidden]) .result-scene canvas")[1]
      .getBoundingClientRect();
    return {
      x: Math.ceil(r.x),
      y: Math.ceil(r.y),
      width: Math.floor(r.width) - 2,
      height: Math.floor(r.height) - 2,
    };
  });
  const assembled = await contents.capturePage(peerRect),
    assembledPixels = assembled.toBitmap(),
    assembledSize = assembled.getSize();
  let clickPoint;
  for (
    let y = Math.round(assembledSize.height * 0.6);
    y < assembledSize.height * 0.85 && !clickPoint;
    y += 4
  )
    for (let x = Math.round(assembledSize.width * 0.25); x < assembledSize.width * 0.75; x += 4) {
      const at = (y * assembledSize.width + x) * 4;
      if (Math.max(assembledPixels[at], assembledPixels[at + 1], assembledPixels[at + 2]) > 150) {
        clickPoint = {
          x: Math.round(peerRect.x + (x / assembledSize.width) * peerRect.width),
          y: Math.round(peerRect.y + (y / assembledSize.height) * peerRect.height),
        };
        break;
      }
    }
  assert.ok(clickPoint, "Assembled peer muscle visible");
  contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...clickPoint });
  contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...clickPoint });
  await sleep(350);
  assert.equal(
    await run(
      () =>
        document.querySelectorAll(
          '.desktop-workspace:not([hidden]) tr[data-structure][aria-selected="true"]',
        ).length,
    ),
    1,
    "First peer click selects the structure, not only its case",
  );
  assert.ok(
    await run(() =>
      [...document.querySelectorAll(".desktop-workspace:not([hidden]) .case-title")].every(
        (b) => b.querySelectorAll("span").length === 2,
      ),
    ),
    "Clicked and peer views share the selection",
  );
  await capture("mri-assembled-shared-selection");
  await click("Explode anatomy");
  await sleep(1900);
  await capture("mri-all-exploded");
  await run(() =>
    [...document.querySelectorAll(".desktop-workspace:not([hidden]) .metric-name")]
      .find((b) => b.textContent.includes("rectus femoris"))
      .click(),
  );
  await sleep(2000);
  await capture("mri-matched-structure");
  const rectangles = await run(() =>
    [...document.querySelectorAll(".desktop-workspace:not([hidden]) .result-scene canvas")].map(
      (canvas) => {
        const r = canvas.getBoundingClientRect();
        return {
          x: Math.ceil(r.x),
          y: Math.ceil(r.y),
          width: Math.floor(r.width) - 2,
          height: Math.floor(r.height) - 2,
        };
      },
    ),
  );
  contents.sendInputEvent({ type: "mouseMove", x: 10, y: 10 });
  await sleep(300);
  const peerImage = await contents.capturePage(rectangles[1]);
  const bitmap = peerImage.toBitmap(),
    size = peerImage.getSize();
  let point;
  for (let y = Math.round(size.height * 0.3); y < size.height * 0.75 && !point; y += 4)
    for (let x = Math.round(size.width * 0.15); x < size.width * 0.85; x += 4) {
      const at = (y * size.width + x) * 4;
      if (Math.max(bitmap[at], bitmap[at + 1], bitmap[at + 2]) > 100) {
        point = {
          x: Math.round(rectangles[1].x + (x / size.width) * rectangles[1].width),
          y: Math.round(rectangles[1].y + (y / size.height) * rectangles[1].height),
        };
        break;
      }
    }
  assert.ok(point, "Matched peer structure is visible");
  contents.sendInputEvent({ type: "mouseMove", ...point });
  await wait(() => document.querySelector('.actual-laterality [data-primary="true"]'));
  await run(() => {
    const tooltip = document.querySelector(".actual-laterality");
    const primary = tooltip.querySelector('[data-primary="true"]');
    const side = primary.textContent.includes("Left") ? "Left" : "Right";
    if (!tooltip.querySelector("p").textContent.includes(side === "Left" ? "좌측" : "우측"))
      throw new Error("Hover patient side must match its primary measurement");
    if (primary !== tooltip.querySelector(".bilateral-values > div"))
      throw new Error("Hovered side must be the first measurement");
  });
  await capture("mri-laterality-hover");
  contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
  contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
  contents.sendInputEvent({ type: "mouseMove", x: 10, y: 10 });
  await sleep(2000);
  assert.equal(
    await run(
      () =>
        document.querySelectorAll(
          '.desktop-workspace:not([hidden]) tr[data-structure][aria-selected="true"]',
        ).length,
    ),
    0,
    "Clicking either side deselects the whole class, never selects an individual side",
  );
  await run(() =>
    document
      .querySelector(
        '.desktop-workspace:not([hidden]) tr[data-structure="rectus_femoris"] td:last-child',
      )
      .click(),
  );
  await sleep(1900);
  assert.ok(
    await run(() =>
      [...document.querySelectorAll(".desktop-workspace:not([hidden]) .case-title")].every(
        (title) =>
          title.textContent.includes("rectus femoris ·") &&
          !/rectus femoris · (Left|Right)/.test(title.textContent),
      ),
    ),
    "Both sides are selected as one class across cases",
  );
  await capture("mri-paired-selection");
  await run(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await sleep(500);
  const firstBefore = (await contents.capturePage(rectangles[0])).toPNG();
  const peerBefore = await contents.capturePage(rectangles[1]);
  // The class is selected: right-drag in the gap must rotate the entire pair.
  point = {
    x: Math.round(rectangles[1].x + rectangles[1].width / 2),
    y: Math.round(rectangles[1].y + rectangles[1].height / 2),
  };
  const halves = [0, 1].map((half) => ({
    ...rectangles[1],
    x: rectangles[1].x + half * Math.floor(rectangles[1].width / 2),
    width: Math.floor(rectangles[1].width / 2),
  }));
  const halvesBefore = await Promise.all(
    halves.map(async (rect) => (await contents.capturePage(rect)).toPNG()),
  );
  contents.sendInputEvent({ type: "mouseDown", button: "right", clickCount: 1, ...point });
  contents.sendInputEvent({
    type: "mouseMove",
    x: point.x + 35,
    y: point.y + 25,
    modifiers: ["rightButtonDown"],
  });
  contents.sendInputEvent({
    type: "mouseUp",
    button: "right",
    clickCount: 1,
    x: point.x + 35,
    y: point.y + 25,
  });
  contents.sendInputEvent({ type: "mouseMove", x: 10, y: 10 });
  await sleep(400);
  const firstAfter = (await contents.capturePage(rectangles[0])).toPNG();
  if (!firstBefore.equals(firstAfter)) {
    fs.writeFileSync(path.join(output, "rotation-first-before.png"), firstBefore);
    fs.writeFileSync(path.join(output, "rotation-first-after.png"), firstAfter);
  }
  assert.ok(firstBefore.equals(firstAfter), "Peer rotation must not rotate the active case");
  assert.ok(
    !peerBefore.toPNG().equals((await contents.capturePage(rectangles[1])).toPNG()),
    "Right drag rotates the peer structure independently",
  );
  for (let half = 0; half < 2; half++)
    assert.ok(
      !halvesBefore[half].equals((await contents.capturePage(halves[half])).toPNG()),
      "Both sides of the paired structure must rotate",
    );
  await capture("mri-independent-rotation");
  const nextVariant = await run(() => {
    const select = document.querySelector(
      '.desktop-workspace:not([hidden]) select[aria-label$="MRI 결과 variant"]',
    );
    const variant = select.value === "pp500" ? "raw" : "pp500";
    select.value = variant;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return variant.toUpperCase();
  });
  await wait(
    () =>
      !document.querySelector(
        '.desktop-workspace:not([hidden]) select[aria-label$="MRI 결과 variant"]',
      ).disabled,
    120,
  );
  assert.equal(
    await run(() =>
      document
        .querySelector('.desktop-workspace:not([hidden]) select[aria-label$="MRI 결과 variant"]')
        .value.toUpperCase(),
    ),
    nextVariant,
  );
  await click("Assemble");
  await sleep(1900);
  await capture("mri-all-assembled");
  await click("Overlay & metrics");
  await wait(
    () =>
      document.querySelectorAll(".desktop-workspace:not([hidden]) .case-canvas img").length === 3,
  );
  const strongCheck = await run(async () => {
    const result = (await window.exmoDesktop.results("mri")).value.find(
      (r) => r.name === "sample_02",
    );
    const selects = [
      ...document.querySelectorAll(
        '.desktop-workspace:not([hidden]) select[aria-label$="MRI 결과 variant"]',
      ),
    ];
    const select = selects.find((s) =>
      s.getAttribute("aria-label").startsWith(result.metadata.caseName),
    );
    const card = [
      ...document.querySelectorAll(".desktop-workspace:not([hidden]) .case-canvas"),
    ].find((c) => c.querySelector("strong").textContent === result.metadata.caseName);
    const coronal = [...card.querySelectorAll("button")].find((b) => b.textContent === "Coronal");
    coronal.click();
    return { id: result.id, qc: result.qc.ttaDisagreement };
  });
  await wait(() =>
    [...document.querySelectorAll(".desktop-workspace:not([hidden]) .case-canvas")]
      .find((c) => c.querySelector("strong").textContent === "sample_02")
      ?.querySelector("img")
      ?.alt.startsWith("coronal"),
  );
  const preservedSlice = await run(
    () =>
      [...document.querySelectorAll(".desktop-workspace:not([hidden]) .case-canvas")]
        .find((c) => c.querySelector("strong").textContent === "sample_02")
        .querySelector("img").alt,
  );
  await run(() => {
    const s = document.querySelector(
      '.desktop-workspace:not([hidden]) select[aria-label="sample_02 MRI 결과 variant"]',
    );
    s.value = "strong";
    s.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await wait(
    () =>
      !document.querySelector(
        '.desktop-workspace:not([hidden]) select[aria-label="sample_02 MRI 결과 variant"]',
      ).disabled,
    180,
  );
  const strong = await run(
    async (id) => (await window.exmoDesktop.results("mri")).value.find((r) => r.id === id),
    strongCheck.id,
  );
  assert.equal(strong.variant, "strong");
  assert.equal(
    strong.qc.ttaDisagreement,
    strongCheck.qc,
    "PP must not fake a lower TTA disagreement",
  );
  assert.ok(
    strong.qc.postprocessing.removedCm3 > 0 &&
      strong.rows.every((r) => r.value <= r.rawValue + 1e-8),
  );
  assert.ok(strong.rows.filter((r) => r.label <= 23).every((r) => r.components <= 2));
  await sleep(400);
  assert.equal(
    await run(
      () =>
        [...document.querySelectorAll(".desktop-workspace:not([hidden]) .case-canvas")]
          .find((c) => c.querySelector("strong").textContent === "sample_02")
          .querySelector("img").alt,
    ),
    preservedSlice,
    "Variant switching must preserve orientation and slice",
  );
  await capture("mri-strong-raw-comparison");
  await click("QC·후처리");
  await capture("mri-strong-qc");
  await click("← 결과 목록으로");
  await wait(() => document.querySelector(".desktop-workspace:not([hidden]) .results-list"));
  await click("← 분석 선택으로");
  await wait(() => document.querySelector(".protocol-table"));
  await run(() => document.querySelector(".desktop-brand").click());
  await run(() => document.querySelector('button[aria-label="X-ray 허벅지 근육 분석"]').click());
  await wait(() =>
    document.querySelector(".desktop-workspace:not([hidden]) .series-table tbody tr"),
  );
  const before = await run(
    () =>
      document.querySelectorAll(".desktop-workspace:not([hidden]) .series-table tbody tr").length,
  );
  picker = [original];
  await click("영상 추가");
  await wait(
    () =>
      !document.querySelector(".desktop-workspace:not([hidden]) .workspace-actions .primary")
        .disabled,
    120,
  );
  assert.equal(
    await run(
      () =>
        document.querySelectorAll(".desktop-workspace:not([hidden]) .series-table tbody tr").length,
    ),
    before + 1,
  );
  await click("선택 영상 검토");
  await wait(() => document.querySelector(".desktop-workspace:not([hidden]) .review-case img"));
  await capture("xray-review");
  const inputs = await run(async () => (await window.exmoDesktop.list("xray")).value);
  const last = inputs[inputs.length - 1];
  assert.equal(last.classification.route_to_segmentation, "AP");
  assert.equal(
    (await run(async (id) => window.exmoDesktop.run("mri", [id], [], "cpu"), last.id)).ok,
    false,
  );
  await click("Segmentation 실행");
  await wait(async () => (await window.exmoDesktop.job()).value?.stage === "모델 준비", 120);
  assert.equal(
    (await run(async (id) => window.exmoDesktop.run("xray", [id], [], "cuda:0"), last.id)).ok,
    false,
    "Concurrent inference rejected",
  );
  await click("실행 취소");
  await wait(async () => (await window.exmoDesktop.job()).value?.state === "cancelled");
  await wait(
    () =>
      ![...document.querySelectorAll("button")].find(
        (b) => b.textContent === "Segmentation 실행" && b.getClientRects().length,
      )?.disabled,
  );
  await click("Segmentation 실행");
  await wait(async () => {
    const job = (await window.exmoDesktop.job()).value;
    return job && job.state !== "running";
  }, 240);
  const job = await run(async () => (await window.exmoDesktop.job()).value);
  assert.equal(job.state, "complete", JSON.stringify(job.failed));
  assert.equal(job.completed.length, 1);
  assert.ok(job.completed[0].rows.every((r) => r.value >= 0 && r.fat === null));
  assert.equal(job.completed[0].unit, "cm²");
  assert.equal(job.completed[0].meshBytes, null);
  await click("분석 결과");
  await click("결과 열기");
  await wait(() =>
    document.querySelector(".desktop-workspace:not([hidden]) .result-workspace .medical-image img"),
  );
  await run(() =>
    document
      .querySelector('.desktop-workspace:not([hidden]) input[aria-label="전체 구조 선택"]')
      .click(),
  );
  const overlay = await run(async () => {
    const id = document.querySelector(".desktop-workspace:not([hidden]) .case-canvas").dataset
      .resultId;
    const result = (await window.exmoDesktop.results("xray")).value.find((r) => r.id === id);
    const selected = result.rows.filter((r) => r.present).slice(0, 2);
    for (const row of selected)
      document
        .querySelector(
          `.desktop-workspace:not([hidden]) tr[data-structure="${row.id}"] .metric-name`,
        )
        .click();
    return (
      await window.exmoDesktop.resultPreview(result.id, {
        classIds: selected.map((r) => r.label),
        opacity: 0.45,
      })
    ).value.image;
  });
  await sleep(600);
  const actualOverlay = await run(
    () =>
      document.querySelector(
        ".desktop-workspace:not([hidden]) .result-workspace .medical-image img",
      ).src,
  );
  assert.equal(
    createHash("sha256").update(actualOverlay).digest("hex"),
    createHash("sha256").update(overlay).digest("hex"),
    "X-ray must overlay both selected classes",
  );
  await capture("xray-multiple-overlays");
  await run(() =>
    document
      .querySelector('.desktop-workspace:not([hidden]) input[aria-label="전체 구조 선택"]')
      .click(),
  );
  await sleep(400);
  assert.equal(
    await run(
      () =>
        document.querySelectorAll(
          '.desktop-workspace:not([hidden]) tr[data-structure][aria-selected="false"]',
        ).length,
    ),
    0,
  );
  await click("← 결과 목록으로");
  await wait(() => document.querySelector(".desktop-workspace:not([hidden]) .results-list"));
  await run(() => {
    const rows = [...document.querySelectorAll(".desktop-workspace:not([hidden]) .results-list tbody tr")];
    const ap = rows.find((row) => row.querySelector("strong").textContent === "AP_01");
    if (!ap) throw new Error("Delivered AP result is missing");
    ap.querySelector('input[type="checkbox"]').click();
  });
  await sleep(200);
  assert.ok(await run(() => {
    const rows = [...document.querySelectorAll(".desktop-workspace:not([hidden]) .results-list tbody tr")];
    const lateral = rows.filter((row) => /^LAT_(LT|RT)_01$/.test(row.querySelector("strong").textContent));
    return lateral.length === 2 && lateral.every((row) => row.querySelector("input").disabled);
  }), "AP and LAT comparison must be blocked");
  await run(() => {
    const rows = [...document.querySelectorAll(".desktop-workspace:not([hidden]) .results-list tbody tr")];
    rows.find((row) => row.querySelector("strong").textContent === "LAT_LT_01").click();
  });
  await sleep(200);
  assert.equal(await run(() => document.querySelectorAll(".desktop-workspace:not([hidden]) .results-list input:checked").length), 1,
    "Whole-row click cannot bypass AP/LAT comparison restriction");
  const access = await run(async () => {
    const paths = [
      "/../desktop/imaging-worker.py",
      "/result/00000000-0000-0000-0000-000000000000.glb",
      "/models/model.pth",
      "/mask.nrrd",
    ];
    return Promise.all(paths.map(async (url) => (await fetch(url)).status));
  });
  assert.ok(
    access.every((status) => status !== 200),
    "Private assets are not served",
  );
  await run(() => document.querySelector(".desktop-brand").click());
  await wait(() => document.querySelector(".recent-section tbody tr"));
  const recentName = await run(() => {
    const row = document.querySelector(".recent-section tbody tr");
    const name = row.querySelector("strong").textContent;
    row.querySelector("td:nth-child(3)").click();
    return name;
  });
  await wait(() =>
    document.querySelector(".desktop-workspace:not([hidden]) .result-workspace .medical-image img"),
  );
  assert.ok(
    await run(
      (name) =>
        document
          .querySelector(".desktop-workspace:not([hidden]) .result-workspace h1")
          .textContent.includes(name),
      recentName,
    ),
    "Recent result opens from its entire row",
  );
  await sleep(300);
  await wait(() => !document.querySelector(".desktop-workspace:not([hidden]) .preview-updating"));
  assert.equal(hash(), originalHash, "User input preserved");
  for (const [file, beforeHash] of protectedSources)
    assert.equal(
      createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      beforeHash,
      "LR/PP preparation must preserve original model outputs: " + file,
    );
  for (const file of fs.readdirSync(path.join(root, "dist"), { recursive: true })) {
    assert.ok(!/\.(py|npz|pth|nrrd|nii|gz|safetensors)$/i.test(file));
    if (file.endsWith(".js"))
      assert.ok(
        !/exmoDesktop|exmo:imaging:/.test(fs.readFileSync(path.join(root, "dist", file), "utf8")),
      );
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(output, "desktop-report.json"),
    JSON.stringify(
      {
        views,
        completed: job.completed.map(({ id, analysis, unit }) => ({ id, analysis, unit })),
        errors,
        checks: [
          "opaque IDs",
          "physical slice views",
          "middle-button slice drag",
          "mouse-wheel slice scroll",
          "real CT mesh",
          "existing palette",
          "no demo measurements",
          "compact layout",
          "3-case matched structures",
          "shared assembled selection on first canvas click",
          "all-case explode/assemble",
          "side-by-side metrics and QC",
          "native left/right/unassigned volume conservation",
          "patient-side first hover measurement",
          "paired class selection across cases",
          "right drag in empty space rotates both sides independently of other cases",
          "compact metrics without row checkboxes",
          "protocol and recent result whole-row navigation",
          "original mask/metrics/entropy/QC immutability",
          "independent structure rotation",
          "MRI variant change",
          "strong PP candidate with raw values and unchanged TTA",
          "variant view/slice preservation",
          "X-ray multi-class overlay",
          "explicit back navigation",
          "AP routing",
          "AP/LAT mixed comparison rejection",
          "cancel/retry",
          "single inference",
          "input immutability",
          "web isolation",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: real Desktop review, slice views, result mesh, cancel/retry, inference, privacy and Web isolation",
  );
  clearTimeout(deadline);
  app.quit();
})().catch((error) => {
  console.error(error);
  clearTimeout(deadline);
  app.exit(1);
});
