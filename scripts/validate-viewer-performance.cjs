// Real medical Viewer performance, using the private integration samples. No inference.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const root = path.resolve(".");
const output = path.join(root, "outputs/imaging-check");
app.setPath("userData", path.join(output, "userdata"));
process.env.EXMO_ENGINE_ROOT = path.join(root, "work/modality-integration");
const report = { ipc: [], errors: [] };
let previewDelay = 0;
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, fn) =>
  originalHandle(name, async (...args) => {
    const start = performance.now();
    if (previewDelay && name.endsWith("resultPreview"))
      await new Promise((resolve) => setTimeout(resolve, previewDelay));
    const reply = await fn(...args);
    if (name.endsWith("preview") || name.endsWith("resultPreview"))
      report.ipc.push({ name, ms: Math.round(performance.now() - start), ok: reply.ok });
    return reply;
  });
require(path.join(path.resolve(process.argv[3] || "."), "desktop/main.cjs"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = setTimeout(() => {
  console.error("Viewer timed out");
  app.exit(1);
}, 240000);
(async () => {
  await app.whenReady();
  const window = BrowserWindow.getAllWindows()[0],
    contents = window.webContents;
  contents.on("console-message", (_, details) => {
    if (details.level === "error") report.errors.push(details.message);
  });
  if (contents.isLoading())
    await new Promise((resolve) => contents.once("did-finish-load", resolve));
  const run = (fn, ...args) =>
    contents.executeJavaScript(`(${fn})(${args.map(JSON.stringify).join(",")})`);
  const wait = async (fn) => {
    for (let i = 0; i < 600; i++) {
      if (await run(fn)) return;
      await sleep(100);
    }
    throw new Error("Viewer UI timeout: " + fn);
  };
  const click = (text) =>
    run((text) => {
      const button = [...document.querySelectorAll("button")].find(
        (b) => b.getClientRects().length && b.textContent.trim().startsWith(text),
      );
      if (!button || button.disabled) throw new Error("Button not ready: " + text);
      button.click();
    }, text);
  const layout = () =>
    run(() => {
      const host = document.querySelector(".desktop-workspace:not([hidden]) .result-body");
      const panel = host.querySelector(".metrics-panel").getBoundingClientRect();
      const handle = host.querySelector(".metrics-resizer");
      const grip = handle.getBoundingClientRect();
      return {
        panel: panel.width,
        viewer: host.querySelector(".result-imaging").getBoundingClientRect().width,
        x: Math.round(grip.x + grip.width / 2),
        y: Math.round(grip.y + 80),
        max: Number(handle.getAttribute("aria-valuemax")),
        overflow: document.documentElement.scrollWidth > innerWidth,
        canvasesFit: [...host.querySelectorAll(".result-scene canvas")].every(
          (canvas) => Math.abs(canvas.clientWidth - canvas.parentElement.clientWidth) <= 1,
        ),
        canvasWidths: [...host.querySelectorAll(".result-scene canvas")].map((canvas) => [
          canvas.clientWidth,
          canvas.parentElement.clientWidth,
        ]),
      };
    });
  async function dragPanel(delta) {
    const before = await layout();
    contents.sendInputEvent({
      type: "mouseDown",
      button: "left",
      clickCount: 1,
      x: before.x,
      y: before.y,
    });
    for (let i = 1; i <= 10; i++) {
      contents.sendInputEvent({
        type: "mouseMove",
        x: Math.max(5, Math.round(before.x + (delta * i) / 10)),
        y: before.y,
        modifiers: ["leftButtonDown"],
      });
      await sleep(15);
    }
    contents.sendInputEvent({
      type: "mouseUp",
      button: "left",
      clickCount: 1,
      x: Math.max(5, Math.round(before.x + delta)),
      y: before.y,
    });
    await sleep(300);
    for (let i = 0; i < 20 && !(await layout()).canvasesFit; i++) await sleep(100);
    return layout();
  }
  async function checkPanel(name) {
    const before = await layout();
    const grown = await dragPanel(140);
    assert.ok(
      Math.abs(grown.panel - before.panel - 140) < 2,
      "Dragging the divider widens the panel",
    );
    assert.ok(Math.abs(before.viewer - grown.viewer - 140) < 2, "Viewer yields the same space");
    assert.ok(
      grown.canvasesFit && !grown.overflow,
      "Canvas follows the panel without page overflow: " + JSON.stringify(grown),
    );
    contents.sendInputEvent({ type: "mouseMove", x: grown.x + 80, y: grown.y });
    await sleep(100);
    assert.equal((await layout()).panel, grown.panel, "Released drag must stop resizing");
    window.focus();
    await run(() =>
      document.querySelector(".desktop-workspace:not([hidden]) .metrics-resizer").focus(),
    );
    contents.sendInputEvent({ type: "keyDown", keyCode: "Left" });
    contents.sendInputEvent({ type: "keyUp", keyCode: "Left" });
    for (let i = 0; i < 30 && Math.abs((await layout()).panel - grown.panel + 20) >= 2; i++)
      await sleep(100);
    assert.ok(
      Math.abs((await layout()).panel - grown.panel + 20) < 2,
      "Keyboard resizes the panel",
    );
    const narrow = await dragPanel(-800);
    assert.equal(narrow.panel, 280, "Minimum width protects table controls");
    const wide = await dragPanel(700);
    assert.ok(wide.panel <= wide.max && wide.viewer >= 320, "Maximum width preserves the Viewer");
    window.setSize(900, 660);
    await sleep(400);
    const compact = await layout();
    assert.ok(
      compact.panel <= compact.max && !compact.overflow && compact.canvasesFit,
      "Window resize clamps the panel",
    );
    window.setSize(1440, 960);
    await sleep(300);
    await run(() =>
      document
        .querySelector(".desktop-workspace:not([hidden]) .metrics-resizer")
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    await sleep(300);
    assert.ok(
      Math.abs((await layout()).panel - before.panel) < 2,
      "Double click restores the default",
    );
    report[name] = { before, grown, compact };
  }
  async function checkSelection(name) {
    const counts = () =>
      run(() => {
        const host = document.querySelector(".desktop-workspace:not([hidden]) .metrics-panel");
        const all = host.querySelector('input[aria-label="전체 구조 선택"]');
        return {
          total: host.querySelectorAll("tr[data-structure]").length,
          checked: host.querySelectorAll('tr[data-structure][aria-selected="true"]').length,
          all: all.checked,
          mixed: all.indeterminate,
        };
      });
    const initial = await counts();
    assert.ok(initial.all && initial.checked === initial.total, "Every structure starts selected");
    const cell = await run(() => {
      const r = document
        .querySelector(".desktop-workspace:not([hidden]) tr[data-structure] td:last-child")
        .getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...cell });
    contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...cell });
    await sleep(100);
    assert.equal(
      (await counts()).checked,
      initial.total - 1,
      "Clicking a value toggles its entire structure row",
    );
    assert.ok((await counts()).mixed, "Partial selection is visible on the header checkbox");
    await run(() =>
      document
        .querySelector('.desktop-workspace:not([hidden]) input[aria-label="전체 구조 선택"]')
        .click(),
    );
    await sleep(50);
    assert.ok((await counts()).all, "Mixed selection toggles to all");
    await run(() =>
      document
        .querySelector('.desktop-workspace:not([hidden]) input[aria-label="전체 구조 선택"]')
        .click(),
    );
    await sleep(50);
    assert.equal((await counts()).checked, 0, "Select all also clears all");
    await wait(() => !document.querySelector(".desktop-workspace:not([hidden]) .preview-updating"));
    async function overlaysMatch() {
      return run(async () => {
        const host = document.querySelector(".desktop-workspace:not([hidden]) .result-workspace");
        const ids = [...host.querySelectorAll("tr[data-structure][aria-selected=true]")].map(
          (row) => row.dataset.structure,
        );
        const results = (
          await window.exmoDesktop.results(
            host.querySelectorAll(".case-canvas").length === 3 ? "mri" : "ct",
          )
        ).value;
        for (const viewport of host.querySelectorAll(".case-canvas")) {
          const result = results.find((r) => r.id === viewport.dataset.resultId);
          const expected = await window.exmoDesktop.resultPreview(result.id, {
            view: "axial",
            index: Number(viewport.querySelector('input[aria-label="Slice"]').value),
            opacity: 0.45,
            classIds: result.rows.filter((row) => ids.includes(row.id)).map((row) => row.label),
          });
          if (!expected.ok || viewport.querySelector("img").src !== expected.value.image)
            return false;
        }
        return true;
      });
    }
    assert.ok(await overlaysMatch(), "Empty selection shows the image without any label overlay");
    await run(() =>
      [
        ...document.querySelectorAll(
          ".desktop-workspace:not([hidden]) tr[data-structure] td:last-child",
        ),
      ]
        .slice(0, 2)
        .forEach((cell) => cell.click()),
    );
    await sleep(100);
    assert.equal((await counts()).checked, 2, "Rapid row clicks each apply once");
    await wait(() => !document.querySelector(".desktop-workspace:not([hidden]) .preview-updating"));
    assert.ok(await overlaysMatch(), "Every comparison viewport overlays the same selected labels");
    await run(() =>
      document
        .querySelector(".desktop-workspace:not([hidden]) tr[data-structure] .metric-name")
        .focus(),
    );
    contents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    contents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await sleep(50);
    assert.equal(
      (await counts()).checked,
      1,
      "Keyboard activation toggles the structure exactly once",
    );
    await run(() =>
      document
        .querySelector('.desktop-workspace:not([hidden]) input[aria-label="전체 구조 선택"]')
        .focus(),
    );
    contents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    contents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await sleep(100);
    assert.ok((await counts()).all, "Select all works with the keyboard");
    report[name] = { initial, final: await counts() };
  }
  await wait(() => document.querySelector(".protocol-table"));
  const start = performance.now();
  await run(() => document.querySelector('button[aria-label="CT 허벅지 근육 분석"]').click());
  await wait(() => document.querySelector(".desktop-workspace:not([hidden]) .medical-image img"));
  report.firstPreviewMs = Math.round(performance.now() - start);
  await click("분석 결과");
  await click("결과 열기");
  await wait(() => document.querySelector(".result-workspace .medical-image img"));
  await checkSelection("ctSelection");
  await checkPanel("ctPanel");
  report.ctPreviewMs = await run(async () => {
    const id = (await window.exmoDesktop.results("ct")).value[0].id,
      times = [];
    for (let index = 80; index < 92; index++) {
      const start = performance.now();
      const r = await window.exmoDesktop.resultPreview(id, { view: "axial", index, opacity: 0.45 });
      if (!r.ok) throw new Error(r.error);
      times.push(Math.round(performance.now() - start));
    }
    return times;
  });
  report.wheel = await run(async () => {
    const host = document.querySelector(".result-workspace .medical-image");
    const img = host.querySelector("img");
    let updates = 0;
    const observer = new MutationObserver((entries) => {
      updates += entries.filter((entry) => entry.attributeName === "src").length;
    });
    observer.observe(img, { attributes: true });
    const before = img.alt;
    for (let i = 0; i < 30; i++) {
      host.dispatchEvent(new WheelEvent("wheel", { deltaY: 80, bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const during = updates;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    observer.disconnect();
    return { before, after: img.alt, during, total: updates };
  });
  assert.ok(
    report.wheel.during >= 3,
    "Continuous scrolling must display slices before the gesture ends",
  );
  assert.equal(
    Number(report.wheel.after.match(/\d+$/)[0]) - Number(report.wheel.before.match(/\d+$/)[0]),
    30,
  );
  report.opacity = await run(async () => {
    const image = document.querySelector(".result-workspace .medical-image img");
    const slider = document.querySelector('input[aria-label="Overlay opacity"]');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    let updates = 0;
    const observer = new MutationObserver((entries) => {
      updates += entries.filter((entry) => entry.attributeName === "src").length;
    });
    observer.observe(image, { attributes: true });
    for (let i = 0; i <= 20; i++) {
      setValue.call(slider, String(i / 20));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const during = updates;
    await new Promise((resolve) => setTimeout(resolve, 300));
    observer.disconnect();
    return { during, total: updates, value: slider.value };
  });
  assert.ok(report.opacity.during >= 3, "Overlay opacity must update while dragging");
  previewDelay = 100;
  const queuedStart = report.ipc.length;
  await run(async () => {
    const host = document.querySelector(".result-workspace .medical-image");
    for (let i = 0; i < 20; i++) {
      host.dispatchEvent(new WheelEvent("wheel", { deltaY: 80, bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    for (const view of ["Coronal", "Sagittal"])
      [...document.querySelectorAll(".result-workspace button")]
        .find((b) => b.textContent === view)
        .click();
  });
  await wait(() =>
    document.querySelector(".result-workspace .medical-image img").alt.startsWith("sagittal"),
  );
  report.coalescedRequests = report.ipc.length - queuedStart;
  assert.ok(
    report.coalescedRequests <= 4,
    "Slow rendering must not queue obsolete scroll requests",
  );
  await sleep(200);
  assert.ok(
    await run(() =>
      document.querySelector(".result-workspace .medical-image img").alt.startsWith("sagittal"),
    ),
    "An old response must not replace the new view",
  );
  previewDelay = 0;
  await run(() => {
    window.__viewer = { frames: [], tasks: [], rays: [], draws: 0 };
    new PerformanceObserver((list) =>
      window.__viewer.tasks.push(...list.getEntries().map((x) => x.duration)),
    ).observe({ type: "longtask" });
    const clear = WebGL2RenderingContext.prototype.clear;
    WebGL2RenderingContext.prototype.clear = function (...args) {
      window.__viewer.frames.push(performance.now());
      return clear.apply(this, args);
    };
    const draw = WebGL2RenderingContext.prototype.drawElements;
    WebGL2RenderingContext.prototype.drawElements = function (...args) {
      window.__viewer.draws++;
      return draw.apply(this, args);
    };
    const listener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, options) {
      if (this instanceof HTMLCanvasElement && type === "pointermove" && options === true) {
        const move = fn;
        fn = function (...args) {
          const start = performance.now();
          try {
            return move.apply(this, args);
          } finally {
            window.__viewer.rays.push(performance.now() - start);
          }
        };
      }
      return listener.call(this, type, fn, options);
    };
  });
  async function measure3d(name) {
    const started = performance.now();
    await click("3D anatomy");
    await wait(
      () =>
        document.querySelector(".desktop-workspace:not([hidden]) canvas") &&
        !document.querySelector(".desktop-workspace:not([hidden]) .scene-loading"),
    );
    await sleep(500);
    const loadMs = Math.round(performance.now() - started);
    const rect = await run(() => {
      const r = document
        .querySelector(".desktop-workspace:not([hidden]) canvas")
        .getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    });
    await run(() => {
      window.__viewer.frames = [];
      window.__viewer.rays = [];
      window.__viewer.tasks = [];
      window.__viewer.draws = 0;
    });
    await click("Explode anatomy");
    await sleep(1900);
    const motion = await run(() => ({ ...window.__viewer }));
    for (let i = 0; i < 80; i++) {
      contents.sendInputEvent({
        type: "mouseMove",
        x: rect.x + Math.round(rect.width * (0.2 + (0.6 * i) / 79)),
        y: rect.y + Math.round(rect.height * 0.5),
      });
      await sleep(8);
    }
    const hover = await run(() => window.__viewer.rays);
    contents.sendInputEvent({ type: "mouseMove", x: 10, y: 10 });
    await sleep(300);
    const idleStart = await run(() => window.__viewer.frames.length);
    await sleep(700);
    const idle = (await run(() => window.__viewer.frames.length)) - idleStart;
    report[name] = {
      loadMs,
      frames: motion.frames.length,
      draws: motion.draws,
      gaps: motion.frames.slice(1).map((t, i) => t - motion.frames[i]),
      longTasks: motion.tasks,
      hoverMs: hover,
      idle,
    };
    assert.equal(idle, 0, "Settled Viewer must stop rendering");
  }
  await measure3d("ct3d");
  await checkPanel("ct3dPanel");
  await run(() => document.querySelector(".desktop-brand").click());
  await run(() => document.querySelector('button[aria-label="MRI 허벅지 근육 분석"]').click());
  await wait(() =>
    document.querySelector(".desktop-workspace:not([hidden]) .series-table tbody tr"),
  );
  await click("분석 결과");
  const comparison = () =>
    run(() => ({
      rows: [
        ...document.querySelectorAll(".desktop-workspace:not([hidden]) .results-list tbody tr"),
      ].map((row) => ({
        checked: row.querySelector("input").checked,
        selected: row.getAttribute("aria-selected") === "true",
      })),
      opened: !!document.querySelector(".desktop-workspace:not([hidden]) .result-workspace"),
    }));
  const selectResultRow = (index = 0) =>
    run(
      (index) =>
        document
          .querySelectorAll(".desktop-workspace:not([hidden]) .results-list tbody tr")
          [index].querySelector("td:nth-child(3)")
          .click(),
      index,
    );
  await selectResultRow();
  await wait(() =>
    document.querySelector(".desktop-workspace:not([hidden]) .results-list input:checked"),
  );
  assert.deepEqual((await comparison()).rows[0], { checked: true, selected: true });
  assert.equal(
    (await comparison()).opened,
    false,
    "Clicking a comparison row selects without opening",
  );
  await selectResultRow();
  await wait(
    () => !document.querySelector(".desktop-workspace:not([hidden]) .results-list input:checked"),
  );
  await run(() =>
    document.querySelector(".desktop-workspace:not([hidden]) .results-list input").click(),
  );
  await wait(() =>
    document.querySelector(".desktop-workspace:not([hidden]) .results-list input:checked"),
  );
  assert.equal(
    (await comparison()).rows.filter((row) => row.checked).length,
    1,
    "Checkbox toggles exactly once",
  );
  window.focus();
  await run(() =>
    document.querySelector(".desktop-workspace:not([hidden]) .results-list input").focus(),
  );
  contents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
  contents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
  await wait(
    () => !document.querySelector(".desktop-workspace:not([hidden]) .results-list input:checked"),
  );
  await run(() =>
    [
      ...document.querySelectorAll(
        ".desktop-workspace:not([hidden]) .results-list tbody tr td:nth-child(3)",
      ),
    ]
      .slice(0, 3)
      .forEach((b) => b.click()),
  );
  await wait(
    () =>
      document.querySelectorAll(".desktop-workspace:not([hidden]) .results-list input:checked")
        .length === 3,
  );
  await selectResultRow();
  await wait(
    () =>
      document.querySelectorAll(".desktop-workspace:not([hidden]) .results-list input:checked")
        .length === 2,
  );
  const selectedBeforeOpen = (await comparison()).rows;
  await click("결과 열기");
  await wait(() =>
    document.querySelector(".desktop-workspace:not([hidden]) .result-workspace .medical-image img"),
  );
  await click("← 결과 목록으로");
  await wait(() => document.querySelector(".desktop-workspace:not([hidden]) .results-list"));
  assert.deepEqual(
    (await comparison()).rows,
    selectedBeforeOpen,
    "Open result button leaves comparison selection unchanged",
  );
  await selectResultRow();
  await wait(
    () =>
      document.querySelectorAll(".desktop-workspace:not([hidden]) .results-list input:checked")
        .length === 3,
  );
  assert.ok((await comparison()).rows.every((row) => row.checked === row.selected));
  report.resultRowSelection = true;
  await click("선택 검사 비교 (3/3)");
  await wait(
    () =>
      document.querySelectorAll(".desktop-workspace:not([hidden]) .medical-image img").length === 3,
  );
  await checkSelection("mriSelection");
  await checkPanel("mriPanel");
  await dragPanel(120);
  fs.writeFileSync(
    path.join(output, "metrics-resizable-selection.png"),
    (await contents.capturePage()).toPNG(),
  );
  await run(() =>
    document
      .querySelector(".desktop-workspace:not([hidden]) .metrics-resizer")
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  report.mriPreviewMs = await run(async () => {
    const results = (await window.exmoDesktop.results("mri")).value.slice(0, 3),
      times = [];
    for (let index = 80; index < 83; index++)
      for (const result of results) {
        const start = performance.now();
        const reply = await window.exmoDesktop.resultPreview(result.id, { view: "axial", index });
        if (!reply.ok) throw new Error(reply.error);
        times.push(Math.round(performance.now() - start));
      }
    return times;
  });
  await measure3d("mri3case");
  await checkPanel("mri3dPanel");
  await run(() => document.querySelector(".desktop-brand").click());
  await run(() => document.querySelector('button[aria-label="X-ray 허벅지 근육 분석"]').click());
  await wait(() =>
    document.querySelector(".desktop-workspace:not([hidden]) .series-table tbody tr"),
  );
  await click("분석 결과");
  const xray = await run(async () =>
    (await window.exmoDesktop.results("xray")).value.map((r) => r.route),
  );
  const ap = xray.flatMap((route, i) => (route === "AP" ? [i] : []));
  const lateral = xray.findIndex((route) => route !== "AP");
  assert.ok(ap.length >= 1 && lateral >= 0, "Integration samples cover AP/LAT schemas");
  await selectResultRow(ap[0]);
  await wait(
    () =>
      document.querySelectorAll(".desktop-workspace:not([hidden]) .results-list input:checked")
        .length === 1,
  );
  await selectResultRow(lateral);
  assert.equal(
    (await comparison()).rows[lateral].checked,
    false,
    "Row click cannot mix AP and LAT schemas",
  );
  assert.equal(
    await run(
      (i) =>
        document.querySelectorAll(".desktop-workspace:not([hidden]) .results-list input")[i]
          .disabled,
      lateral,
    ),
    true,
  );
  for (const i of ap.slice(1, 4)) await selectResultRow(i);
  assert.equal(
    (await comparison()).rows.filter((row) => row.checked).length,
    Math.min(ap.length, 3),
  );
  if (ap.length >= 4)
    assert.equal(
      (await comparison()).rows[ap[3]].checked,
      false,
      "Row selection cannot exceed three cases",
    );
  await run(() =>
    [
      ...document.querySelectorAll(".desktop-workspace:not([hidden]) .results-list input:checked"),
    ].forEach((input) => input.click()),
  );
  await wait(
    () => !document.querySelector(".desktop-workspace:not([hidden]) .results-list input:checked"),
  );
  await selectResultRow(lateral);
  await wait(
    () =>
      document.querySelectorAll(".desktop-workspace:not([hidden]) .results-list input:checked")
        .length === 1,
  );
  assert.equal(
    (await comparison()).rows[lateral].checked,
    true,
    "Clearing AP selection makes lateral results selectable",
  );
  report.comparisonLimits = { maxThree: ap.length >= 4, matchingSchema: true };
  fs.writeFileSync(
    path.join(output, "result-row-selection.png"),
    (await contents.capturePage()).toPNG(),
  );
  assert.deepEqual(report.errors, []);
  fs.writeFileSync(
    path.join(output, `viewer-${process.argv[2] || "current"}.json`),
    JSON.stringify(report, null, 2),
  );
  const stats = (values) => {
    const v = [...values].sort((a, b) => a - b);
    return {
      median: v[Math.floor(v.length / 2)],
      p95: v[Math.floor(v.length * 0.95)],
      max: v.at(-1),
    };
  };
  console.log(
    JSON.stringify(
      {
        firstPreviewMs: report.firstPreviewMs,
        previewMs: stats(report.ctPreviewMs),
        mriPreviewMs: stats(report.mriPreviewMs),
        wheel: report.wheel,
        opacity: report.opacity,
        ...Object.fromEntries(
          ["ct3d", "mri3case"].map((key) => [
            key,
            {
              loadMs: report[key].loadMs,
              frames: report[key].frames,
              gaps: stats(report[key].gaps),
              hoverMs: stats(report[key].hoverMs),
              idle: report[key].idle,
            },
          ]),
        ),
      },
      null,
      2,
    ),
  );
  clearTimeout(deadline);
  app.quit();
})().catch((error) => {
  console.error(error);
  clearTimeout(deadline);
  app.exit(1);
});
