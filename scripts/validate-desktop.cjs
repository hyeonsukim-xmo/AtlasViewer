// Runs the real desktop entry point, optionally from a packaged app.asar.
// No test bridge or Node access is added to the application renderer.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "exmo-desktop-check-")));
const output = path.resolve("outputs/desktop-check");
fs.mkdirSync(output, { recursive: true });
const errors = [];
app.on("web-contents-created", (_, contents) => {
  contents.on("console-message", (_, details) => {
    if (details.level === "error") errors.push(details.message);
  });
});
require(path.resolve(process.argv[2] || ".", "desktop/main.cjs"));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error("Desktop validation timed out"); app.exit(1); }, 90000);

(async () => {
  await app.whenReady();
  const window = BrowserWindow.getAllWindows()[0];
  assert.ok(window, "Main window created");
  const contents = window.webContents;
  const run = (fn, ...args) => contents.executeJavaScript(`(${fn})(${args.map((v) => JSON.stringify(v)).join(",")})`);
  const waitFor = async (fn) => {
    for (let i = 0; i < 300; i++) {
      if (await run(fn)) return;
      await delay(100);
    }
    throw new Error("UI did not reach expected state: " + fn);
  };
  if (contents.isLoading()) await new Promise((resolve) => contents.once("did-finish-load", resolve));
  await waitFor(() => document.querySelector('.canvas-stage[aria-busy="false"] canvas') && !document.querySelector('[role="alert"]'));
  await run(() => {
    window.__frames = { raf: 0, renders: 0, times: [] };
    const originalRAF = window.requestAnimationFrame;
    let frameTime = 0;
    window.requestAnimationFrame = (fn) => originalRAF.call(window, (time) => {
      window.__frames.raf++;
      frameTime = time;
      fn(time);
    });
    const originalClear = WebGL2RenderingContext.prototype.clear;
    WebGL2RenderingContext.prototype.clear = function(...args) {
      window.__frames.renders++;
      window.__frames.times.push(frameTime);
      return originalClear.apply(this, args);
    };
  });
  const click = (label) => run((label) => {
    const button = document.querySelector(`button[aria-label="${label}"]`);
    if (!button || button.disabled) throw new Error("Button unavailable: " + label);
    button.click();
  }, label);
  const frames = () => run(() => ({ ...window.__frames }));
  const sample = async (ms = 600) => {
    const before = await frames();
    await delay(ms);
    const after = await frames();
    const result = { raf: after.raf - before.raf, renders: after.renders - before.renders };
    const times = after.times.slice(before.times.length);
    if (times.length > 2) {
      const gaps = times.slice(1).map((time, i) => time - times[i]).sort((a, b) => a - b);
      result.frameGapsMs = Object.fromEntries([
        ["min", gaps[0]], ["median", gaps[Math.floor(gaps.length / 2)]],
        ["p95", gaps[Math.floor(gaps.length * 0.95)]], ["max", gaps.at(-1)],
      ].map(([key, value]) => [key, Math.round(value * 100) / 100]));
    }
    return result;
  };

  assert.equal(await run(() => typeof require), "undefined");
  const preferences = contents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(await run(async () => (await fetch("/models/exmo-1001921.glb")).status), 200);
  assert.equal(await run(async () => (await fetch("/%2e%2e%5cpackage.json")).status), 403);
  assert.equal(await run(async () => (await fetch("/package.json")).status), 404);
  assert.ok(await run(async () => (await fetch("/")).headers.get("Content-Security-Policy").includes("script-src 'self'")));
  assert.equal(await session.defaultSession.protocol.isProtocolHandled("atlas"), true);

  await delay(1000);
  const idle = await sample();
  assert.deepEqual(idle, { raf: 0, renders: 0 }, "Idle must stop both rendering and frame polling");
  await click("Auto rotate");
  await delay(300);
  const rotating = await sample(1000);
  assert.ok(rotating.renders > 10, JSON.stringify(rotating));
  assert.ok(rotating.renders >= rotating.raf - 1, "Motion must render every display callback: " + JSON.stringify(rotating));
  window.minimize();
  await waitFor(() => document.hidden);
  await delay(150);
  const minimized = await sample();
  assert.equal(minimized.renders, 0, "Minimized window must not render");
  window.restore();
  window.show();
  await waitFor(() => !document.hidden);
  await click("Pause rotation");
  await delay(1500);
  assert.deepEqual(await sample(), { raf: 0, renders: 0 }, "Damping must settle back to idle");

  await click("Select Femur");
  await waitFor(() => document.querySelector('[aria-label="Select Femur"]').getAttribute("aria-pressed") === "true");
  await click("Explode anatomy");
  await delay(1900);
  const point = await run(() => {
    const rect = document.querySelector("canvas").getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  });
  contents.sendInputEvent({ type: "mouseDown", button: "right", clickCount: 1, ...point });
  contents.sendInputEvent({ type: "mouseMove", x: point.x + 60, y: point.y + 30, modifiers: ["rightButtonDown"] });
  contents.sendInputEvent({ type: "mouseUp", button: "right", clickCount: 1, x: point.x + 60, y: point.y + 30 });
  await delay(200);
  await click("Select Femur");
  const returning = await sample(800);
  assert.ok(returning.renders > 5, "Deselected segment must animate back");
  await delay(250);
  assert.deepEqual(await sample(), { raf: 0, renders: 0 }, "Rotation return must settle");
  await click("Assemble anatomy");
  await delay(1900);
  assert.deepEqual(await sample(), { raf: 0, renders: 0 }, "Assemble must settle");
  await click("Select Femur");
  await click("Select Rectus femoris");
  assert.equal(await run(() => document.querySelectorAll('.structure-choice[aria-pressed="true"]').length), 2);
  await click("Reset atlas");
  await delay(500);
  fs.writeFileSync(path.join(output, "atlas.png"), (await contents.capturePage()).toPNG());
  const webgl = await run(() => {
    const gl = document.querySelector("canvas").getContext("webgl2");
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
    };
  });
  const gpu = await app.getGPUInfo("basic");
  const report = { idle, rotating, minimized, returning, webgl, gpuStatus: app.getGPUFeatureStatus(), gpu, errors };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  assert.deepEqual(errors, [], "Renderer must not emit errors");
  console.log(JSON.stringify(report, null, 2));
  console.log("Desktop: offline assets, sandbox, protocol boundary, idle/minimized rendering, animations and selection passed.");
  clearTimeout(timeout);
  app.exit(0);
})().catch((error) => {
  console.error(error);
  console.error(errors);
  clearTimeout(timeout);
  app.exit(1);
});
