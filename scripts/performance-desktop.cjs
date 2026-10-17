// Real Desktop importer, model services and result workers. Electron shell alone is stubbed.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { spawn, execFileSync } = require('node:child_process');
const { parseArgs, isDeepStrictEqual } = require('node:util');
const root = path.resolve(__dirname, '..');
const CASES = {
  ct: ['ct', null, 'EXMO_CT/samples/EXMO_CASE_001/input_ct.nii.gz', 'EXMO_CT/results/EXMO_CASE_001/mask.nii.gz'],
  mri: ['mri', null, 'EXMO_MRI/samples/sample_01/W.nrrd', 'EXMO_MRI/samples/sample_01/raw/mask.nrrd'],
  ap: ['xray', 'AP', 'EXMO_XRAY/samples/AP/AP_01/input.nrrd', 'EXMO_XRAY/outputs/reference/AP/AP_01/mask.seg.nrrd'],
  lat_lt: ['xray', 'LAT_LT', 'EXMO_XRAY/samples/LAT_LT/LAT_LT_01/input.nrrd', 'EXMO_XRAY/outputs/reference/LAT_LT/LAT_LT_01/mask.seg.nrrd'],
  lat_rt: ['xray', 'LAT_RT', 'EXMO_XRAY/samples/LAT_RT/LAT_RT_01/input.nrrd', 'EXMO_XRAY/outputs/reference/LAT_RT/LAT_RT_01/mask.seg.nrrd'],
};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
  if (!sorted.length) return null;
  const n = sorted.length, mid = Math.floor(n/2);
  return { n, median: n%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2,
    min: sorted[0], max: sorted[n-1], p95: sorted[Math.ceil(n*.95)-1] };
}
function summarize(trials) {
  const names = [...new Set(trials.flatMap(row => Object.keys(row.seconds)))];
  const batches = [...new Map(trials.map(row=>[row.repetition,row])).values()];
  return Object.fromEntries(names.map(name => [name, stats((['batchWall','throughputCasesPerMinute'].includes(name)?batches:trials).map(row => row.seconds[name]))]));
}
function signature(check) {
  return {mask:check.maskPayloadSha256, related:check.relatedMasks || {}, measurements:check.measurements, qc:check.qc,
    overlays:Object.fromEntries(Object.entries(check.overlays).map(([view,value]) => [view,value.sha256]))};
}
function compare(current, baseline, threshold) {
  if(current.schema!==1 || !current.complete || Object.values(current.cases).some(item=>item.error)) throw Error('Current report is incomplete or failed');
  if (baseline.schema !== 1 || !baseline.complete || !baseline.passed) throw Error('Baseline must be a completed, passing performance report');
  if (!isDeepStrictEqual(current.environment, baseline.environment) ||
      current.options.device !== baseline.options.device || current.options.batchSize !== baseline.options.batchSize ||
      current.options.repeats !== baseline.options.repeats) throw Error('Incompatible baseline: hardware, runtimes, device or repetition/batch settings differ');
  const findings = [];
  for (const [name, item] of Object.entries(current.cases)) {
    const before = baseline.cases[name];
    if (!before || !isDeepStrictEqual(item.identity, before.identity)) throw Error(`Incompatible baseline input/model/recipe: ${name}`);
    if (!item.trials.length || !before.trials.length) { findings.push({case:name,type:'missing-trials'}); continue; }
    if (!item.trials.every(trial => isDeepStrictEqual(trial.execution, before.trials[0].execution)))
      throw Error(`Incompatible inference runtime/recipe: ${name}`);
    if (!item.trials.every(trial => isDeepStrictEqual(signature(trial.check),signature(before.trials[0].check))))
      findings.push({case:name,type:'output-changed'});
    for (const key of Object.keys(item.summary).filter(key=>key!=='throughputCasesPerMinute')) {
      const a=before.summary[key]?.median,b=item.summary[key]?.median;
      if (a == null || b == null || a <= 0) continue;
      const percent=(b/a-1)*100;
      findings.push({case:name,type:'timing',stage:key,before:a,after:b,percent,regression:percent>threshold && b-a>.1});
    }
  }
  return {thresholdPercent:threshold,passed:findings.every(row=>row.type==='timing' && !row.regression),findings};
}
function markdown(report) {
  const lines=['# Desktop performance', '', `Complete: ${report.complete}; passed: ${report.passed}`, '',
    ...(report.options?.repeats*report.options?.batchSize===1?['Single-trial diagnostic: completion does not establish repeatability.', '']:[]),
    'Seconds, median [min–max]. Fresh model processes per batch; OS cache is not flushed.',
    'Import/classification is measured once, separately. Batch size > 1 measures overlapping throughput, not isolated latency.', '',
    '## Pipeline stages', '',
    '| Stage | '+Object.keys(report.cases).join(' | ')+' |',
    '|---|'+Object.keys(report.cases).map(()=>'---:|').join('')];
  const fmt=value=>value ? value.n===1 ? value.median.toFixed(2) : `${value.median.toFixed(2)} [${value.min.toFixed(2)}–${value.max.toFixed(2)}]` : '—';
  lines.push('| Import / classification (one import) | '+Object.values(report.cases).map(item=>item.importSeconds?.toFixed(2)||'—').join(' | ')+' |');
  const stages={input:'Input preparation',authorization:'License authorization',modelStartup:'Engine startup / communication',model_integrity:'Worker authorization / package integrity',model_loading:'Model / checkpoint loading',model_decryption:'Authenticated model decryption',
      artifact_encrypt:'Artifact authenticated encryption',artifact_decrypt:'Artifact authenticated decryption',
      preprocessing:'Preprocessing',input_upload:'One-time input GPU upload',inference:'Inference',inference_with_resampling:'Legacy LAT combined inference / resampling',
    native_restore:'Native restoration',postprocessing:'Postprocessing',qc:'QC / entropy',measurement:'Native measurements',
    overlay_generation:'Export Overlay generation',export_metadata:'Slicer metadata construction',save:'Result serialization / copies',
    verification:'Hashes / readback verification',export:'Legacy combined save / verification',
    logits_validation:'Logits finite check',probability_conversion:'Logits to probabilities',probability_validation:'Probability validation',
    label_validation:'Label equality checks',ontology_identity:'Ontology hash',code_identity:'Source code hashes',
    environment_identity:'Runtime package versions',metadata_write:'JSON / CSV metadata writes',payload_hash:'Native payload hash',
    cleanup:'Garbage collection',other:'Other model work',
    cpu_wait:'CPU admission wait',metricsOverlay:'Desktop measurements / laterality / Overlay preparation',
    resultTransport:'Result worker startup / IPC / publication overhead',mesh:'3D generation',
    runtimeVerification:'Signed runtime verification',admissionWait:'Memory admission wait',gpuWait:'GPU admission wait',resultWait:'Result worker wait',meshWait:'3D queue wait'};
  for(const [key,label] of Object.entries(stages)){
    if(Object.values(report.cases).some(item=>item.summary?.[key]))
      lines.push('| '+label+' | '+Object.values(report.cases).map(item=>fmt(item.summary?.[key])).join(' | ')+' |');
  }
  lines.push('', 'Stage times are exclusive within the model. Medians do not necessarily add up; endpoint totals below overlap these stages.',
    'AP native restoration includes tensor transfers, argmax and interpolation. LAT inference includes five folds, mirroring and blending.',
    '— means unmeasured/not applicable; not zero. Legacy combined stages appear only for older reports.', '', '## Endpoints (do not add to stages)', '',
    '| Case | Outputs | Results ready | Batch complete | Model process |',
    '|---|---:|---:|---:|---:|');
  for(const [name,item] of Object.entries(report.cases)) {
    const s=item.summary || {};
    lines.push(`| ${name} | ${item.trials.length} | ${fmt(s.ready)} | ${fmt(s.batchWall)} | ${fmt(s.modelProcess)} |`);
  }
  for(const [name,item] of Object.entries(report.cases)) if(item.error) lines.push('',`${name}: ${item.error}`);
  lines.push('', 'Model process includes startup and all model stages; it is an overlapping subtotal.',
    'Mask/measurement/Overlay equality is an engineering regression check, not clinical accuracy.',
    'All individual timings, signatures, memory observations and comparisons are in report.json.');
  const startupNames=[...new Set(Object.values(report.cases).flatMap(item=>item.trials.flatMap(trial=>Object.keys(trial.startupOperations||{}))))];
  if(startupNames.length){
    lines.push('', '## Engine initialization detail', '', 'Included in engine startup above; do not add again.', '',
      '| Import | '+Object.keys(report.cases).join(' | ')+' |', '|---|'+Object.keys(report.cases).map(()=>'---:|').join(''));
    for(const name of startupNames)lines.push('| '+name+' | '+Object.values(report.cases).map(item=>fmt(stats(item.trials.map(trial=>trial.startupOperations?.[name])))).join(' | ')+' |');
  }
  if(report.comparison) lines.push('', '## Baseline comparison', '', '```json', JSON.stringify(report.comparison,null,2), '```');
  return lines.join('\n')+'\n';
}
async function fingerprint(engine, name) {
  const [,,sample,reference] = CASES[name];
  const pkg = sample.split('/')[0], folder = path.join(engine,'packages',pkg);
  let weights;
  if(name==='ct') weights=['model/trial_230704_4_best.pth'];
  else if(name==='mri') weights=['weights/final.safetensors'];
  else if(name==='ap') weights=['models/AP/model.pth'];
  else weights=Array.from({length:5},(_,i)=>`models/${CASES[name][1]}/fold_${i}/checkpoint_final.pth`);
  const config = fs.readdirSync(folder,{recursive:true}).map(file=>file.replaceAll('\\','/')).filter(file=>
    /^(configs\/|code\/|src\/|[^/]+$)/.test(file) && /\.(py|json|yaml|yml)$/.test(file));
  const signatures={};
  for(const file of [...weights,...config].sort()) signatures[file.replaceAll('\\','/')]=await hash(path.join(folder,file));
  return {input:await hash(path.join(engine,'packages',sample)),reference:await hash(path.join(engine,'packages',reference)),artifacts:signatures};
}
async function main() {
  const {values} = parseArgs({options:{'engine-root':{type:'string'},cases:{type:'string',default:Object.keys(CASES).join(',')},
    repeats:{type:'string',default:'3'},'batch-size':{type:'string',default:'1'},device:{type:'string',default:'cuda:0'},
    output:{type:'string'},baseline:{type:'string'},'compare-only':{type:'string'},threshold:{type:'string',default:'15'},
    timeout:{type:'string',default:'1800'},help:{type:'boolean'}}});
  if(values.help){console.log('node scripts/performance-desktop.cjs [--cases ct,mri,ap,lat_lt,lat_rt] [--repeats 3] [--batch-size 1] [--engine-root PATH] [--device cuda:0|cpu] [--baseline report.json] [--threshold 15] [--timeout 1800] [--output NEW_DIRECTORY]\nCompare saved reports only: --compare-only report.json --baseline baseline.json');return;}
  const repeats=Number(values.repeats),batchSize=Number(values['batch-size']),threshold=Number(values.threshold),timeout=Number(values.timeout);
  if(!Number.isInteger(repeats)||repeats<1||repeats>20||!Number.isInteger(batchSize)||batchSize<1||batchSize>10||!Number.isFinite(threshold)||threshold<0||!Number.isFinite(timeout)||timeout<1)throw Error('Invalid repeats/batch-size/threshold/timeout');
  if(values['compare-only']){
    if(!values.baseline)throw Error('--compare-only requires --baseline');
    const result=compare(read(values['compare-only']),read(values.baseline),threshold);
    console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;return;
  }
  const names=values.cases.split(',');
  if(!names.length||new Set(names).size!==names.length||names.some(name=>!CASES[name]))throw Error('Unknown/duplicate case');
  if(!['cuda:0','cpu'].includes(values.device))throw Error('Unsupported device');
  const config=path.join(process.env.APPDATA||os.homedir(),'EXMO Atlas/engine.json');
  const engine=path.resolve(values['engine-root']||process.env.EXMO_ENGINE_ROOT||(fs.existsSync(config)?read(config).root:path.join(root,'work/modality-integration')));
  const palette=path.join(root,'dist-desktop/imaging-palette.json');
  if(!fs.existsSync(palette))throw Error('Run npm run build:desktop first');
  const python=path.join(engine,'envs/ct/Scripts/python.exe');
  if(!fs.existsSync(python)||!fs.existsSync(path.join(engine,'verified-packages.json')))throw Error('Prepare the local imaging engine first');
  const output=path.resolve(values.output||path.join(root,'outputs/performance',new Date().toISOString().replaceAll(':','-')));
  if(fs.existsSync(output))throw Error('Output directory already exists; reports are never overwritten');
  fs.mkdirSync(output,{recursive:true});
  const storage=fs.mkdtempSync(path.join(os.tmpdir(),'exmo-perf-'));
  let gpu='unavailable';
  try{gpu=execFileSync('nvidia-smi',['--query-gpu=uuid,name,driver_version,memory.total','--format=csv,noheader'],{encoding:'utf8',windowsHide:true}).trim();}catch{}
  const runtimes={};
  for(const env of ['ct','mri','ap','lat']){
    const site=path.join(engine,'envs',env,'Lib/site-packages');
    runtimes[env]=fs.existsSync(site)?fs.readdirSync(site).filter(file=>file.endsWith('.dist-info')).sort():[];
  }
  const code={};
  for(const file of ['desktop/imaging.cjs','desktop/imaging-worker.py','desktop/model-runner.py','desktop/model-service.py','desktop/analysis-worker.cjs','desktop/analysis-pipeline.cjs', 'scripts/performance-desktop.cjs','scripts/performance-imaging.py'])code[file]=await hash(path.join(root,file));
  const report={schema:1,startedAt:new Date().toISOString(),complete:false,passed:false,storage,
    environment:{platform:os.platform(),release:os.release(),arch:os.arch(),cpu:os.cpus()[0]?.model,cpuCount:os.cpus().length,memory:os.totalmem(),gpu,runtimes},
    options:{device:values.device,repeats,batchSize},code,cases:{}};
  const save=()=>{fs.writeFileSync(path.join(output,'report.tmp.json'),JSON.stringify(report,null,2));fs.renameSync(path.join(output,'report.tmp.json'),path.join(output,'report.json'));fs.writeFileSync(path.join(output,'report.md'),markdown(report));};
  const handlers=new Map(),frame={url:'atlas://app/'},window={webContents:{mainFrame:frame,send(){}}};
  let picker=[];
  const electron={dialog:{showOpenDialog:async()=>({canceled:false,filePaths:picker})},
    ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},powerSaveBlocker:{start:()=>1,stop(){}}};
  const localRequire=createRequire(path.join(root,'desktop/imaging.cjs'));
  const context={module:{exports:{}},process,console,setTimeout,clearTimeout,URL,AbortController,require:name=>name==='electron'?electron:localRequire(name)};
  vm.runInNewContext(fs.readFileSync(path.join(root,'desktop/imaging.cjs'),'utf8'),context);
  const backend=context.module.exports.installImaging(window,{engineRoot:engine,storageRoot:storage,scriptsRoot:path.join(root,'desktop'),palette});
  async function call(name,...args){const reply=await handlers.get('exmo:imaging:'+name)({sender:window.webContents,senderFrame:frame},...args);if(!reply.ok)throw Error(reply.error);return reply.value;}
  let interrupted=false,activeAnalysis;
  const stop=()=>{interrupted=true;if(activeAnalysis)void call('cancel',activeAnalysis).catch(()=>{});};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  save();console.log(`Private report: ${path.join(output,'report.json')}`);
  try {
    for(const name of names){
      if(interrupted)break;
      const [analysis,route,sample,reference]=CASES[name];activeAnalysis=analysis;
      const item=report.cases[name]={trials:[],summary:{}};
      try {
        console.log(`${name}: fingerprint and import`);
        item.identity=await fingerprint(engine,name);
        picker=Array(batchSize).fill(path.join(engine,'packages',sample));
        const importStart=performance.now();
        const files=await call('choose',analysis,false,'en');
        item.importSeconds=(performance.now()-importStart)/1000;
        if(files.length!==batchSize||files.some(file=>!file.ready||(file.classification?.route_to_segmentation||null)!==route))throw Error('Sample import/classification failed');
        const ids=files.map(file=>file.id);
        for(let repetition=0;repetition<repeats;repetition++){
          if(interrupted)throw Error('Interrupted');
          console.log(`${name}: repetition ${repetition+1}/${repeats}, batch ${batchSize}`);
          const started=performance.now();
          await call('run',analysis,ids,ids,values.device);
          let job,last='',observedEarly=false;
          do {
            await new Promise(resolve=>setTimeout(resolve,200));
            job=await call('job');
            const state=job.active?.map(task=>task.stage).join(' / ')||job.stage;
            if(state!==last){console.log(`${name}: ${state}`);last=state;}
            observedEarly ||= job.completed.some(result=>result.meshState==='pending');
            if((performance.now()-started)/1000>timeout){await call('cancel',analysis);throw Error(`Batch timeout (${timeout}s)`);}
          }while(job.state==='running');
          if(job.state!=='complete'||job.completed.length!==batchSize)throw Error(JSON.stringify(job.failed)||job.state);
          const batchWall=job.elapsedSeconds;
          for(const summary of job.completed){
            const publicationPath=path.join(storage,'runs',summary.id,'published.json');
            const publication=read(publicationPath),complete=read(path.join(publication.result,'desktop-complete.json'));
            const execution=complete.execution;
            if(execution.device!==values.device||(values.device==='cuda:0'&&!(execution.peak_gpu_memory_bytes>0)))throw Error('Requested GPU execution was not verified');
            const checkFile=path.join(output,`${name}-${repetition+1}-${summary.inputId}.json`);
            const log=fs.openSync(path.join(output,'checks-private.log'),'a');
            try {
              await new Promise((resolve,reject)=>{
                const previous=item.trials[0]?.publicationPath;
                const child=spawn(python,['-X','utf8',path.join(root,'scripts/performance-imaging.py'),'--publication',publicationPath,'--reference',path.join(engine,'packages',reference),'--output',checkFile,...(previous?['--previous',previous]:[])],
                  {windowsHide:true,stdio:['ignore',log,log],env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
                const timer=setTimeout(()=>{if(process.platform==='win32')spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill();},120000);
                child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);code?reject(Error(`Numerical check failed (${code}); see checks-private.log`)):resolve();});
              });
            } finally {fs.closeSync(log);}
            const {peak_gpu_memory_bytes,model_reused,memory_gate,...recipe}=execution;
            const startupOperations={};
            for(const line of fs.readFileSync(path.join(storage,'runs',summary.id,'engine-private.log'),'utf8').split(/\r?\n/)){
              let event;try{event=JSON.parse(line);}catch{continue;}
              if(event.stage==='operation_end'&&event.operation?.startsWith('startup_')&&event.succeeded)
                startupOperations[event.operation]=(startupOperations[event.operation]||0)+event.seconds;
            }
            const seconds={...summary.timings?.model,...summary.timings,batchWall,throughputCasesPerMinute:60*batchSize/batchWall};
            delete seconds.model;
            seconds.modelStartup=Math.max(0,seconds.modelProcess-complete.seconds);
            seconds.resultTransport=Math.max(0,seconds.resultPreparation-seconds.metricsOverlay);
            const trial={repetition:repetition+1,id:summary.id,publicationPath,execution:recipe,modelReused:model_reused||false,
              peakGpuBytes:peak_gpu_memory_bytes,gpuMemoryGate:memory_gate,peakProcessBytes:complete.peak_host_process_memory_bytes,
              observedEarly,seconds,startupOperations,check:read(checkFile)};
            item.trials.push(trial);item.summary=summarize(item.trials);save();
            if(!isDeepStrictEqual(signature(item.trials[0].check),signature(trial.check)))
              throw Error(`Repeated output differs: ${trial.check.repeatDifferences ?? 'unknown'} native labels changed; max class measurement delta ${trial.check.repeatDetails?.maxAbsoluteMeasurementDelta ?? 'unknown'} ${trial.check.unit}. See per-trial repeatDetails; speed gain not accepted.`);
            console.log(`${name}: ready ${seconds.ready.toFixed(2)}s, batch ${batchWall.toFixed(2)}s, mesh ${seconds.mesh?.toFixed(2)||'n/a'}s`);
          }
        }
        if(await hash(path.join(engine,'packages',sample))!==item.identity.input)throw Error('Source input changed');
      } catch(error){item.error=error.message;console.error(`${name}: ${error.message}`);await call('cancel',analysis).catch(()=>{});}
      save();
    }
    report.complete=!interrupted && names.every(name=>report.cases[name]?.trials.length===repeats*batchSize&&!report.cases[name].error);
    report.passed=report.complete;
    if(values.baseline){try{report.comparison=compare(report,read(values.baseline),threshold);report.passed &&= report.comparison.passed;}catch(error){report.comparison={passed:false,error:error.message};report.passed=false;}}
  } finally {
    await backend.dispose();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    report.finishedAt=new Date().toISOString();save();console.log(markdown(report));
    if(!report.passed)process.exitCode=1;
  }
}
module.exports={stats,summarize,signature,compare,markdown,fingerprint};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
