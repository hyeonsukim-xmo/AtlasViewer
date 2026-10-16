const { dialog, ipcMain, powerSaveBlocker } = require("electron");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { performance } = require("node:perf_hooks");
const { Capacity, resources, estimateMemory, runPipeline, aborted } = require("./analysis-pipeline.cjs");
const { AnalysisWorker } = require("./analysis-worker.cjs");
const { showImageMenu } = require("./image-menu.cjs");
const { createExportIdentities } = require("./export-identities.cjs");
const { exportResults } = require("./results-export.cjs");
const { createPatientAssignments } = require("./patient-assignments.cjs");
const { createSourceMetadata } = require("./source-metadata.cjs");

function installImaging(window, { engineRoot, storageRoot, scriptsRoot, palette, analysisAuthorization, artifactStorage }) {
  if (analysisAuthorization !== undefined && typeof analysisAuthorization?.authorize !== "function")
    throw new Error("분석 권한 확인 모듈을 초기화하지 못했습니다.");
  async function authorize(runId, engine, signal) {
    if (!analysisAuthorization) return;
    const grant = await analysisAuthorization.authorize({ runId, engine, signal });
    if (grant?.runId !== runId || grant.engine !== engine || !["VALID", "GRACE"].includes(grant.state))
      throw new Error("분석 권한을 확인하지 못했습니다. 신규 분석을 시작하지 않습니다.");
    if (signal?.aborted) throw aborted();
  }
  fs.mkdirSync(storageRoot, { recursive: true });
  const exportIdentities = createExportIdentities(storageRoot);
  const patientAssignments = createPatientAssignments(storageRoot);
  const sourceMetadata = createSourceMetadata(storageRoot);
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
  const resultLane = new Capacity(1);
  let meshQueue = Promise.resolve(), publicationQueue = Promise.resolve();
  let resultRevision = 0;
  let batchStarted = 0;
  const modelWorkers = new Map();
  function runtime(name, args) {
    const portable=path.join(engineRoot,'python','python.exe');
    return fs.existsSync(portable)?{python:portable,args:['-I','-B','-X','utf8',path.join(scriptsRoot,'runtime_bootstrap.py'),'--site',path.join(engineRoot,'envs',name,'Lib','site-packages'),'--',...args]}:
      {python:python(name),args:['-X','utf8',...args]};
  }
  function modelWorker(engine) {
    if (!modelWorkers.has(engine) || modelWorkers.get(engine).closed) modelWorkers.set(engine, new AnalysisWorker({
      ...runtime(engine,[path.join(scriptsRoot, "model-service.py"), "--engine-root", engineRoot]),
      env: workerEnv(), logPath: path.join(storageRoot, `model-${engine}-private.log`),
      artifactStorage,
    }));
    return modelWorkers.get(engine);
  }
  function resultWorker() {
    if (!finalizer || finalizer.closed) finalizer = new AnalysisWorker({
      ...runtime('ct',[path.join(scriptsRoot, "imaging-worker.py"), "--engine-root", engineRoot, "--palette", palette]),
      env: workerEnv(), logPath: path.join(storageRoot, "finalize-private.log"),
      artifactStorage,
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
      fs.existsSync(python(name)) || (fs.existsSync(path.join(engineRoot,'python','python.exe')) && fs.existsSync(path.join(engineRoot,'envs',name,'Lib','site-packages'))),
    );
  const studyAssignmentsPath = path.join(storageRoot, "xray-studies.json");
  let studyAssignments = {};
  if (fs.existsSync(studyAssignmentsPath))
    studyAssignments = JSON.parse(fs.readFileSync(studyAssignmentsPath, "utf8"));
  const withStudy = (record) => {
    const source = files.get(record.inputId || record.id) || results.get(record.id)?.record || record;
    const enriched = sourceMetadata.apply(record, source);
    return record.analysis === "xray" && studyAssignments[record.inputId || record.id]
      ? {...enriched, metadata:{...enriched.metadata,studyAssignment:studyAssignments[record.inputId || record.id]}}
      : patientAssignments.apply(enriched);
  };
  const publicFile = ({
    id,
    name,
    analysis,
    metadata,
    sourceProof,
    classification,
    confirmation,
    ready,
    deferredValidation,
    warnings,
    error,
  }) => withStudy({ id, name, analysis, metadata: metadata ? {...metadata,
    studyUid: metadata.studyUid || sourceProof?.study_uid, seriesUid: metadata.seriesUid || sourceProof?.series_uid} : metadata,
    classification, confirmation, ready, deferredValidation, warnings, error });
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
        if (result.summary.meshState === "pending") result.summary.meshState = "interrupted";
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
  function publishResult(result, expected) {
    const task = publicationQueue.then(async () => {
      const id = result.summary.id;
      // A late mesh for a previous variant must never replace the current result.
      if (expected && results.get(id) !== expected) return false;
      const publication = path.join(runs, id, "published.json");
      const temporary = publication + "." + randomUUID() + ".tmp";
      await fsp.writeFile(temporary, JSON.stringify(result));
      await fsp.rename(temporary, publication);
      results.set(id, result);
      resultRevision++;
      if (batch) {
        batch.resultRevision = resultRevision;
        const index = batch.completed.findIndex(row => row.id === id);
        if (index >= 0) batch.completed[index] = result.summary;
      }
      return true;
    });
    publicationQueue = task.catch(() => {});
    return task;
  }
  function queueMesh(result, signal, memoryBudget) {
    if (result.summary.meshState !== "pending") return;
    const queued = performance.now();
    meshQueue = meshQueue.then(async () => {
      let slot, memory;
      try {
        if (disposed || signal?.aborted) throw aborted();
        if (results.get(result.summary.id) !== result) return;
        if (memoryBudget) {
          const estimate = estimateMemory(result.record);
          memory = await memoryBudget.acquire(estimate.finalize || estimate.cpu, signal);
        }
        slot = await resultLane.acquire(1, signal);
        if (results.get(result.summary.id) !== result) return;
        const meshWait = (performance.now() - queued) / 1000;
        const updated = await resultWorker().request({ operation: "mesh", publication: result }, { timeout: 20 * 60000 });
        if (signal?.aborted || disposed) throw aborted();
        updated.summary.timings.meshWait = meshWait;
        await publishResult(updated, result);
      } catch (error) {
        const updated = { ...result, summary: { ...result.summary,
          meshState: signal?.aborted || disposed ? "interrupted" : "failed" } };
        await publishResult(updated, result);
      } finally {
        slot?.release(); memory?.release();
      }
    }).catch(error => {
      // Retain the early publication even if persisting mesh status fails.
      console.error("Mesh publication failed", error);
    });
  }
  function validateAnalysis(value) {
    if (!["ct", "mri", "xray"].includes(value)) throw new Error("분석 작업을 먼저 선택하세요.");
  }
  function getFile(analysis, id) {
    validateAnalysis(analysis);
    const file = files.get(id);
    if (!file || file.analysis !== analysis || !file.input)
      throw new Error("이 분석 작업에 영상을 다시 추가하세요.");
    return withStudy(file);
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
    const environment={...process.env};
    if(artifactStorage)for(const key of Object.keys(environment))if(/^(PYTHON|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)/i.test(key))delete environment[key];
    return {
      ...environment,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONDONTWRITEBYTECODE: "1",
      OMP_NUM_THREADS: "4",
      OPENBLAS_NUM_THREADS: "2",
    };
  }
  function startWorker() {
    if (worker) return worker;
    const command=runtime('ct',[path.join(scriptsRoot,'imaging-worker.py'),'--engine-root',engineRoot,'--palette',palette]);
    if (!fs.existsSync(command.python)) throw new Error("로컬 분석 엔진을 준비해야 합니다.");
    const process = spawn(
      command.python,
      command.args,
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
    if (artifactStorage) process.stdin.write(JSON.stringify({operation:'storage_init',...artifactStorage})+'\n');
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
  function sourceFor(record, publication) {
    const metadata = withStudy({...record, metadata: {...record.metadata, ...publication?.summary.metadata}}).metadata;
    const assignment = studyAssignments[record.id] || metadata.studyAssignment;
    return {inputId:record.id,resultId:publication?.summary.id || '',analysis:record.analysis,
      patientId:assignment?.patientId || metadata.patientId,
      patientIssuer:assignment?.patientIssuer || metadata.patientIssuer,institutionName:metadata.institutionName,
      studyDate:assignment?.studyDate || metadata.studyDate,
      studyUid:metadata.studyUid || record.sourceProof?.study_uid,
      seriesUid:metadata.seriesUid || record.sourceProof?.series_uid};
  }
  handle("imageMenu", payload => {
    const target = payload?.source;
    if (!target || !['input','result'].includes(target.kind)) throw new Error('Invalid image source.');
    const publication = target.kind === 'result' ? results.get(target.id) : null;
    const record = publication?.record || (target.kind === 'input' ? files.get(target.id) : null);
    if (!record) throw new Error('Image source not found.');
    const source = sourceFor(record, publication);
    return showImageMenu(window, payload, {registry:exportIdentities,source});
  });
  handle("exportResults", (analysis, ids, language) => {
    validateAnalysis(analysis);
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw new Error('Select results to export.');
    const publications = [...new Set(ids)].map(id => {
      const result = results.get(id);
      if (!result || result.summary.analysis !== analysis) throw new Error('Selected result not found.');
      return {record:result.record,summary:JSON.parse(JSON.stringify(withStudy(result.summary)))};
    });
    return exportResults(window, publications, {registry:exportIdentities,sourceFor,dialog,language});
  });
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
      .map((r) => withStudy(r.summary))
      .filter((r) => r.analysis === analysis)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
  handle("assignXrayStudy", async (ids, study) => {
    if (selecting || batch?.state === "running") throw new Error("현재 작업을 완료하거나 취소한 뒤 실행하세요.");
    if (!Array.isArray(ids) || !ids.length || ids.length > 6000 ||
        ids.some(id => typeof id !== "string") || !study || typeof study !== "object")
      throw new Error("촬영 정보와 선택 영상을 확인하세요.");
    const fields = ["patientId", "patientIssuer", "studyDate"];
    if (fields.some(key => typeof study[key] !== "string" || !study[key].trim() || study[key].length > 120))
      throw new Error("환자번호·촬영일·기관을 입력하세요.");
    const date = study.studyDate.replaceAll("-", "");
    const parsed = new Date(date.slice(0, 4) + "-" + date.slice(4, 6) + "-" + date.slice(6, 8) + "T00:00:00Z");
    if (!/^[0-9]{8}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10).replaceAll("-", "") !== date)
      throw new Error("유효한 촬영일을 입력하세요.");
    for (const id of ids) {
      const record = files.get(id) || [...results.values()].find(r => r.record.id === id)?.record;
      if (record?.analysis !== "xray" || !record.metadata) throw new Error("촬영 정보와 선택 영상을 확인하세요.");
    }
    const value = { patientId: study.patientId.trim(), patientIssuer: study.patientIssuer.trim(), studyDate: date };
    const task = catalogQueue.then(async () => {
      const next = { ...studyAssignments, ...Object.fromEntries(ids.map(id => [id, value])) };
      const temporary = studyAssignmentsPath + "." + randomUUID() + ".tmp";
      await fsp.writeFile(temporary, JSON.stringify(next));
      await fsp.rename(temporary, studyAssignmentsPath);
      studyAssignments = next;
    });
    catalogQueue = task.catch(() => {});
    await task;
  });
  handle("assignPatientStudy", async (analysis, ids, study) => {
    if (selecting || batch?.state === "running") throw new Error("현재 작업을 완료하거나 취소한 뒤 실행하세요.");
    await patientAssignments.assign(analysis, ids, study,
      id => files.get(id) || [...results.values()].find(result => result.record.id === id)?.record);
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
          : { filters: [{ name: "Medical images", extensions: ["dcm", "nrrd", "nii", "gz", "zip"] }] }),
      });
      if (selection.canceled || disposed) return [];
      let sources = [];
      async function collect(directory, depth = 0) {
        if (depth > 12) throw new Error("폴더 깊이가 너무 큽니다. DICOM series 폴더를 선택하세요.");
        for (const item of await fsp.readdir(directory, { withFileTypes: true })) {
          if (item.isSymbolicLink()) continue;
          const full = path.join(directory, item.name);
          if (item.isDirectory()) await collect(full, depth + 1);
          else if (item.isFile() && !/\.(json|txt|md|csv|png|jpe?g|exe|py)$/i.test(item.name))
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
      const archives = sources.filter(source => /\.zip$/i.test(source));
      const extractedNames = new Map();
      if (archives.length) {
        sources = sources.filter(source => !/\.zip$/i.test(source));
        let imageBytes = 0;
        for (const source of sources) imageBytes += (await fsp.stat(source)).size;
        for (const archive of archives) {
          importProgress.current = path.basename(archive);
          importProgress.phase = "extract";
          publishImport();
          const snapshot = path.join(snapshots, randomUUID() + ".zip");
          await fsp.copyFile(archive, snapshot, fs.constants.COPYFILE_EXCL);
          const destination = path.join(importRoot, "extracted", randomUUID());
          const entries = await request("extract", {
            archive: snapshot, destination,
            maxFiles: 6000 - sources.length, maxBytes: 20 * 1024 ** 3 - imageBytes,
          });
          for (const entry of entries) {
            if (!inside(entry.path) || path.dirname(entry.path) !== destination)
              throw new Error("ZIP 내부 경로가 올바르지 않습니다.");
            sources.push(entry.path);
            extractedNames.set(entry.path, entry.name);
            imageBytes += entry.bytes;
          }
          await fsp.rm(snapshot, { force: true });
        }
        importProgress.total = sources.length;
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
            importProgress.current = extractedNames.get(source) || path.basename(source);
            importProgress.phase = "copy";
            publishImport();
            const ext = source.toLowerCase().endsWith(".nii.gz") ? ".nii.gz" : path.extname(source);
            const snapshot = path.join(snapshots, randomUUID() + ext);
            if (extractedNames.has(source)) await fsp.rename(source, snapshot);
            else await fsp.copyFile(source, snapshot, fs.constants.COPYFILE_EXCL);
            paths.push(snapshot);
            names[snapshot] = extractedNames.get(source) || path.basename(source);
          }
          importProgress.phase = "inspect";
          publishImport();
          const inspection = {
            analysis, paths, names, consumeSnapshots: true,
            destination: path.join(importRoot, randomUUID().replaceAll("-", "").slice(0, 16)),
          };
          if (analysis === "xray") {
            const runId = randomUUID();
            try {
              if (analysisAuthorization?.authorizeModel) {
                const challenge = await request('model_challenge', {runId});
                const job = {analysis:'xray-classifier',paths,destination:inspection.destination};
                inspection.authorization = await analysisAuthorization.authorizeModel({runId,job,challenge});
                inspection.runId = runId;
              } else await authorize(runId, "xray-classifier");
            } catch {
              inspection.classificationDenied = true;
              if (analysisAuthorization?.authorizeModel) await request('model_discard', {runId});
            }
          }
          if (disposed) break;
          rows = await request("inspect", inspection);
        } catch (error) {
          if (disposed) break;
          rows = [{ id: randomUUID(), analysis, name: extractedNames.get(sourcePaths[0]) || path.basename(sourcePaths[0]),
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
      for (const temporary of [snapshots, path.join(importRoot, "extracted")])
        if (inside(temporary)) await fsp.rm(temporary, {
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
    ) {
      if (["failed", "interrupted"].includes(prior.summary.meshState)) {
        const retry = { ...prior, summary: { ...prior.summary, meshState: "pending" } };
        await publishResult(retry, prior);
        queueMesh(retry);
        return retry.summary;
      }
      return prior.summary;
    }
    const task = (async () => {
      const result = await request("finalize", {
        id,
        variant,
        record: prior.record,
        result: prior.result,
        createdAt: prior.summary.createdAt,
        deferMesh: true,
      });
      await publishResult(result);
      queueMesh(result);
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
    const started = performance.now();
    const timings = {};
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
      timings.admissionWait = (performance.now() - started) / 1000;
      if (signal.aborted) throw aborted();
      taskState(task, { stage: "입력 확인", lane: "prepare" });
      let phase = performance.now();
      file = await prepareInput(file, confirmed, signal);
      timings.input = (performance.now() - phase) / 1000;
      if (signal.aborted) throw aborted();
      taskState(task, { stage: device === "cpu" ? "모델 준비" : "GPU 차례 대기", lane: "waiting" });
      phase = performance.now();
      modelSlot = await pipelineResources.model.acquire(1, signal);
      gpu = await pipelineResources.gpu.acquire(1, signal);
      timings.gpuWait = (performance.now() - phase) / 1000;
      if (signal.aborted) throw aborted();
      const id = randomUUID(), directory = path.join(runs, id);
      await fsp.mkdir(directory);
      const route = file.classification?.route_to_segmentation;
      const engine = file.analysis === "xray" ? (route === "AP" ? "ap" : "lat") : file.analysis;
      const job = { id: file.id, input: file.input, analysis: file.analysis, route, device, output: path.join(directory, "output") };
      await fsp.writeFile(path.join(directory, "job.json"), JSON.stringify(job));
      if (signal.aborted) throw aborted();
      // Authorize each run after waiting; expiry never cancels a run already admitted here.
      if (analysisAuthorization) {
        taskState(task, { stage: "분석 권한 확인", lane: "waiting", progress: null });
        const authorizationStarted = performance.now();
        await authorize(id, engine, signal);
        timings.authorization = (performance.now() - authorizationStarted) / 1000;
      }
      const model = modelWorker(engine);
      let modelAuthorization;
      if (analysisAuthorization?.authorizeModel) {
        const authorizationStarted = performance.now();
        const challenge = await model.request({ operation: "model_challenge", runId: id, engine: require('./security/model-package.cjs').modelId(job) }, { timeout: 15000 });
        try {
          modelAuthorization = await analysisAuthorization.authorizeModel({ runId: id, job, challenge, signal });
          if (signal.aborted) throw aborted();
        } catch (error) {
          model.send({ operation: "model_discard", id, runId: id });
          throw error;
        }
        timings.authorization += (performance.now() - authorizationStarted) / 1000;
      }
      taskState(task, { stage: "모델 준비", lane: device === "cpu" ? "cpu" : "gpu", progress: null });
      phase = performance.now();
      // Keys/proofs travel only over the private process pipe, never job.json, logs or renderer IPC.
      const request = model.request({ operation: "run", job, ...(modelAuthorization ? { authorization: modelAuthorization } : {}) }, {
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
      modelAuthorization = undefined;
      const complete = await request;
      timings.modelProcess = (performance.now() - phase) / 1000;
      gpu?.release(); gpu = undefined;
      modelSlot?.release(); modelSlot = undefined;
      if (signal.aborted) throw aborted();
      const resultPath = complete.result;
      if (!complete.complete || !inside(resultPath) || !resultPath.startsWith(directory + path.sep))
        throw new Error("모델 결과 경로를 확인하지 못했습니다.");
      cpu?.release(); cpu = undefined;
      if (estimate.finalize) memory.resize(Math.min(estimate.cpu, estimate.finalize));
      taskState(task, { stage: "결과 준비 차례 대기", lane: "waiting", progress: null });
      phase = performance.now();
      finalize = await resultLane.acquire(1, signal);
      timings.resultWait = (performance.now() - phase) / 1000;
      if (signal.aborted) throw aborted();
      taskState(task, { stage: "측정·Overlay 준비", lane: "cpu", progress: null });
      phase = performance.now();
      const result = await resultWorker().request({
        operation: "finalize", record: file, result: resultPath, id, createdAt: new Date().toISOString(), deferMesh: true,
      }, { id, timeout: 20 * 60000 });
      if (signal.aborted) throw aborted();
      timings.resultPreparation = (performance.now() - phase) / 1000;
      timings.ready = (performance.now() - started) / 1000;
      result.summary.timings = { ...result.summary.timings, ...timings };
      await publishResult(result);
      batch.completed.push(result.summary);
      finalize.release(); finalize = undefined;
      memory.release(); memory = undefined;
      queueMesh(result, pipelineController.signal, pipelineResources.memory);
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
    batchStarted = performance.now();
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
      resultRevision,
    };
    runPromise = (async () => {
      try {
        await runPipeline(targets, {
          signal: pipelineController.signal, concurrency: batch.concurrency,
          execute: file => execute(file, confirmedIds.includes(file.id), device),
          failed: (file, error) => batch.failed.push({ id: file.id, name: file.name, error: error.message }),
        });
        if (!cancelled) batch.stage = "3D 준비";
        await meshQueue;
      } finally {
        await closeAnalysisWorkers(cancelled);
        powerSaveBlocker.stop(powerBlocker);
      }
      batch.state = cancelled ? "cancelled" : batch.failed.length ? "failed" : "complete";
      batch.elapsedSeconds = (performance.now() - batchStarted) / 1000;
      batch.stage = cancelled ? "취소됨" : "완료";
      await fsp.writeFile(path.join(storageRoot, `batch-${batch.id}.timings.json`), JSON.stringify({
        id: batch.id, analysis: batch.analysis, state: batch.state, total: batch.total,
        elapsedSeconds: batch.elapsedSeconds,
        results: batch.completed.map(row => ({ id: row.id, meshState: row.meshState, timings: row.timings })),
        failed: batch.failed,
      })).catch(error => console.error("Batch timing report could not be saved", error));
    })();
    return { ...batch };
  });
  handle("job", () => batch && { ...batch,
    elapsedSeconds: batch.state === "running" ? (performance.now() - batchStarted) / 1000 : batch.elapsedSeconds });
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
      await runPromise;
      disposed = true;
      await closeAnalysisWorkers(true);
      await meshQueue;
      channels.forEach((channel) => ipcMain.removeHandler(channel));
      await stopWorker();
    },
  };
}

module.exports = { installImaging };
