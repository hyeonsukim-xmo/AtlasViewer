// Read-only UI fixture: no patient data, engine, account server or production store.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  http = require("node:http");
const { solutions } = require("../desktop/solutions.cjs");
const root = path.resolve("."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "exmo-clinical-ui-"));
app.setPath("userData", path.join(dir, "profile"));
const structures = [
  ...fs
    .readFileSync(path.join(root, "app/anatomy.ts"), "utf8")
    .matchAll(/\{ id: "([^"]+)", name: "([^"]+)", group: "([^"]+)", color: "([^"]+)" \}/g),
].map((m, i) => ({
  id: m[1],
  name: m[2],
  group: m[3],
  color: m[4],
  label: i + 1,
  count: 100,
  value: 100.1 + i,
  fat: null,
  hu: null,
  entropy: 0.08,
  components: 2,
  present: true,
  sides: {
    left: { count: 49, value: 49, fat: null, hu: null, entropy: 0.08 },
    right: { count: 50, value: 50, fat: null, hu: null, entropy: 0.08 },
    unassigned: { count: 1, value: 1.1, fat: null, hu: null, entropy: 0.08 },
    differencePercent: null,
    differenceCm3: null,
  },
}));
const results = [1, 2, 3].map((n) => ({
  id: "audit-" + n,
  inputId: "input-" + n,
  analysis: "mri",
  solutionId: "exmo.thigh.mri",
  name: "Review sample " + n,
  metadata: {
    format: "NRRD",
    caseName: "Review sample " + n,
    seriesDescription: "Water",
    studyDescription: "UI fixture",
    size: [16, 16, 16],
    spacing: [1, 1, 1],
    slices: 16,
  },
  rows: structures,
  unit: "cm³",
  variant: "raw",
  route: null,
  meshBytes: fs.statSync(path.join(root, "public/models/exmo-1001921.glb")).size,
  laterality: {
    method: "femur_components_lps_v1",
    status: "partial",
    reason: "UI fixture: patient coordinate classification",
    unassignedCm3: 29.7,
  },
  qc: {
    flags: [],
    entropy: 0.08,
    ttaDisagreement: 0.02,
    missing: [],
    unexpected: [],
    tta: "8 flips",
  },
  seconds: 10,
  timings: {
    ready: 15,
    input: 1,
    modelProcess: 12,
    model: {
      model_loading: 2,
      preprocessing: 1,
      inference: 3,
      native_restore: 1,
      qc: 1,
      save: 1,
      verification: 1,
    },
    mesh: 2,
  },
  createdAt: "2026-01-01T00:00:00Z",
}));
const bridge = `const {contextBridge}=require('electron');const solutions=${JSON.stringify(solutions)},results=${JSON.stringify(results)};
const ok=value=>Promise.resolve({ok:true,value});const license={profile:'customer',state:'VALID',expiresAt:null,solutions:solutions.map(s=>({solutionId:s.id,state:'active',expiresAt:null}))};
const noop=()=>()=>{};contextBridge.exposeInMainWorld('exmoDesktop',{solutions:()=>ok(solutions),results:s=>ok(s.includes('mri')?results:[]),list:()=>ok([]),status:id=>ok({reviewAvailable:true,estimationAvailable:!id.endsWith('.ct'),device:'GPU',installation:'ready'}),licenseStatus:()=>Promise.resolve(license),accountStatus:()=>ok({state:'signed-out',me:null,workspace:null}),installations:()=>ok({supported:true,busy:false,solutions:solutions.map(s=>({analysis:s.analysis,solutionId:s.id,installed:true,canRollback:false,state:'ready'}))}),syncStatus:()=>ok({configured:true,storageError:false,jobs:[]}),job:()=>ok(null),onAccountChanged:noop,onInstallationsChanged:noop,onImportProgress:noop,resultPreview:()=>ok({image:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="gray"/></svg>',index:8,count:16,sides:['A','P','R','L'],warnings:[]}),variant:()=>Promise.reject(new Error('No mutations in UI validation'))});`;
fs.writeFileSync(path.join(dir, "preload.cjs"), bridge);
let server, win;
const failures = [],
  checks = [];
