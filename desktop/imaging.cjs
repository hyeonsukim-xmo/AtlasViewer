const { dialog, ipcMain, powerSaveBlocker } = require("electron");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { resources, estimateMemory, runPipeline, aborted } = require("./analysis-pipeline.cjs");
const { AnalysisWorker } = require("./analysis-worker.cjs");

function installImaging(window, { engineRoot, storageRoot, scriptsRoot, palette }) {
  fs.mkdirSync(storageRoot, { recursive: true });
  const channels = [],
    files = new Map(),
    results = new Map();
  let worker,
    workerShutdown = Promise.resolve(),
    pending,
    disposed = false,
    selecting = false,
    importProgress = null,
    queue = Promise.resolve(),
    catalogQueue = Promise.resolve();
  let batch = null,
    runPromise,
    cancelled = false;
  let pipelineController, pipelineResources, finalizer;
  const modelWorkers = new Map();
  function modelWorker(engine) {
    if (!modelWorkers.has(engine) || modelWorkers.get(engine).closed) modelWorkers.set(engine, new AnalysisWorker({
      python: python(engine),
      args: ["-X", "utf8", path.join(scriptsRoot, "model-service.py"), "--engine-root", engineRoot],
      env: workerEnv(), logPath: path.join(storageRoot, `model-${engine}-private.log`),
    }));
    return modelWorkers.get(engine);
  }
  function resultWorker() {
    if (!finalizer || finalizer.closed) finalizer = new AnalysisWorker({
      python: python("ct"),
      args: ["-X", "utf8", path.join(scriptsRoot, "imaging-worker.py"), "--engine-root", engineRoot, "--palette", palette],
      env: workerEnv(), logPath: path.join(storageRoot, "finalize-private.log"),
    });
    return finalizer;
  }
  async function closeAnalysisWorkers(force = false) {
    const workers = [...modelWorkers.values(), ...(finalizer ? [finalizer] : [])];
    await Promise.allSettled(workers.map(item => force ? item.stop() : item.close()));
    modelWorkers.clear(); finalizer = undefined;
  }
  function taskState(task, changes) {
    Object.assign(task, changes);
    batch.current = task.name; batch.stage = task.stage; batch.progress = task.progress;
  }
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
    deferredValidation,
    warnings,
    error,
  }) => ({ id, name, analysis, metadata, classification, confirmation, ready, deferredValidation, warnings, error });
  function publishImport(rows = []) {
    if (!disposed && importProgress)
      window.webContents.send("exmo:imaging:importProgress", {
        ...importProgress, rows: rows.map(publicFile),
      });
  }
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
      if (process.platform === "win32" && old.pid && old.exitCode === null) {
        workerShutdown = new Promise(resolve => {
          const killer = spawn("taskkill", ["/PID", String(old.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", () => { old.kill(); resolve(); });
          killer.once("exit", code => { if (code) old.kill(); resolve(); });
        });
      } else old.kill();
    }
    return workerShutdown;
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
  function request(operation, values = {}, signal) {
    const task = queue.then(async () => {
      await workerShutdown;
      if (signal?.aborted) throw aborted();
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
      device: analysis === "xray" ? "GPU" : "GPU · FP32",
      release: "20260927",
      importProgress: importProgress?.analysis === analysis ? importProgress : null,
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
      importProgress = { analysis, completed: 0, total: sources.length, current: "", phase: "copy", failed: 0 };
      publishImport();
      importRoot = path.join(storageRoot, "imports", randomUUID());
      const snapshots = path.join(importRoot, "snapshots");
      await fsp.mkdir(snapshots, { recursive: true });
      let total = 0;
      for (const source of sources) {
        const stat = await fsp.stat(source);
        total += stat.size;
        if (!stat.isFile() || stat.size > 2 * 1024 ** 3 || total > 20 * 1024 ** 3)
          throw new Error("파일당 2 GB, 한 번에 20 GB 이하의 영상을 선택하세요.");
      }
      const standalone = sources.filter(p => /\.(nrrd|nii|nii\.gz)$/i.test(p));
      const dicom = sources.filter(p => !standalone.includes(p));
      const groups = standalone.map(p => [p]);
      if (dicom.length) groups.push(dicom); // Never split a DICOM series into slices.
      const imported = [];
      for (const sourcePaths of groups) {
        if (disposed) break;
        const paths = [], names = {};
        let rows;
        try {
          for (const source of sourcePaths) {
            importProgress.current = path.basename(source);
            importProgress.phase = "copy";
            publishImport();
            const ext = source.toLowerCase().endsWith(".nii.gz") ? ".nii.gz" : path.extname(source);
            const snapshot = path.join(snapshots, randomUUID() + ext);
            await fsp.copyFile(source, snapshot, fs.constants.COPYFILE_EXCL);
            paths.push(snapshot);
            names[snapshot] = path.basename(source);
          }
          importProgress.phase = "inspect";
          publishImport();
          rows = await request("inspect", {
            analysis, paths, names, consumeSnapshots: true,
            destination: path.join(importRoot, randomUUID().replaceAll("-", "").slice(0, 16)),
          });
        } catch (error) {
          if (disposed) break;
          rows = [{ id: randomUUID(), analysis, name: path.basename(sourcePaths[0]),
            ready: false, warnings: [], error: error.message }];
        }
        for (const row of rows) files.set(row.id, row);
        await saveCatalog();
        imported.push(...rows);
        importProgress.completed += sourcePaths.length;
        importProgress.failed += rows.filter(row => !row.ready).length;
        importProgress.phase = "saved";
        publishImport(rows);
        for (const snapshot of paths) await fsp.rm(snapshot, { force: true }).catch(() => {});
      }
      // A terminated worker/virus scanner may briefly retain a snapshot handle.
      // Cleanup must never turn already-persisted imports into an apparent failure.
      if (inside(snapshots)) await fsp.rm(snapshots, {
        recursive: true, force: true, maxRetries: 10, retryDelay: 100,
      }).catch(() => {});
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
      importProgress = null;
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
    model_reused: "로드된 모델 재사용",
    native_prepare: "좌표 복원 입력 준비",
    native_blocks: "원본 복원·정규화·라벨 계산",
    inference_start: "Segmentation",
    inference_progress: "Segmentation",
    native_inverse_start: "원본 좌표 복원",
    native_inverse: "원본 좌표 복원",
    native_normalization: "복원 확률 정규화·라벨 확정",
    result_export_start: "결과 측정·저장·검증",
    result_save: "분할 결과 파일 저장",
    result_measurement: "클래스별 부피·HU 측정",
    result_verification: "저장 결과 다시 읽기·검증",
  };
  async function prepareInput(file, confirmed, signal) {
    const original = file;
    file = await request("prepare", { record: file, confirmed }, signal);
    if (original.deferredValidation && !file.deferredValidation && files.has(file.id)) {
      files.set(file.id, file);
      await saveCatalog();
    }
    return file;
  }
  async function execute(file, confirmed, device) {
    const task = { id: file.id, name: file.name, stage: "메모리 확보 대기", progress: null, lane: "waiting" };
    batch.active.push(task);
    const controller = new AbortController();
    const abortTask = () => controller.abort();
    pipelineController.signal.addEventListener("abort", abortTask, { once: true });
    if (pipelineController.signal.aborted) controller.abort();
    const signal = controller.signal;
    let memory, modelSlot, gpu, cpu, finalize;
    const estimate = estimateMemory(file);
    try {
      memory = await pipelineResources.memory.acquire(estimate.gpu, signal);
      if (signal.aborted) throw aborted();
      taskState(task, { stage: "입력 확인", lane: "prepare" });
      file = await prepareInput(file, confirmed, signal);
      if (signal.aborted) throw aborted();
      taskState(task, { stage: device === "cpu" ? "모델 준비" : "GPU 차례 대기", lane: "waiting" });
      modelSlot = await pipelineResources.model.acquire(1, signal);
      gpu = await pipelineResources.gpu.acquire(1, signal);
      if (signal.aborted) throw aborted();
      const id = randomUUID(), directory = path.join(runs, id);
      await fsp.mkdir(directory);
      const route = file.classification?.route_to_segmentation;
      const engine = file.analysis === "xray" ? (route === "AP" ? "ap" : "lat") : file.analysis;
      const job = { id: file.id, input: file.input, analysis: file.analysis, route, device, output: path.join(directory, "output") };
      await fsp.writeFile(path.join(directory, "job.json"), JSON.stringify(job));
      if (signal.aborted) throw aborted();
      const model = modelWorker(engine);
      taskState(task, { stage: "모델 준비", lane: device === "cpu" ? "cpu" : "gpu", progress: null });
      const complete = await model.request({ operation: "run", job }, {
        id, logPath: path.join(directory, "engine-private.log"),
        onEvent: async event => {
          if (signal.aborted) return;
          if (event.gpu) batch.deviceLabel = `${event.gpu} · ${event.precision === "mixed_float16" ? "AMP" : "FP32"}`;
          if (event.stage === "cpu_ready") {
            gpu?.release(); gpu = undefined;
            memory.resize(estimate.cpu);
            taskState(task, { stage: "CPU 후처리 차례 대기", lane: "waiting", progress: null });
            cpu = await pipelineResources.cpu.acquire(1, signal);
            if (signal.aborted) { cpu.release(); throw aborted(); }
            taskState(task, { stage: "CPU 후처리", lane: "cpu" });
            model.send({ operation: "resume_cpu", id });
            return;
          }
          const stage = stageText[event.stage];
          if (stage && task.stage !== stage) taskState(task, { stage, progress: null });
          if (event.patches_total) taskState(task, { progress: Math.min(100, Math.round(event.patches_done / event.patches_total * 100)) });
          if (["native_inverse", "native_normalization", "native_prepare", "native_blocks"].includes(event.stage)) taskState(task, { progress: Math.round(event.current / event.total * 100) });
        },
      });
      gpu?.release(); gpu = undefined;
      modelSlot?.release(); modelSlot = undefined;
      if (signal.aborted) throw aborted();
      const resultPath = complete.result;
      if (!complete.complete || !inside(resultPath) || !resultPath.startsWith(directory + path.sep))
        throw new Error("모델 결과 경로를 확인하지 못했습니다.");
      cpu?.release(); cpu = undefined;
      if (estimate.finalize) memory.resize(Math.min(estimate.cpu, estimate.finalize));
      taskState(task, { stage: "결과 준비 차례 대기", lane: "waiting", progress: null });
      finalize = await pipelineResources.finalize.acquire(1, signal);
      if (signal.aborted) throw aborted();
      taskState(task, { stage: "측정·Overlay·3D 준비", lane: "cpu", progress: null });
      const result = await resultWorker().request({
        operation: "finalize", record: file, result: resultPath, id, createdAt: new Date().toISOString(),
      }, { id, timeout: 20 * 60000 });
      if (signal.aborted) throw aborted();
      const temp = path.join(directory, "published.tmp");
      await fsp.writeFile(temp, JSON.stringify(result));
      if (signal.aborted) throw aborted();
      await fsp.rename(temp, path.join(directory, "published.json"));
      results.set(id, result);
      batch.completed.push(result.summary);
    } finally {
      controller.abort();
      pipelineController.signal.removeEventListener("abort", abortTask);
      modelSlot?.release(); gpu?.release(); cpu?.release(); finalize?.release(); memory?.release();
      batch.active = batch.active.filter(item => item !== task);
    }
  }
  handle("run", (analysis, ids, confirmedIds = [], device = "cuda:0") => {
    validateAnalysis(analysis);
    if (selecting || batch?.state === "running")
      throw new Error("현재 작업을 완료하거나 취소한 뒤 실행하세요.");
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > files.size ||
      new Set(ids).size !== ids.length ||
      !Array.isArray(confirmedIds) ||
      !["cuda:0", "cpu"].includes(device)
    )
      throw new Error("등록된 영상 중 분석할 대상을 선택하세요.");
    const targets = ids.map((id) => getFile(analysis, id));
    if (targets.some((f) => !f.ready || (f.confirmation && !confirmedIds.includes(f.id))))
      throw new Error("분석 조건과 입력 단위/sequence를 확인하세요.");
    const powerBlocker = powerSaveBlocker.start("prevent-app-suspension");
    cancelled = false;
    pipelineController = new AbortController();
    pipelineResources = resources();
    batch = {
      id: randomUUID(),
      analysis,
      state: "running",
      current: "",
      stage: "대기",
      progress: null,
      completed: [],
      failed: [],
      active: [],
      concurrency: device === "cpu" ? 1 : 3,
      total: targets.length,
      deviceLabel: `${device === "cpu" ? "CPU" : "GPU"}${analysis === "xray" ? "" : " · FP32"}`,
    };
    runPromise = (async () => {
      try {
        await runPipeline(targets, {
          signal: pipelineController.signal, concurrency: batch.concurrency,
          execute: file => execute(file, confirmedIds.includes(file.id), device),
          failed: (file, error) => batch.failed.push({ id: file.id, name: file.name, error: error.message }),
        });
      } finally {
        await closeAnalysisWorkers(cancelled);
        powerSaveBlocker.stop(powerBlocker);
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
    pipelineController?.abort();
    await closeAnalysisWorkers(true);
    if (pending) await stopWorker("작업을 취소했습니다.");
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
        ![...results.values()].some((result) => path.dirname(result.record.input) === path.dirname(file.input))
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
      await stopWorker();
    },
  };
}

module.exports = { installImaging };
