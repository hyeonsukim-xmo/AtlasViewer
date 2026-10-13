// Real desktop dispatcher, model services and finalizer; only Electron IPC is mocked.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const engineRoot = process.env.EXMO_ENGINE_ROOT || path.join(process.env.LOCALAPPDATA, 'EXMO Atlas/engine');
const output = path.join(root, 'outputs/pipeline-validation');
fs.mkdirSync(output, {recursive:true});
// Keep the fixture as short as the installed app's data root (Windows MAX_PATH).
const storageRoot = fs.mkdtempSync(path.join(path.dirname(root), 'pv-'));
const sample = JSON.parse(fs.readFileSync(path.join(root, 'outputs/ct-speed-validation/sample-final/record.json'), 'utf8'));
const input = path.join(storageRoot, 'input_ct.nii.gz');
fs.copyFileSync(sample.input, input);
for (const name of ['hu_evidence.json','source_proof.json']) {
  fs.copyFileSync(path.join(path.dirname(sample.input),name),path.join(storageRoot,name));
}
let records = [1,2,3].map(n => ({...sample, id:`pipeline_ct_${n}`, name:`CT pipeline fixture ${n}`, input}));
if (process.argv.includes('--large-batch')) {
  const appData=path.join(process.env.APPDATA,'EXMO Atlas/imaging');
  const catalog=JSON.parse(fs.readFileSync(path.join(appData,'library.json'),'utf8'));
  const prior=['6b5784b0-1df6-4147-b919-e9893436d5e1','09e8a4f0-386c-4510-b441-16517e229a26','f4dd643f-10a7-4d4b-ab3f-b55210fb6383'];
  records=prior.map((id,n)=>{
    const job=JSON.parse(fs.readFileSync(path.join(appData,'runs',id,'job.json'),'utf8'));
    const record=catalog.find(file=>file.id===job.id);
    assert.ok(record && !record.deferredValidation);
    const directory=path.join(storageRoot,String(n));fs.mkdirSync(directory);
    const input=path.join(directory,'input.nii.gz');fs.copyFileSync(record.input,input);
    for(const name of ['hu_evidence.json','source_proof.json'])fs.copyFileSync(path.join(path.dirname(record.input),name),path.join(directory,name));
    return {...record,input};
  });
}
fs.writeFileSync(path.join(storageRoot, 'library.json'), JSON.stringify(records));
const handlers = new Map(), power = new Set();
const frame = {url:'atlas://app/'};
const window = {webContents:{mainFrame:frame,send(){}}};
const event = {sender:window.webContents,senderFrame:frame};
const electron = {
  dialog:{},
  ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},
  powerSaveBlocker:{start:()=>{power.add(1);return 1},stop:id=>power.delete(id)},
};
const localRequire = createRequire(path.join(root,'desktop/imaging.cjs'));
const context = {module:{exports:{}},process,console,setTimeout,clearTimeout,URL,AbortController,
  require:name=>name==='electron'?electron:localRequire(name)};
vm.runInNewContext(fs.readFileSync(path.join(root,'desktop/imaging.cjs'),'utf8'), context);
const backend = context.module.exports.installImaging(window, {
  engineRoot, storageRoot, scriptsRoot:path.join(root,'desktop'), palette:path.join(root,'dist-desktop/imaging-palette.json'),
});
async function call(name,...args) {
  const reply=await handlers.get('exmo:imaging:'+name)(event,...args);
  assert.equal(reply.ok,true,reply.error);return reply.value;
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const started=performance.now();
  console.log(JSON.stringify({storageRoot}));
  let overlap=false, incremental=false, resultOverlap=false, last='';
  try {
    await call('run','ct',records.map(r=>r.id),records.map(r=>r.id),'cuda:0');
    if (process.argv.includes('--cancel')) {
      await sleep(2500);
      const before=performance.now();
      await call('cancel','ct');
      const cancelled=await call('job');
      assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.active.length,0);
      assert.equal(cancelled.completed.length,0);assert.equal(cancelled.failed.length,0);
      assert.equal((await call('list','ct')).length,records.length);assert.equal(power.size,0);
      const report={passed:true,cancellationSeconds:(performance.now()-before)/1000,storageRoot};
      fs.writeFileSync(path.join(storageRoot,'cancellation.json'),JSON.stringify(report,null,2));
      console.log(JSON.stringify(report));return;
    }
    let job;
    do {
      await sleep(500);
      job=await call('job');
      const active=job.active||[];
      overlap ||= active.some(t=>t.lane==='gpu') && active.some(t=>t.lane==='cpu');
      resultOverlap ||= active.some(t=>t.stage==='측정·Overlay·3D 준비') && active.some(t=>t.lane==='cpu' && t.stage!=='측정·Overlay·3D 준비');
      if(job.state==='running' && job.completed.length===1) {
        incremental=(await call('results','ct')).length===1;
      }
      const status=JSON.stringify({state:job.state,completed:job.completed.length,failed:job.failed,active:active.map(t=>({...t,progress:t.progress==null?null:Math.floor(t.progress/10)*10}))});
      if(status!==last){console.log(status);last=status;}
      if(performance.now()-started>15*60000) throw new Error('Pipeline test timed out');
    } while(job.state==='running');
    assert.equal(job.state,'complete',JSON.stringify(job.failed));
    assert.equal(job.completed.length,records.length);
    assert.ok(overlap,'GPU and CPU lanes must overlap');
    assert.ok(incremental,'First result must be visible while second is running');
    // Actual overlap depends on case durations and available RAM. The bounded
    // scheduler test exercises CPU/finalizer overlap deterministically.
    if(process.argv.includes('--require-finalizer-overlap')) assert.ok(resultOverlap,'CPU tail must overlap another result preparation');
    assert.equal(power.size,0);
    const runs=fs.readdirSync(path.join(storageRoot,'runs')).map(id=>{
      const directory=path.join(storageRoot,'runs',id);
      const events=fs.readFileSync(path.join(directory,'engine-private.log'),'utf8').trim().split('\n').map(JSON.parse);
      return {directory,events,result:JSON.parse(fs.readFileSync(path.join(directory,'published.json'),'utf8'))};
    }).sort((a,b)=>a.events[0].monotonic_seconds-b.events[0].monotonic_seconds);
    assert.ok(runs[1].events.some(e=>e.stage==='model_reused'));
    const interval=(run,a,b)=>[run.events.find(e=>e.stage===a).monotonic_seconds,run.events.find(e=>e.stage===b).monotonic_seconds];
    const gpu=runs.map(r=>interval(r,'inference_start','cpu_ready'));
    const cpu=runs.map(r=>interval(r,'cpu_started','complete'));
    for(let i=1;i<runs.length;i++) {
      assert.ok(gpu[i][0]>=gpu[i-1][1],'GPU inference must not overlap');
      assert.ok(cpu[i][0]>=cpu[i-1][1],'CPU tails must be serialized');
    }
    assert.ok(gpu.some((g,i)=>i>0 && g[0]<cpu[i-1][1]),'An inference must overlap the preceding CPU tail');
    const report={passed:true,seconds:(performance.now()-started)/1000,overlap,incremental,resultOverlap,gpu,cpu,storageRoot,
      results:runs.map(r=>r.result.result),scope:'Scheduling and completion; numerical comparison is separate'};
    fs.writeFileSync(path.join(storageRoot,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } finally {await backend.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1});