const timeout = setTimeout(() => {
  console.error("Clinical UI test timed out");
  app.exit(1);
}, 90000);
function check(condition, name) {
  checks.push(name);
  if (!condition) failures.push(name);
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(fn, ...args) {
  return win.webContents.executeJavaScript(
    `(${fn})(${args.map((v) => JSON.stringify(v)).join(",")})`,
  );
}
async function wait(fn) {
  for (let n = 0; n < 100; n++) {
    if (await run(fn)) return;
    await delay(100);
  }
  throw Error("UI wait failed: " + fn);
}
async function click(text) {
  return run((text) => {
    const b = [...document.querySelectorAll("button")].find(
      (e) =>
        e.getBoundingClientRect().width &&
        (e.textContent.trim() === text || e.getAttribute("aria-label") === text),
    );
    if (b) {
      b.focus();
      b.click();
    }
    return !!b;
  }, text);
}
async function escape() {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "ESC" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "ESC" });
  await delay(350);
}
(async () => {
  try {
    await app.whenReady();
    server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      let file;
      if (url.pathname.startsWith("/result/"))
        file = path.join(root, "public/models/exmo-1001921.glb");
      else {
        file = path.resolve(
          root,
          "dist-desktop",
          "." + (url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)),
        );
        if (!file.startsWith(path.join(root, "dist-desktop") + path.sep)) {
          res.writeHead(403);
          return res.end();
        }
      }
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        return res.end();
      }
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
          ".woff2": "font/woff2",
          ".glb": "model/gltf-binary",
        }[path.extname(file)] || "application/octet-stream",
      );
      fs.createReadStream(file).pipe(res);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    win = new BrowserWindow({
      width: 1440,
      height: 900,
      useContentSize: true,
      show: false,
      webPreferences: {
        preload: path.join(dir, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const url = "http://127.0.0.1:" + server.address().port;
    await win.loadURL(url);
    await wait(() => document.querySelectorAll(".protocol-table tbody tr").length === 3);
    check(
      await run(() =>
        document.querySelector(".protocol-table tbody tr").textContent.includes("준비 필요"),
      ),
      "Unavailable engine does not claim analysis readiness",
    );
    for (const label of ["계정", "솔루션 관리", "전송 현황"]) {
      await click(label);
      await wait(() => document.querySelector('[data-slot="dialog-content"]'));
      check(
        await run(
          () => !!document.querySelector('[data-slot="dialog-content"] button[aria-label="닫기"]'),
        ),
        label + ": visible close",
      );
      if (label === "계정")
        check(
          await run(
            () =>
              ![...document.querySelectorAll('[data-slot="dialog-content"] button')].some(
                (b) => b.textContent === "로그아웃",
              ),
          ),
          "Signed-out account hides logout",
        );
      await escape();
      for (let retry = 0; retry < 20; retry++) {
        if (await run((label) => document.activeElement?.textContent.trim() === label, label))
          break;
        await delay(50);
      }
      check(
        await run((label) => document.activeElement?.textContent.trim() === label, label),
        label + ": focus restored",
      );
    }
    await run(() =>
      [...document.querySelectorAll(".recent-section tbody tr")]
        .find((e) => e.textContent.includes("Review sample 1"))
        .click(),
    );
    await wait(() => document.querySelector(".result-workspace"));
    await run(() =>
      [...document.querySelectorAll("button")]
        .find((e) => e.textContent.includes("비교 영상 추가 (1/3)"))
        .click(),
    );
    await wait(() => document.querySelector(".comparison-dialog[open]"));
    check(
      await run(() => {
        const r = document.querySelector(".comparison-dialog").getBoundingClientRect();
        return (
          Math.abs(r.left + r.width / 2 - innerWidth / 2) < 3 &&
          Math.abs(r.top + r.height / 2 - innerHeight / 2) < 3
        );
      }),
      "Comparison dialog centered",
    );
    await run(() => document.querySelector(".comparison-candidates button").click());
    await delay(100);
    await run(() => document.querySelector(".comparison-candidates button").click());
    await delay(500);
    check(
      await run(() => {
        const box = document.querySelector(".metric-scroll").getBoundingClientRect();
        return (
          [...document.querySelectorAll(".metric-table tbody tr")].filter((r) => {
            const q = r.getBoundingClientRect();
            return q.top >= box.top && q.bottom <= box.bottom;
          }).length >= 8
        );
      }),
      "Three-case table shows eight complete structures",
    );
    check(
      await run(
        () =>
          document.querySelector(".metric-table tbody tr td:nth-child(2) strong")?.textContent ===
          "100.1",
      ),
      "Measurements preserved",
    );
    await click("QC·후처리");
    await delay(150);
    check(
      await run(() => {
        const row = [...document.querySelectorAll(".qc-table tr")].find(
          (r) => r.cells[0]?.textContent === "TTA disagreement",
        );
        return (
          row.getBoundingClientRect().bottom <=
          document.querySelector(".metric-scroll").getBoundingClientRect().bottom
        );
      }),
      "QC TTA remains visible after laterality summary",
    );
    const details = await run(() => {
      const b = document.querySelector(".qc-table .qc-detail-button");
      b?.click();
      return !!b;
    });
    check(details, "QC has full-width structure details");
    if (details) {
      await wait(() => document.querySelector(".qc-structure-dialog"));
      check(
        await run(() => document.querySelectorAll(".qc-structure-dialog tbody tr").length === 27),
        "All QC structures retained",
      );
      await click("닫기");
    }
    await click("측정값");
    win.setContentSize(1024, 768);
    await delay(300);
    check(
      await run(() =>
        [...document.querySelectorAll(".metric-case-name")].every(
          (e) => e.scrollWidth <= e.clientWidth + 1,
        ),
      ),
      "Comparison names readable at 1024",
    );
    await run(() =>
      [...document.querySelectorAll(".result-view-actions button")]
        .find((b) => b.textContent === "3D 보기" || b.textContent === "3D anatomy")
        .click(),
    );
    await delay(1200);
    check(
      await run(
        () => !document.querySelector(".metric-note").textContent.includes("0개 구조 선택"),
      ),
      "3D focus distinct from visibility",
    );
    await click("3D 데모");
    await wait(() => document.querySelector(".studio"));
    await click("About");
    await wait(() => document.querySelector(".about-dialog"));
    check(
      await run(
        () =>
          [...document.querySelectorAll(".about-dialog button")].filter(
            (button) =>
              button.textContent.trim() === "Close" ||
              button.getAttribute("aria-label") === "Close",
          ).length === 1,
      ),
      "About dialog has one close action",
    );
    await escape();
    console.log(JSON.stringify({ checks: checks.length, failures }, null, 2));
    if (failures.length) process.exitCode = 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    win?.destroy();
    server?.closeAllConnections();
    server?.close();
    app.exit(process.exitCode || 0);
  }
})();
