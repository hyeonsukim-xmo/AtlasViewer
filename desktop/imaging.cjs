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
const { diagnose, workerError, userError } = require('./diagnostics.cjs');

const {solutions, resolveSolution, solutionFields, matchesSolution} = require('./solutions.cjs');
const {createResultIdentities} = require('./result-identities.cjs');

function installImaging(window, { engineRoot, storageRoot, scriptsRoot, palette, analysisAuthorization, artifactStorage, originStoreId, installations }) {
  if (analysisAuthorization !== undefined && typeof analysisAuthorization?.authorize !== "function")
    throw userError("분석 권한 확인 모듈을 초기화하지 못했습니다.");
  async function authorize(runId, engine, signal) {
    if (!analysisAuthorization) return;
    const grant = await analysisAuthorization.authorize({ runId, engine, signal });
    if (grant?.runId !== runId || grant.engine !== engine || !["VALID", "GRACE"].includes(grant.state))
      throw userError("분석 권한을 확인하지 못했습니다. 신규 분석을 시작하지 않습니다.");
    if (signal?.aborted) throw aborted();
  }
  fs.mkdirSync(storageRoot, { recursive: true });
  const diagnostic = (error, stage, code, caseId) => diagnose(error, {stage, code, caseId, logRoot:storageRoot});
  const exportIdentities = createExportIdentities(storageRoot);
  const patientAssignments = createPatientAssignments(storageRoot);
  const sourceMetadata = createSourceMetadata(storageRoot);
  const identities = createResultIdentities(storageRoot, originStoreId);
  const channels = [],
    files = new Map(),
    results = new Map();
  let worker, workerContext,
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
  const modelWorkers = new Map(), scopedWorkers = new Map();
  function runtime(name, args, context) {
    const root=context?.engineRoot??engineRoot, scripts=context?.scriptsRoot??scriptsRoot;
    const portable=path.join(root,'python','python.exe');
    return fs.existsSync(portable)?{python:portable,args:['-I','-B','-X','utf8',path.join(scripts,'runtime_bootstrap.py'),'--site',path.join(root,'envs',name,'Lib','site-packages'),'--',...args]}:
      {python:python(name),args:['-X','utf8',...args]};
  }
  function scopedWorker(context, engine, scope='') {
    const key=context.engineRoot+':'+engine+scope;
    let item=scopedWorkers.get(key);
    if (!item || item.worker.closed) {
      item?.release();
      const reader=engine==='reader';
      item={release:installations.retain(context),worker:new AnalysisWorker({
        ...runtime(engine,[path.join(context.scriptsRoot,reader?'imaging-worker.py':'model-service.py'),'--engine-root',context.engineRoot,
          ...(reader?['--palette',context.palette,'--reader-id',context.readerId]:[])],context),
        env:workerEnv(),logPath:path.join(storageRoot,reader?'finalize-private.log':`model-${engine}-private.log`),artifactStorage,
      })};scopedWorkers.set(key,item);
    }return item.worker;
  }
  function modelWorker(engine,context) {
    if(context)return scopedWorker(context,engine);
    if (!modelWorkers.has(engine) || modelWorkers.get(engine).closed) modelWorkers.set(engine, new AnalysisWorker({
      ...runtime(engine,[path.join(scriptsRoot, "model-service.py"), "--engine-root", engineRoot]),
      env: workerEnv(), logPath: path.join(storageRoot, `model-${engine}-private.log`),
      artifactStorage,
    }));
    return modelWorkers.get(engine);
  }
  function resultWorker(context) {
    if(context)return scopedWorker(context,'reader');
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
    await Promise.allSettled([...scopedWorkers.values()].map(async item=>{try{await (force?item.worker.stop():item.worker.close());}finally{item.release();}}));
    scopedWorkers.clear();await installations?.collect();
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
    installations ? Boolean(installations.status().solutions.find(row=>row.analysis===analysis)?.installed) : fs.existsSync(path.join(engineRoot, "verified-packages.json")) &&
    resolveSolution(analysis).runtimes.every((name) =>
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
    solutionId,
    workflowId,
    metadata,
    sourceProof,
    classification,
    confirmation,
    ready,
    deferredValidation,
    warnings,
    error,
    diagnostic,
  }) => withStudy({ id, name, analysis, ...solutionFields({analysis, solutionId, workflowId}), metadata: metadata ? {...metadata,
    studyUid: metadata.studyUid || sourceProof?.study_uid, seriesUid: metadata.seriesUid || sourceProof?.series_uid} : metadata,
    classification, confirmation, ready, deferredValidation, warnings, error, diagnostic });
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
      if(installations && !result.readerId)result.readerId=installations.legacyReader();
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
  async function publicSummary(result) {
    const summary = {...result.summary, ...solutionFields(result.summary)};
    // Identity migration is additive: a storage error must not hide a completed analysis.
    delete summary.originStoreId; delete summary.originResultId; delete summary.analysisRevision;
    delete summary.identityDiagnostic;
    try {Object.assign(summary, await identities.get(result));}
    catch (error) {summary.identityDiagnostic = diagnostic(error, '결과 식별 정보', 'RESULT_IDENTITY', summary.id);}
    return withStudy(summary);
  }
  function getResult(id) {
    const result = results.get(id);
    if (result) {
      const fields = solutionFields(result.summary);
      if (!matchesSolution(result.record, fields.solutionId)) throw userError('결과의 솔루션과 입력 경로가 일치하지 않습니다.');
    }
    return result;
  }
  function publishResult(result, expected) {
    const task = publicationQueue.then(async () => {
      const id = result.summary.id;
      // A late mesh for a previous variant must never replace the current result.
      if (expected && results.get(id) !== expected) return false;
      result.summary = {...result.summary, ...solutionFields(result.record)};
      result.summary = await publicSummary(result);
      result.record = {...result.record, ...solutionFields(result.record)};
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
      let slot, memory, context;
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
        if(installations)context=await installations.acquire('reader',result.readerId);
        const updated = await resultWorker(context).request({ operation: "mesh", publication: result }, { timeout: 20 * 60000 });
        if (signal?.aborted || disposed) throw aborted();
        updated.summary.timings.meshWait = meshWait;
        await publishResult(updated, result);
      } catch (error) {
        const updated = { ...result, summary: { ...result.summary,
          meshDiagnostic: diagnostic(error, 'mesh', signal?.aborted || disposed ? 'CANCELLED' : 'MESH_BUILD', result.summary.id),
          meshState: signal?.aborted || disposed ? "interrupted" : "failed" } };
        await publishResult(updated, result);
      } finally {
        slot?.release(); memory?.release(); context?.release();
      }
    }).catch(error => {
      // Retain the early publication even if persisting mesh status fails.
      console.error("Mesh publication failed", error);
    });
  }
  function validateAnalysis(value) {
    if (!["ct", "mri", "xray"].includes(value)) throw userError("분석 작업을 먼저 선택하세요.");
  }
  function getFile(analysis, id) {
    validateAnalysis(analysis);
    const file = files.get(id);
    if (!file || !matchesSolution(file, analysis) || !file.input)
      throw userError("이 분석 작업에 영상을 다시 추가하세요.");
    return withStudy({...file,...solutionFields(file)});
  }
  function stopWorker(message = "영상 확인 작업이 중단되었습니다. 다시 시도하세요.", code = 'ENGINE_STOPPED') {
    const old = worker;
    const context=workerContext;workerContext=undefined;
    worker = undefined;
    pending?.reject(workerError({error:message,errorCode:code}));
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
    workerShutdown=workerShutdown.finally(()=>context?.release());return workerShutdown;
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
  function startWorker(context) {
    if (worker) return worker;
    const command=context?runtime('reader',[path.join(context.scriptsRoot,'imaging-worker.py'),'--engine-root',context.engineRoot,'--palette',context.palette,'--reader-id',context.readerId],context):runtime('ct',[path.join(scriptsRoot,'imaging-worker.py'),'--engine-root',engineRoot,'--palette',palette]);
    if (!fs.existsSync(command.python)) throw userError("로컬 분석 엔진을 준비해야 합니다.", 'ENGINE_MISSING');
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
    workerContext=context;
    const log = fs.createWriteStream(path.join(storageRoot, "preview-private.log"), { flags: "a" });
    log.on('error', error => {
      if (worker === process) { pending?.reject(error); stopWorker(); }
    });
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
        response.error ? task.reject(workerError(response)) : task.resolve(response.result);
      } catch {
        /* Third-party informational stdout is never an IPC response. */
      }
    });
    process.once("error", () => {
      if (worker === process) stopWorker("영상 확인 프로세스를 시작하지 못했습니다.", 'ENGINE_START');
    });
    process.once("exit", () => {
      log.end();
      if (worker === process) stopWorker();
    });
    if (artifactStorage) process.stdin.write(JSON.stringify({operation:'storage_init',...artifactStorage})+'\n');
    return process;
  }
  function request(operation, values = {}, signal, readerId) {
    const task = queue.then(async () => {
      await workerShutdown;
      if (signal?.aborted) throw aborted();
      if (disposed) throw userError("앱이 종료되었습니다.");
      if(installations && (!worker || workerContext?.requestedReaderId!==(readerId??installations.reader()))){
        await stopWorker();const context=await installations.acquire('reader',readerId);
        context.requestedReaderId=readerId??installations.reader();
        try{startWorker(context);}catch(error){context.release();throw error;}
      }
      const process = startWorker();
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(
          () => stopWorker("영상 처리 시간이 초과되었습니다. 다시 시도하세요.", 'TIMEOUT'),
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
    const checked = task.catch(error => {
      diagnostic(error, operation, {inspect:'INPUT_READ',extract:'INPUT_READ',preview:'OVERLAY',prepare:'INPUT_READ',finalize:'RESULT_PROCESS',model_challenge:'AUTHORIZATION',mutation_challenge:'AUTHORIZATION',snapshot:'RESULT_INVALID'}[operation], values.record?.id || values.id);
      throw error;
    });
    queue = checked.catch(() => {});
    return checked;
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
        throw userError("Desktop 분석 화면에서만 사용할 수 있습니다.");
      try {
        if (['status','list','results','choose','preview','run','cancel','clear','exportResults','assignPatientStudy'].includes(name))
          args[0] = resolveSolution(args[0]).analysis;
        return { ok: true, value: await action(...args) };
      } catch (error) {
        const issue = diagnostic(error, {choose:'입력 등록', preview:'영상·Overlay 표시', resultPreview:'영상·Overlay 표시', variant:'후처리', run:'분석 시작', exportResults:'결과 내보내기', imageMenu:'결과 내보내기'}[name] || name,
          {choose:'INPUT_READ', preview:'OVERLAY', resultPreview:'OVERLAY', variant:'POSTPROCESS', exportResults:'RESULT_SAVE', imageMenu:'RESULT_SAVE'}[name]);
        return {
          ok: false,
          error: issue.message, diagnostic: issue,
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
  handle("solutions", () => solutions);
  handle("imageMenu", payload => {
    const target = payload?.source;
    if (!target || !['input','result'].includes(target.kind)) throw new Error('Invalid image source.');
    const publication = target.kind === 'result' ? getResult(target.id) : null;
    const record = publication?.record || (target.kind === 'input' ? files.get(target.id) : null);
    if (!record) throw new Error('Image source not found.');
    solutionFields(record);
    const source = sourceFor(record, publication);
    return showImageMenu(window, payload, {registry:exportIdentities,source});
  });
  handle("exportResults", (analysis, ids, language) => {
    validateAnalysis(analysis);
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw new Error('Select results to export.');
    const publications = [...new Set(ids)].map(id => {
      const result = getResult(id);
      if (!result || !matchesSolution(result.summary, analysis) || !matchesSolution(result.record, analysis)) throw new Error('Selected result not found.');
      return {record:result.record,summary:JSON.parse(JSON.stringify(withStudy(result.summary)))};
    });
    return exportResults(window, publications, {registry:exportIdentities,sourceFor,dialog,language});
  });
  handle("status", (analysis) => {
    validateAnalysis(analysis);
    const installed=installations?.status().solutions.find(row=>row.analysis===analysis);
    return {
      reviewAvailable: installations?Boolean(installations.reader()):available(analysis),
      estimationAvailable: installed?installed.installed && installed.state!=='repair-required':available(analysis),
      ...(installed?{installation:installed.state,version:installed.version}:{}),
      device: analysis === "xray" ? "GPU" : "GPU · FP32",
      release: "20260927",
      importProgress: importProgress?.analysis === analysis ? importProgress : null,
    };
  });
  handle("list", (analysis) => {
    validateAnalysis(analysis);
    return [...files.values()].filter((f) => matchesSolution(f, analysis)).map(publicFile);
  });
  handle("results", async (analysis) => {
    const summaries = [];
    for (const result of results.values()) {
      if (matchesSolution(result.summary, analysis) && matchesSolution(result.record, analysis))
        summaries.push(await publicSummary(result));
    }
    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
  handle("assignXrayStudy", async (ids, study) => {
    if (selecting || batch?.state === "running") throw userError("현재 작업을 완료하거나 취소한 뒤 실행하세요.");
    if (!Array.isArray(ids) || !ids.length || ids.length > 6000 ||
        ids.some(id => typeof id !== "string") || !study || typeof study !== "object")
      throw userError("촬영 정보와 선택 영상을 확인하세요.");
    const fields = ["patientId", "patientIssuer", "studyDate"];
    if (fields.some(key => typeof study[key] !== "string" || !study[key].trim() || study[key].length > 120))
      throw userError("환자번호·촬영일·기관을 입력하세요.");
    const date = study.studyDate.replaceAll("-", "");
    const parsed = new Date(date.slice(0, 4) + "-" + date.slice(4, 6) + "-" + date.slice(6, 8) + "T00:00:00Z");
    if (!/^[0-9]{8}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10).replaceAll("-", "") !== date)
      throw userError("유효한 촬영일을 입력하세요.");
    for (const id of ids) {
      const record = files.get(id) || [...results.values()].find(r => r.record.id === id)?.record;
      if (!record || !matchesSolution(record, "xray") || !record.metadata) throw userError("촬영 정보와 선택 영상을 확인하세요.");
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
    if (selecting || batch?.state === "running") throw userError("현재 작업을 완료하거나 취소한 뒤 실행하세요.");
    await patientAssignments.assign(analysis, ids, study,
      id => {
        const record = files.get(id) || [...results.values()].find(result => result.record.id === id)?.record;
        return record && matchesSolution(record, analysis) ? record : undefined;
      });
  });
  handle("choose", async (analysis, folder = false, language = "ko") => {
    validateAnalysis(analysis);
    if (typeof folder !== "boolean") throw userError("잘못된 입력 선택입니다.");
    if (language !== "ko" && language !== "en") throw new Error("Invalid language.");
    if (selecting) return [];
    if (batch?.state === "running")
      throw userError("실행 중인 분석을 완료하거나 취소한 뒤 영상을 추가하세요.");
    if (!available(analysis)) throw userError("로컬 분석 엔진을 준비해야 합니다.");
    selecting = true;
    let importRoot, importContext;
    try {
      const selection = await dialog.showOpenDialog(window, {
        title:
          language === "en"
            ? `${analysis.toUpperCase()} · Add ${folder ? "DICOM folder" : "images"}`
            : `${analysis.toUpperCase()} · ${folder ? "DICOM 폴더" : "영상 파일"} 추가`,
        properties: folder ? ["openDirectory", "multiSelections"] : ["openFile", "multiSelections"],
        ...(folder
          ? {}
          : { filters: [{ name: "Medical images", extensions: ["dcm", "nrrd", "nii", "gz", "zip"] }] }),
      });
      if (selection.canceled || disposed) return [];
      if(installations && analysis==='xray')importContext=await installations.acquire(analysis);
      const inspectRequest=(operation,values)=>importContext?resultWorker(importContext).request({operation,...values},{id:values.id??randomUUID(),timeout:5*60000}):request(operation,values);
      let sources = [];
      const visitedDirectories = new Set();
      async function collect(directory, depth = 0) {
        if (depth > 12) throw userError("폴더 깊이가 너무 큽니다. DICOM series 폴더를 선택하세요.");
        const realDirectory = await fsp.realpath(directory);
        const key = process.platform === "win32" ? realDirectory.toLowerCase() : realDirectory;
        if (visitedDirectories.has(key)) return;
        visitedDirectories.add(key);
        for (const item of await fsp.readdir(directory, { withFileTypes: true })) {
          if (item.isSymbolicLink()) continue;
          const full = path.join(directory, item.name);
          if (item.isDirectory()) await collect(full, depth + 1);
          else if (item.isFile() && !/\.(json|txt|md|csv|png|jpe?g|exe|py)$/i.test(item.name))
            sources.push(full);
          if (sources.length > 6000)
            throw userError("한 번에 6,000개 이하의 DICOM 파일을 선택하세요.");
        }
      }
      if (folder) {
        for (const directory of selection.filePaths) await collect(directory);
      }
      else sources.push(...selection.filePaths);
      if (!sources.length) throw userError("선택한 폴더에 영상 파일이 없습니다.");
      importProgress = { analysis, ...solutionFields({analysis}), completed: 0, total: sources.length, current: "", phase: "copy", failed: 0 };
      publishImport();
      importRoot = path.join(storageRoot, "imports", randomUUID());
      const snapshots = path.join(importRoot, "snapshots");
      await fsp.mkdir(snapshots, { recursive: true });
      let total = 0;
      for (const source of sources) {
        const stat = await fsp.stat(source);
        total += stat.size;
        if (!stat.isFile() || stat.size > 2 * 1024 ** 3 || total > 20 * 1024 ** 3)
          throw userError("파일당 2 GB, 한 번에 20 GB 이하의 영상을 선택하세요.");
      }
      const archives = sources.filter(source => /\.zip$/i.test(source));
      const extractedNames = new Map();
      const imported = [];
      if (archives.length) {
        sources = sources.filter(source => !/\.zip$/i.test(source));
        let imageBytes = 0;
        for (const source of sources) imageBytes += (await fsp.stat(source)).size;
        for (const archive of archives) {
          importProgress.current = path.basename(archive);
          importProgress.phase = "extract";
          publishImport();
          try {
          const snapshot = path.join(snapshots, randomUUID() + ".zip");
          await fsp.copyFile(archive, snapshot, fs.constants.COPYFILE_EXCL);
          const destination = path.join(importRoot, "extracted", randomUUID());
          const entries = await request("extract", {
            archive: snapshot, destination,
            maxFiles: 6000 - sources.length, maxBytes: 20 * 1024 ** 3 - imageBytes,
          });
          for (const entry of entries) {
            if (!inside(entry.path) || path.dirname(entry.path) !== destination)
              throw userError("ZIP 내부 경로가 올바르지 않습니다.");
            sources.push(entry.path);
            extractedNames.set(entry.path, entry.name);
            imageBytes += entry.bytes;
          }
          await fsp.rm(snapshot, { force: true });
          } catch (error) {
            const id = randomUUID(), issue = diagnostic(error, 'extract', 'INPUT_READ', id);
            const row = {id,analysis,name:path.basename(archive),ready:false,warnings:[],error:issue.message,diagnostic:issue};
            Object.assign(row,solutionFields(row));files.set(id,row);imported.push(row);await saveCatalog();
            importProgress.failed++;publishImport([row]);
          }
        }
        importProgress.total = sources.length + imported.length;
        importProgress.completed = imported.length;
      }
      const standalone = sources.filter(p => /\.(nrrd|nii|nii\.gz)$/i.test(p));
      const dicom = sources.filter(p => !standalone.includes(p));
      const groups = standalone.map(p => [p]);
      if (dicom.length) groups.push(dicom); // Never split a DICOM series into slices.
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
                const challenge = await inspectRequest('model_challenge', {runId});
                const job = {analysis:'xray-classifier',...solutionFields({analysis:'xray'}),paths,destination:inspection.destination};
                Object.assign(inspection,solutionFields({analysis:'xray'}));
                inspection.authorization = await analysisAuthorization.authorizeModel({runId,job,challenge,context:importContext});
                inspection.runId = runId;
              } else await authorize(runId, "xray-classifier");
            } catch {
              inspection.classificationDenied = true;
              if (analysisAuthorization?.authorizeModel) await inspectRequest('model_discard', {runId});
            }
          }
          if (disposed) break;
          rows = await inspectRequest("inspect", inspection);
        } catch (error) {
          if (disposed) break;
          const issue = diagnostic(error, 'inspect', 'INPUT_READ');
          rows = [{ id: randomUUID(), analysis, name: extractedNames.get(sourcePaths[0]) || path.basename(sourcePaths[0]),
            ready: false, warnings: [], error: issue.message, diagnostic:issue }];
        }
        for (const row of rows) {
          if (row.error && !row.diagnostic) {
            const cause = row.errorCode ? workerError(row) : userError(row.error,
              row.classification?.status === 'license_required' ? 'AUTHORIZATION' : 'INPUT_INVALID');
            row.diagnostic = diagnostic(cause, row.classification ? '촬영 방향 분류' : '입력 확인', 'INPUT_READ', row.id);
            row.error = row.diagnostic.message;
          }
          Object.assign(row,solutionFields(row));
          files.set(row.id, row);
        }
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
      importContext?.release();
      if(importContext){const key=importContext.engineRoot+':reader',item=scopedWorkers.get(key);if(item){await item.worker.close();item.release();scopedWorkers.delete(key);}}
      await installations?.collect();
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
      throw userError("잘못된 preview 옵션입니다.");
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
    const result = getResult(id);
    if (!result) throw userError("완료된 결과를 선택하세요.");
    return request("preview", {
      ...options(value),
      record: result.record,
      mask: result.mask,
      sideMask: result.sideMask,
      rows: result.summary.rows,
    },undefined,result.readerId);
  });
  handle('sceneFailure', (id, code, reference) => {
    if (!results.has(id) || !['MESH_READ','MESH_INVALID','GPU_RENDER','FILE_MISSING','ACCESS_DENIED','PATH_TOO_LONG','MEMORY'].includes(code) || !/^[a-f0-9-]{36}$/.test(reference))
      throw userError('잘못된 preview 옵션입니다.');
    return diagnostic(Object.assign(new Error('Renderer reported a result display failure'), {diagnosticCode:code,reference}), '3D 표시', code, id);
  });
  const preparingResults = new Map();
  handle("variant", async (id, variant) => {
    if (preparingResults.has(id)) await preparingResults.get(id);
    const prior = getResult(id);
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
      throw userError("지원하는 결과 variant를 선택하세요.");
    if (batch?.state === "running")
      throw userError("실행 중인 분석이 끝난 뒤 variant를 변경하세요.");
    if (
      variant === prior.summary.variant &&
      prior.summary.laterality?.method === "femur_components_lps_v1"
    ) {
      if (["failed", "interrupted"].includes(prior.summary.meshState)) {
        const retry = { ...prior, summary: { ...prior.summary, meshState: "pending", meshDiagnostic:undefined } };
        await publishResult(retry, prior);
        queueMesh(retry);
        return retry.summary;
      }
      return publicSummary(prior);
    }
    const task = (async () => {
      // A saved variant is a read; only a new calculation needs a fresh authorization.
      const saved = await request('snapshot', {result:prior.result,variant,adopt:true},undefined,prior.readerId);
      if (saved) {
        if(installations && !saved.readerId)saved.readerId=prior.readerId;
        await publishResult(saved);
        queueMesh(saved);
        return saved.summary;
      }
      const values = {
        id,
        variant,
        record: prior.record,
        result: prior.result,
        createdAt: prior.summary.createdAt,
        deferMesh: true,
      };
      const context=installations?await installations.acquire(prior.summary.analysis):undefined;
      const mutationScope=':mutation:'+randomUUID();
      const mutateRequest=(operation,values)=>context?scopedWorker(context,'reader',mutationScope).request({operation,...values},{id:values.id??randomUUID(),timeout:20*60000}):request(operation,values);
      try {
      if (analysisAuthorization) {
        if (!analysisAuthorization.authorizeMutation) throw userError('새 후처리의 실행 권한을 확인하지 못했습니다.', 'AUTHORIZATION');
        const fixed = await request('snapshot', {result:prior.result,variant:prior.summary.variant,adopt:true},undefined,prior.readerId);
        const identity = await identities.bindSnapshot(prior,fixed._snapshot.snapshotDigest);
        const source = {originStoreId:identity.originStoreId,originResultId:identity.originResultId,analysisRevision:identity.analysisRevision,...fixed._snapshot};
        const job = {analysis:prior.summary.analysis,...solutionFields(prior.record),...values,source};
        const runId = randomUUID(), challenge = await mutateRequest('mutation_challenge', {runId,job});
        let authorization;
        try {authorization = await analysisAuthorization.authorizeMutation({runId,job,challenge,context});}
        catch (error) {
          await mutateRequest('mutation_discard',{runId});
          diagnostic(error,'후처리','AUTHORIZATION',id);
          throw error;
        }
        Object.assign(values,{runId,mutationJob:job,authorization});
      }
      const result = await mutateRequest("finalize", values);
      await publishResult(result);
      queueMesh(result);
      return result.summary;
      }finally{
        if(context){const key=context.engineRoot+':reader'+mutationScope,item=scopedWorkers.get(key);
          try{await item?.worker.close();}finally{item?.release();scopedWorkers.delete(key);context.release();await installations.collect();}}
      }
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
    let memory, modelSlot, gpu, cpu, finalize, context;
    const estimate = estimateMemory(file);
    try {
      memory = await pipelineResources.memory.acquire(estimate.gpu, signal);
      timings.admissionWait = (performance.now() - started) / 1000;
      if (signal.aborted) throw aborted();
      if(installations){taskState(task,{stage:'설치 파일 검증',lane:'waiting'});const verificationStarted=performance.now();context=await installations.acquire(file.analysis);timings.runtimeVerification=(performance.now()-verificationStarted)/1000;}
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
      const job = { id: file.id, input: file.input, analysis: file.analysis, ...solutionFields(file), route, device, output: path.join(directory, "output") };
      await fsp.writeFile(path.join(directory, "job.json"), JSON.stringify(job));
      if (signal.aborted) throw aborted();
      // Authorize each run after waiting; expiry never cancels a run already admitted here.
      if (analysisAuthorization && !analysisAuthorization.authorizeModel) {
        taskState(task, { stage: "분석 권한 확인", lane: "waiting", progress: null });
        const authorizationStarted = performance.now();
        await authorize(id, engine, signal);
        timings.authorization = (performance.now() - authorizationStarted) / 1000;
      }
      const model = modelWorker(engine,context);
      let modelAuthorization;
      if (analysisAuthorization?.authorizeModel) {
        taskState(task, { stage: "분석 권한 확인", lane: "waiting", progress: null });
        const authorizationStarted = performance.now();
        const challenge = await model.request({ operation: "model_challenge", runId: id, engine: require('./security/model-package.cjs').modelId(job) }, { timeout: 15000 });
        try {
          modelAuthorization = await analysisAuthorization.authorizeModel({ runId: id, job, challenge, signal, context });
          if (signal.aborted) throw aborted();
        } catch (error) {
          model.send({ operation: "model_discard", id, runId: id });
          throw error;
        }
        timings.authorization = (timings.authorization || 0) + (performance.now() - authorizationStarted) / 1000;
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
        throw userError("모델 결과 경로를 확인하지 못했습니다.", 'RESULT_INVALID');
      cpu?.release(); cpu = undefined;
      if (estimate.finalize) memory.resize(Math.min(estimate.cpu, estimate.finalize));
      taskState(task, { stage: "결과 준비 차례 대기", lane: "waiting", progress: null });
      phase = performance.now();
      finalize = await resultLane.acquire(1, signal);
      timings.resultWait = (performance.now() - phase) / 1000;
      if (signal.aborted) throw aborted();
      taskState(task, { stage: "측정·Overlay 준비", lane: "cpu", progress: null });
      phase = performance.now();
      const result = await resultWorker(context).request({
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
    } catch (error) {
      const code = /권한/.test(task.stage) ? 'AUTHORIZATION' : /모델/.test(task.stage) ? 'MODEL_LOAD' :
        /입력/.test(task.stage) ? 'INPUT_READ' : /복원|정규화/.test(task.stage) ? 'RESTORE' :
        /검증/.test(task.stage) ? 'RESULT_INVALID' : /저장/.test(task.stage) ? 'RESULT_SAVE' :
        /측정|결과/.test(task.stage) ? 'RESULT_PROCESS' : /후처리/.test(task.stage) ? 'POSTPROCESS' : 'INFERENCE';
      diagnostic(error, task.stage, code, file.id);
      throw error;
    } finally {
      controller.abort();
      pipelineController.signal.removeEventListener("abort", abortTask);
      modelSlot?.release(); gpu?.release(); cpu?.release(); finalize?.release(); memory?.release();
      context?.release();
      batch.active = batch.active.filter(item => item !== task);
    }
  }
  handle("run", (analysis, ids, confirmedIds = [], device = "cuda:0") => {
    validateAnalysis(analysis);
    if (selecting || preparingResults.size || batch?.state === "running")
      throw userError("현재 작업을 완료하거나 취소한 뒤 실행하세요.");
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > files.size ||
      new Set(ids).size !== ids.length ||
      !Array.isArray(confirmedIds) ||
      !["cuda:0", "cpu"].includes(device)
    )
      throw userError("등록된 영상 중 분석할 대상을 선택하세요.");
    const targets = ids.map((id) => getFile(analysis, id));
    if (targets.some((f) => !f.ready || (f.confirmation && !confirmedIds.includes(f.id))))
      throw userError("분석 조건과 입력 단위/sequence를 확인하세요.");
    const powerBlocker = powerSaveBlocker.start("prevent-app-suspension");
    batchStarted = performance.now();
    cancelled = false;
    pipelineController = new AbortController();
    pipelineResources = resources();
    batch = {
      id: randomUUID(),
      analysis,
      ...solutionFields({analysis}),
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
          failed: (file, error) => {
            const issue = diagnostic(error, 'Segmentation', 'INFERENCE', file.id);
            batch.failed.push({ id:file.id, name:file.name, error:issue.message, diagnostic:issue });
          },
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
    if (selecting) throw userError("영상 가져오기가 끝난 뒤 목록을 비우세요.");
    await cancel(analysis);
    await request("clear");
    for (const [id, file] of files) {
      if (!matchesSolution(file, analysis)) continue;
      files.delete(id);
      if (
        file.input &&
        ![...files.values()].some(other => other.input && path.dirname(other.input) === path.dirname(file.input)) &&
        ![...results.values()].some((result) => path.dirname(result.record.input) === path.dirname(file.input))
      ) {
        const directory = path.dirname(file.input);
        if (inside(directory)) await fsp.rm(directory, { recursive: true, force: true });
      }
    }
    await saveCatalog();
  });
  return {
    async publicationSource(id, revision) {
      const result=getResult(id);
      if(!result)throw userError('저장된 결과를 찾을 수 없습니다.');
      const identity=await identities.get(result);
      if(revision!==identity.analysisRevision)throw userError('결과가 변경되었습니다. 현재 결과를 다시 선택하세요.');
      const fixed=await request('snapshot',{result:result.result,variant:result.summary.variant,adopt:true},undefined,result.readerId);
      if(!fixed)throw userError('확정된 결과를 확인하지 못했습니다.');
      await identities.bindSnapshot(result,fixed._snapshot.snapshotDigest);
      return {identity,summary:fixed.summary,result:fixed.result,variant:fixed.summary.variant,
        snapshotDigest:fixed._snapshot.snapshotDigest,readerId:result.readerId,
        meshFile:fixed.sideMask?path.join(path.dirname(fixed.sideMask),'surface.glb'):null};
    },
    async publicationMesh(source) {
      if(!source.meshFile || !fs.existsSync(source.meshFile))return null;
      const fixed=await request('snapshot',{result:source.result,variant:source.variant,adopt:false},undefined,source.readerId);
      if(fixed?._snapshot.snapshotDigest!==source.snapshotDigest)throw userError('게시 결과의 확정 사본이 변경되었습니다.');
      return source.meshFile;
    },
    async publicationPreview(source,value) {
      const fixed=await request('snapshot',{result:source.result,variant:source.variant,adopt:false},undefined,source.readerId);
      if(fixed?._snapshot.snapshotDigest!==source.snapshotDigest)throw userError('게시 결과의 확정 사본이 변경되었습니다.');
      return request('preview',{...options(value),record:fixed.record,mask:fixed.mask,sideMask:fixed.sideMask,rows:fixed.summary.rows},undefined,source.readerId);
    },
    async exportPublication(source,options) {
      const slot=await resultLane.acquire(1);let context,exporter;
      try{
        if(disposed)throw aborted();
        if(installations)context=await installations.acquire('reader',source.readerId);
        exporter=new AnalysisWorker({...runtime(context?'reader':'ct',[path.join(scriptsRoot,'publication-worker.py')],context?{...context,scriptsRoot}:undefined),
          env:workerEnv(),logPath:path.join(storageRoot,'publication-private.log'),artifactStorage,logResponses:false});
        return await exporter.request({operation:'publication_export',result:source.result,variant:source.variant,
          snapshotDigest:source.snapshotDigest,...options},{timeout:20*60000});
      }finally{try{await exporter?.close();}finally{slot.release();context?.release();}}
    },
    mesh(id) {
      const result = getResult(id);
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
