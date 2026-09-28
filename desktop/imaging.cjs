const { dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

function installImaging(window, { engineRoot, storageRoot, scriptsRoot, palette }) {
  fs.mkdirSync(storageRoot, { recursive: true });
  const channels = [],
    files = new Map(),
    results = new Map();
  let worker,
    pending,
    disposed = false,
    selecting = false,
    queue = Promise.resolve(),
    catalogQueue = Promise.resolve();
  let child,
    batch = null,
    runPromise,
    cancelled = false;
  const inside = (file) => {
    const rel = path.relative(storageRoot, file);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  const python = (name) => path.join(engineRoot, "envs", name, "Scripts", "python.exe");
  const available = (analysis) =>
    fs.existsSync(path.join(engineRoot, "verified-packages.json")) &&
    (analysis === "xray" ? ["ct", "ap", "lat"] : ["ct", analysis]).every((name) =>
      fs.existsSync(python(name)),
    );
  const publicFile = ({
    id,
    name,
    analysis,
    metadata,
    classification,
    confirmation,
    ready,
    warnings,
    error,
  }) => ({ id, name, analysis, metadata, classification, confirmation, ready, warnings, error });
  const catalog = path.join(storageRoot, "library.json");
  // Apply the same semantic palette to saved results and newly generated results.
  const colors = new Map(JSON.parse(fs.readFileSync(palette, "utf8")).map((row) => [row.id, row]));
  if (fs.existsSync(catalog)) {
    try {
      for (const item of JSON.parse(fs.readFileSync(catalog, "utf8")))
        if (!item.input || (inside(item.input) && fs.existsSync(item.input)))
          files.set(item.id, item);
    } catch {
      /* A failed catalog read never deletes completed runs. */
    }
  }
  const runs = path.join(storageRoot, "runs");
  fs.mkdirSync(runs, { recursive: true });
  for (const directory of fs.readdirSync(runs, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    try {
      const result = JSON.parse(
        fs.readFileSync(path.join(runs, directory.name, "published.json"), "utf8"),
      );
      if (result.summary.analysis !== "xray")
        for (const row of [...result.summary.rows, ...(result.summary.parts || [])]) {
          const color = colors.get(row.structureId || row.id);
          if (color) Object.assign(row, { color: color.color, group: color.group });
        }
      if (
        inside(result.mask) &&
        inside(result.result) &&
        (!result.mesh || inside(result.mesh)) &&
        (!result.sideMask || (inside(result.sideMask) && fs.existsSync(result.sideMask))) &&
        fs.existsSync(result.mask)
      ) {
        if (result.summary.analysis === "mri") {
          const raw = JSON.parse(
            fs.readFileSync(path.join(result.result, "raw/metrics.json"), "utf8"),
          );
          const classes = new Map(raw.classes.map((row) => [row.label_id, row]));
          let removed = 0,
            count = 0,
            rawTotal = 0;
          for (const row of result.summary.rows) {
            const source = classes.get(row.label);
            row.rawValue = source.volume_ml;
            rawTotal += source.volume_ml;
            removed += source.volume_ml - row.value;
            count += source.voxel_count - row.count;
          }
          result.summary.qc.postprocessing = {
            removedCm3: removed,
            removedPercent: rawTotal ? (removed / rawTotal) * 100 : 0,
            changedVoxels: count,
          };
        }
        results.set(result.summary.id, result);
      }
    } catch {
      /* Incomplete/cancelled runs are not results. */
    }
  }
  function saveCatalog() {
    const snapshot = JSON.stringify([...files.values()]);
    const task = catalogQueue.then(async () => {
      const temp = catalog + ".tmp";
      await fsp.writeFile(temp, snapshot);
      await fsp.rename(temp, catalog);
    });
    catalogQueue = task.catch(() => {});
    return task;
  }
  function validateAnalysis(value) {
    if (!["ct", "mri", "xray"].includes(value)) throw new Error("분석 작업을 먼저 선택하세요.");
  }
  function getFile(analysis, id) {
    validateAnalysis(analysis);
    const file = files.get(id);
    if (!file || file.analysis !== analysis || !file.input)
      throw new Error("이 분석 작업에 영상을 다시 추가하세요.");
    return file;
  }
  function stopWorker(message = "영상 확인 작업이 중단되었습니다. 다시 시도하세요.") {
    const old = worker;
    worker = undefined;
    pending?.reject(new Error(message));
    pending = undefined;
    if (old) {
      old.stdin.destroy();
      old.kill();
    }
  }
  function workerEnv() {
    return {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONDONTWRITEBYTECODE: "1",
      OMP_NUM_THREADS: "4",
      OPENBLAS_NUM_THREADS: "2",
    };
  }
  function startWorker() {
    if (worker) return worker;
    if (!fs.existsSync(python("ct"))) throw new Error("로컬 분석 엔진을 준비해야 합니다.");
    const process = spawn(
      python("ct"),
      [
        "-X",
        "utf8",
        path.join(scriptsRoot, "imaging-worker.py"),
        "--engine-root",
        engineRoot,
        "--palette",
        palette,
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: workerEnv(),
      },
    );
    worker = process;
    const log = fs.createWriteStream(path.join(storageRoot, "preview-private.log"), { flags: "a" });
    process.stderr.pipe(log);
    process.stdin.on("error", () => {
      if (worker === process) stopWorker();
    });
    readline.createInterface({ input: process.stdout }).on("line", (line) => {
      if (worker !== process || !pending) return;
      try {
        const response = JSON.parse(line);
        if (response.id !== pending.id) return;
        const task = pending;
        pending = undefined;
        response.error ? task.reject(new Error(response.error)) : task.resolve(response.result);
      } catch {
        /* Third-party informational stdout is never an IPC response. */
      }
    });
    process.once("error", () => {
      if (worker === process) stopWorker("영상 확인 프로세스를 시작하지 못했습니다.");
    });
    process.once("exit", () => {
      log.end();
      if (worker === process) stopWorker();
    });
    return process;
  }
  function request(operation, values = {}) {
    const task = queue.then(() => {
      if (disposed) throw new Error("앱이 종료되었습니다.");
      const process = startWorker();
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(
          () => stopWorker("영상 처리 시간이 초과되었습니다. 다시 시도하세요."),
          operation === "finalize" ? 20 * 60000 : 5 * 60000,
        );
        pending = {
          id,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        process.stdin.write(JSON.stringify({ ...values, operation, requestId: id }) + "\n");
      });
    });
    queue = task.catch(() => {});
    return task;
  }
  function handle(name, action) {
    const channel = "exmo:imaging:" + name;
    channels.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      const frame = event.senderFrame;
      const url = frame ? new URL(frame.url) : null;
      if (
        disposed ||
        event.sender !== window.webContents ||
        frame !== window.webContents.mainFrame ||
        url?.protocol !== "atlas:" ||
        url.host !== "app" ||
        !["/", "/index.html"].includes(url.pathname)
      )
        throw new Error("Desktop 분석 화면에서만 사용할 수 있습니다.");
      try {
        return { ok: true, value: await action(...args) };
      } catch (error) {
        return {
          ok: false,
          error: error.code
            ? "파일 접근 권한·저장 공간·로컬 엔진 상태를 확인하세요."
            : error.message,
        };
      }
    });
  }
  handle("status", (analysis) => {
    validateAnalysis(analysis);
    return {
      reviewAvailable: available(analysis),
      estimationAvailable: available(analysis),
      device: analysis === "ct" ? "CPU · FP32" : "GPU",
      release: "20260927",
    };
  });
  handle("list", (analysis) => {
    validateAnalysis(analysis);
    return [...files.values()].filter((f) => f.analysis === analysis).map(publicFile);
  });
  handle("results", (analysis) => {
    validateAnalysis(analysis);
    return [...results.values()]
      .map((r) => r.summary)
      .filter((r) => r.analysis === analysis)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
  handle("choose", async (analysis, folder = false, language = "ko") => {
    validateAnalysis(analysis);
    if (typeof folder !== "boolean") throw new Error("잘못된 입력 선택입니다.");
    if (language !== "ko" && language !== "en") throw new Error("Invalid language.");
    if (selecting) return [];
    if (batch?.state === "running")
      throw new Error("실행 중인 분석을 완료하거나 취소한 뒤 영상을 추가하세요.");
    if (!available(analysis)) throw new Error("로컬 분석 엔진을 준비해야 합니다.");
    selecting = true;
    let importRoot;
    try {
      const selection = await dialog.showOpenDialog(window, {
        title:
          language === "en"
            ? `${analysis.toUpperCase()} · Add ${folder ? "DICOM folder" : "images"}`
            : `${analysis.toUpperCase()} · ${folder ? "DICOM 폴더" : "영상 파일"} 추가`,
        properties: folder ? ["openDirectory"] : ["openFile", "multiSelections"],
        ...(folder
          ? {}
          : { filters: [{ name: "Medical images", extensions: ["dcm", "nrrd", "nii", "gz"] }] }),
      });
      if (selection.canceled || disposed) return [];
      const sources = [];
      async function collect(directory, depth = 0) {
        if (depth > 12) throw new Error("폴더 깊이가 너무 큽니다. DICOM series 폴더를 선택하세요.");
        for (const item of await fsp.readdir(directory, { withFileTypes: true })) {
          if (item.isSymbolicLink()) continue;
          const full = path.join(directory, item.name);
          if (item.isDirectory()) await collect(full, depth + 1);
          else if (item.isFile() && !/\.(json|txt|md|csv|png|jpe?g|zip|exe|py)$/i.test(item.name))
            sources.push(full);
          if (sources.length > 6000)
            throw new Error("한 번에 6,000개 이하의 DICOM 파일을 선택하세요.");
        }
      }
      if (folder) await collect(selection.filePaths[0]);
      else sources.push(...selection.filePaths);
      if (!sources.length) throw new Error("선택한 폴더에 영상 파일이 없습니다.");
      importRoot = path.join(storageRoot, "imports", randomUUID());
      const snapshots = path.join(importRoot, "snapshots");
      await fsp.mkdir(snapshots, { recursive: true });
      const copied = [],
        names = {};
      let total = 0;
      for (const source of sources) {
        const stat = await fsp.stat(source);
        total += stat.size;
        if (!stat.isFile() || stat.size > 2 * 1024 ** 3 || total > 20 * 1024 ** 3)
          throw new Error("파일당 2 GB, 한 번에 20 GB 이하의 영상을 선택하세요.");
        const ext = source.toLowerCase().endsWith(".nii.gz") ? ".nii.gz" : path.extname(source);
        const snapshot = path.join(snapshots, randomUUID() + ext);
        await fsp.copyFile(source, snapshot, fs.constants.COPYFILE_EXCL);
        copied.push(snapshot);
        names[snapshot] = path.basename(source);
      }
      const imported = await request("inspect", {
        analysis,
        paths: copied,
        names,
        destination: path.join(importRoot, "prepared"),
      });
      if (disposed) return [];
      for (const row of imported) files.set(row.id, row);
      await saveCatalog();
      if (inside(snapshots)) await fsp.rm(snapshots, { recursive: true, force: true });
      return imported.map(publicFile);
    } catch (error) {
      if (
        importRoot &&
        inside(importRoot) &&
        ![...files.values()].some((f) => f.input?.startsWith(importRoot + path.sep))
      )
        await fsp.rm(importRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      selecting = false;
    }
  });
  function options(value = {}) {
    if (
      !value ||
      typeof value !== "object" ||
      ![undefined, "axial", "coronal", "sagittal"].includes(value.view) ||
      ![undefined, "soft", "bone"].includes(value.window) ||
      ![undefined, "all", "left", "right", "unassigned"].includes(value.side) ||
      (value.index != null &&
        (!Number.isInteger(value.index) || value.index < 0 || value.index > 100000)) ||
      (value.classIds != null &&
        (!Array.isArray(value.classIds) ||
          value.classIds.length > 255 ||
          value.classIds.some((id) => !Number.isInteger(id) || id < 1 || id > 255))) ||
      (value.opacity != null &&
        (!Number.isFinite(value.opacity) || value.opacity < 0 || value.opacity > 1))
    )
      throw new Error("잘못된 preview 옵션입니다.");
    return {
      view: value.view,
      index: value.index,
      window: value.window,
      classIds: value.classIds,
      side: value.side,
      opacity: value.opacity,
    };
  }
  handle("preview", (analysis, id, value) =>
    request("preview", { ...options(value), record: getFile(analysis, id) }),
  );
  handle("resultPreview", (id, value) => {
    const result = results.get(id);
    if (!result) throw new Error("완료된 결과를 선택하세요.");
    return request("preview", {
      ...options(value),
      record: result.record,
      mask: result.mask,
      sideMask: result.sideMask,
      rows: result.summary.rows,
    });
  });
  const preparingResults = new Map();
  handle("variant", async (id, variant) => {
    if (preparingResults.has(id)) await preparingResults.get(id);
    const prior = results.get(id);
    if (
      !prior ||
      !(
        prior.summary.analysis === "mri"
          ? ["raw", "pp500", "strong"]
          : prior.summary.analysis === "ct"
            ? ["raw"]
            : []
      ).includes(variant)
    )
      throw new Error("지원하는 결과 variant를 선택하세요.");
    if (batch?.state === "running")
      throw new Error("실행 중인 분석이 끝난 뒤 variant를 변경하세요.");
    if (
      variant === prior.summary.variant &&
      prior.summary.laterality?.method === "femur_components_lps_v1"
    )
      return prior.summary;
    const task = (async () => {
      const result = await request("finalize", {
        id,
        variant,
        record: prior.record,
        result: prior.result,
        createdAt: prior.summary.createdAt,
      });
      const publication = path.join(runs, id, "published.json");
      const temporary = publication + "." + randomUUID() + ".tmp";
      await fsp.writeFile(temporary, JSON.stringify(result));
      await fsp.rename(temporary, publication);
      results.set(id, result);
      return result.summary;
    })();
    preparingResults.set(id, task);
    try {
      return await task;
    } finally {
      if (preparingResults.get(id) === task) preparingResults.delete(id);
    }
  });
  const stageText = {
    model_loading: "모델 준비",
    inference_start: "Segmentation",
    inference_progress: "Segmentation",
    native_inverse_start: "원본 좌표 복원",
    native_inverse: "원본 좌표 복원",
  };
  async function execute(file, confirmed, device) {
    await request("prepare", { record: file, confirmed });
    if (cancelled) return;
    const id = randomUUID(),
      directory = path.join(runs, id);
    await fsp.mkdir(directory);
    const route = file.classification?.route_to_segmentation;
    const engine = file.analysis === "xray" ? (route === "AP" ? "ap" : "lat") : file.analysis;
    const job = {
      id: file.id,
      input: file.input,
      analysis: file.analysis,
      route,
      device,
      output: path.join(directory, "output"),
    };
    const jobPath = path.join(directory, "job.json");
    await fsp.writeFile(jobPath, JSON.stringify(job));
    const resultPath = await new Promise((resolve, reject) => {
      let complete;
      child = spawn(
        python(engine),
        [
          "-X",
          "utf8",
          path.join(scriptsRoot, "model-runner.py"),
          "--engine-root",
          engineRoot,
          "--job",
          jobPath,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: workerEnv() },
      );
      const process = child;
      const log = fs.createWriteStream(path.join(directory, "engine-private.log"));
      process.stderr.pipe(log, { end: false });
      readline.createInterface({ input: process.stdout }).on("line", (line) => {
        log.write(line + "\n");
        try {
          const event = JSON.parse(line);
          if (!event.exmo) return;
          if (event.stage === "complete") complete = event.result;
          if (!cancelled && batch?.state === "running") {
            batch.stage = stageText[event.stage] || batch.stage;
            if (event.patches_total)
              batch.progress = Math.min(
                100,
                Math.round((event.patches_done / event.patches_total) * 100),
              );
            if (event.stage === "native_inverse")
              batch.progress = Math.round((event.current / event.total) * 100);
          }
        } catch {
          /* Vendor output stays private. */
        }
      });
      process.once("error", () => {
        log.end();
        reject(new Error("분석 엔진을 시작하지 못했습니다. 로컬 실행 환경을 확인하세요."));
      });
      process.once("exit", (code) => {
        log.end();
        if (child === process) child = undefined;
        if (cancelled) resolve(null);
        else if (
          code === 0 &&
          complete &&
          inside(complete) &&
          complete.startsWith(directory + path.sep)
        )
          resolve(complete);
        else
          reject(
            new Error(
              "모델 실행에 실패했습니다. 입력 조건과 GPU/메모리 여유를 확인하세요. CPU 실행으로 다시 시도할 수 있습니다.",
            ),
          );
      });
    });
    if (cancelled || !resultPath) return;
    batch.stage = "측정·Overlay·3D 준비";
    batch.progress = null;
    const result = await request("finalize", {
      record: file,
      result: resultPath,
      id,
      createdAt: new Date().toISOString(),
    });
    if (cancelled) return;
    const temp = path.join(directory, "published.tmp");
    await fsp.writeFile(temp, JSON.stringify(result));
    await fsp.rename(temp, path.join(directory, "published.json"));
    results.set(id, result);
    batch.completed.push(result.summary);
  }
  handle("run", (analysis, ids, confirmedIds = [], device = "cuda:0") => {
    validateAnalysis(analysis);
    if (selecting || batch?.state === "running")
      throw new Error("현재 작업을 완료하거나 취소한 뒤 실행하세요.");
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 12 ||
      new Set(ids).size !== ids.length ||
      !Array.isArray(confirmedIds) ||
      !["cuda:0", "cpu"].includes(device)
    )
      throw new Error("한 번에 1~12개의 검토된 영상을 선택하세요.");
    const targets = ids.map((id) => getFile(analysis, id));
    if (targets.some((f) => !f.ready || (f.confirmation && !confirmedIds.includes(f.id))))
      throw new Error("분석 조건과 입력 단위/sequence를 확인하세요.");
    cancelled = false;
    batch = {
      id: randomUUID(),
      analysis,
      state: "running",
      current: "",
      stage: "대기",
      progress: null,
      completed: [],
      failed: [],
      total: targets.length,
    };
    runPromise = (async () => {
      for (const file of targets) {
        if (cancelled || disposed) break;
        batch.current = file.name;
        batch.stage = "입력 확인";
        batch.progress = null;
        try {
          await execute(file, confirmedIds.includes(file.id), device);
        } catch (error) {
          if (!cancelled) batch.failed.push({ id: file.id, name: file.name, error: error.message });
        }
      }
      batch.state = cancelled ? "cancelled" : batch.failed.length ? "failed" : "complete";
      batch.stage = cancelled ? "취소됨" : "완료";
    })();
    return { ...batch };
  });
  handle("job", () => batch);
  async function cancel(analysis) {
    validateAnalysis(analysis);
    if (batch?.analysis !== analysis || batch.state !== "running") return;
    cancelled = true;
    if (child) {
      const owned = child;
      if (process.platform === "win32")
        await new Promise((resolve) => {
          const killer = spawn("taskkill", ["/PID", String(owned.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          killer.once("error", () => {
            owned.kill();
            resolve();
          });
          killer.once("exit", resolve);
        });
      else owned.kill();
    }
    if (pending) stopWorker("작업을 취소했습니다.");
    await runPromise;
  }
  handle("cancel", cancel);
  handle("clear", async (analysis) => {
    validateAnalysis(analysis);
    if (selecting) throw new Error("영상 가져오기가 끝난 뒤 목록을 비우세요.");
    await cancel(analysis);
    await request("clear");
    for (const [id, file] of files) {
      if (file.analysis !== analysis) continue;
      files.delete(id);
      if (
        file.input &&
        ![...results.values()].some((result) => result.record.input === file.input)
      ) {
        const directory = path.dirname(file.input);
        if (inside(directory)) await fsp.rm(directory, { recursive: true, force: true });
      }
    }
    await saveCatalog();
  });
  return {
    mesh(id) {
      const result = results.get(id);
      return result?.mesh && inside(result.mesh) ? result.mesh : null;
    },
    async dispose() {
      if (disposed) return;
      if (batch?.state === "running") await cancel(batch.analysis);
      disposed = true;
      channels.forEach((channel) => ipcMain.removeHandler(channel));
      stopWorker();
    },
  };
}

module.exports = { installImaging };
