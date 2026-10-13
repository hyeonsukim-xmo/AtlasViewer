// Real desktop dispatcher and persisted publications; only Python/Electron are stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const root = path.resolve(__dirname, '..');
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'exmo-publish-'));
const localRequire = createRequire(path.join(root, 'desktop/imaging.cjs'));
const palette = path.join(storageRoot, 'palette.json');
fs.writeFileSync(palette, '[]');
fs.mkdirSync(path.join(storageRoot, 'envs/ct/Scripts'), {recursive:true});
fs.writeFileSync(path.join(storageRoot, 'envs/ct/Scripts/python.exe'), 'stub');
const input = path.join(storageRoot, 'input.nii.gz');
fs.writeFileSync(input, 'fixture');
const record = {id:'one', analysis:'ct', input, name:'fixture', ready:true, metadata:{size:[8,8,8],spacing:[1,1,1]}};
fs.writeFileSync(path.join(storageRoot, 'library.json'), JSON.stringify([record]));
let releaseMesh, failMesh = false, workers = [];
class FakeWorker {
  constructor() { this.closed=false; workers.push(this); }
  async request(message) {
    if (message.operation === 'run') {
      fs.mkdirSync(message.job.output, {recursive:true});
      return {complete:true, result:message.job.output};
    }
    if (message.operation === 'finalize') {
      assert.equal(message.deferMesh,true);
      const mask = path.join(message.result, 'mask.nii.gz'); fs.writeFileSync(mask,'native');
      return {summary:{id:message.id, inputId:record.id, analysis:message.record.analysis, variant:message.variant || 'raw',
        createdAt:message.createdAt, meshBytes:null, meshState:'pending', rows:[], seconds:1,
        laterality:{method:'femur_components_lps_v1'}, timings:{model:{inference:.5}}},
        record:message.record, result:message.result, mask, sideMask:mask, mesh:null};
    }
    if (message.operation === 'mesh') {
      await new Promise((resolve,reject) => { releaseMesh=resolve; this.rejectMesh=reject; });
      this.rejectMesh=null;
      if (failMesh) throw Error('synthetic meshing failure');
      const result = structuredClone(message.publication);
      result.mesh=path.join(result.result,'surface.glb'); fs.writeFileSync(result.mesh,'glb');
      Object.assign(result.summary, {meshState:'ready',meshBytes:3});
      result.summary.timings.mesh=.1;
      return result;
    }
    throw Error(message.operation);
  }
  send() {}
  async close() { this.closed=true; }
  async stop() { this.closed=true; this.rejectMesh?.(Error('cancelled')); }
}
function spawn() {
  const child = new EventEmitter();
  child.stdout=new PassThrough(); child.stderr=new PassThrough();
  child.stdin=new PassThrough();
  child.stdin.on('data', async data => {
    const message=JSON.parse(data.toString());
    const result=message.operation==='prepare'?message.record:message.operation==='finalize'?
      await new FakeWorker().request(message):{image:'data:image/png;base64,test'};
    child.stdout.write(JSON.stringify({id:message.requestId,result})+'\n');
  });
  child.kill=()=>{child.exitCode=0;child.emit('exit');};
  return child;
}
function install() {
  const handlers=new Map(), frame={url:'atlas://app/'};
  const window={webContents:{mainFrame:frame,send(){}}};
  const electron={dialog:{},ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},
    powerSaveBlocker:{start:()=>1,stop(){}}};
  const context={module:{exports:{}},process,console,setTimeout,clearTimeout,URL,AbortController,
    require:name=>name==='electron'?electron:name==='./analysis-worker.cjs'?{AnalysisWorker:FakeWorker}:
      name==='node:child_process'?{spawn}:localRequire(name)};
  vm.runInNewContext(fs.readFileSync(path.join(root,'desktop/imaging.cjs'),'utf8'),context);
  const backend=context.module.exports.installImaging(window,{engineRoot:storageRoot,storageRoot,scriptsRoot:root,palette});
  return {backend,call:async(name,...args)=>{
    const reply=await handlers.get('exmo:imaging:'+name)({sender:window.webContents,senderFrame:frame},...args);
    assert.equal(reply.ok,true,reply.error);return reply.value;
  }};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function checkResultPolling() {
  // Execute the actual parent effect without Electron, React DOM or model inference.
  const ts=require('typescript');
  const source=ts.createSourceFile('workspace.tsx',fs.readFileSync(path.join(root,'desktop/ui/thigh-workspace.tsx'),'utf8'),
    ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let effect;
  function visit(node) {
    if(ts.isCallExpression(node)&&node.expression.getText(source)==='useEffect'&&
        node.arguments[0].getText(source).includes('window.exmoDesktop.job()')) effect=node.arguments[0].getText(source);
    ts.forEachChild(node,visit);
  }
  visit(source);assert(effect);
  const code=ts.transpileModule('('+effect+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const job={id:'batch',analysis:'ct',state:'complete',completed:[],resultRevision:2};
  for(const [next,pending,key,expected] of [[null,'old:raw','',1],[{...job,analysis:'mri'},'old:pp500','',1],
      [job,'','batch:complete:0:1',1],[job,'','batch:complete:0:2',0]]) {
    let calls=0,updates=0,release;const timers=new Set();
    const context={analysis:'ct',visible:true,running:false,pendingMeshes:pending,receivedCompletion:{current:key},
      unwrap:reply=>reply.value,setJob(){},setError:assert.fail,setResults(){updates++;},
      setTimeout(fn){timers.add(fn);return fn;},clearTimeout(fn){timers.delete(fn);},
      window:{exmoDesktop:{job:async()=>({value:next}),results:()=>{
        calls++;return new Promise(resolve=>{release=()=>resolve({value:[{meshState:'ready'}]});});
      }}}};
    const start=()=>vm.runInNewContext(code,context)();
    const dispose=start();await tick();assert.equal(calls,expected);
    if(expected){assert.equal(timers.size,0,'No overlapping poll while results are in flight');release();await tick();}
    assert.equal(updates,expected);assert.equal(timers.size,1);dispose();assert.equal(timers.size,0);
    if(expected){
      context.receivedCompletion.current=key;
      const cancel=start();await tick();cancel();release();await tick();
      assert.equal(updates,1,'Disposed/previous-variant response must not overwrite results');
      assert.equal(timers.size,0);
    }
  }
  console.log('PASS: one result poll, old-result retry without matching job, revision refresh, stale response rejection');
}
async function until(predicate) {
  const deadline=Date.now()+5000;
  while (!await predicate()) { assert.ok(Date.now()<deadline,'Timed out'); await tick(); }
}
async function run(meshFailure=false,cancel=false) {
  failMesh=meshFailure; releaseMesh=undefined;
  const {backend,call}=install();
  try {
    const prior=new Set((await call('results','ct')).map(r=>r.id));
    await call('run','ct',['one'],[],'cpu');
    await until(()=>releaseMesh);
    const job=await call('job');
    assert.equal(job.state,'running'); assert.equal(job.completed.length,1);
    const result=(await call('results','ct')).find(r=>!prior.has(r.id));
    assert.equal(result.meshState,'pending'); assert.equal(result.meshBytes,null);
    assert.ok(result.timings.ready >= 0);
    const published=path.join(storageRoot,'runs',result.id,'published.json');
    assert.equal(JSON.parse(fs.readFileSync(published)).summary.meshState,'pending');
    assert.ok((await call('resultPreview',result.id,{})).image);
    if (cancel) await call('cancel','ct'); else releaseMesh();
    await until(async()=> (await call('job')).state!=='running');
    const done=(await call('results','ct')).find(r=>r.id===result.id);
    assert.equal(done.meshState,cancel?'interrupted':meshFailure?'failed':'ready');
    assert.equal((await call('job')).failed.length,0,'Meshing failure is not segmentation failure');
    assert.ok((await call('resultPreview',result.id,{})).image);
    if (meshFailure || cancel) {
      failMesh=false; releaseMesh=undefined;
      const retry=await call('variant',result.id,'raw'); assert.equal(retry.meshState,'pending');
      await until(()=>releaseMesh); releaseMesh();
      await until(async()=> (await call('results','ct')).find(r=>r.id===result.id).meshState==='ready');
    }
  } finally {await backend.dispose();}
}
(async()=>{
  try {
    await checkResultPolling();
    await run(); await run(true); await run(false,true);
    // A process exit during meshing must reopen the existing measurements as retryable.
    const directory=fs.readdirSync(path.join(storageRoot,'runs'))[0];
    const published=path.join(storageRoot,'runs',directory,'published.json');
    const saved=JSON.parse(fs.readFileSync(published));
    saved.summary.meshState='pending'; saved.summary.meshBytes=null; saved.mesh=null;
    fs.writeFileSync(published,JSON.stringify(saved));
    const {backend,call}=install();
    try {assert.equal((await call('results','ct')).find(r=>r.id===saved.summary.id).meshState,'interrupted');}
    finally {await backend.dispose();}
    // A retried mesh must not overwrite a newer variant when it finishes late.
    saved.summary.analysis='mri'; saved.summary.qc={}; saved.record.analysis='mri';
    fs.mkdirSync(path.join(saved.result,'raw'),{recursive:true});
    fs.writeFileSync(path.join(saved.result,'raw/metrics.json'),JSON.stringify({classes:[]}));
    fs.writeFileSync(published,JSON.stringify(saved));
    const replacement=install();
    try {
      releaseMesh=undefined;
      await replacement.call('variant',saved.summary.id,'raw');
      await until(()=>releaseMesh);
      const finishOld=releaseMesh; releaseMesh=undefined;
      const pp=await replacement.call('variant',saved.summary.id,'pp500');
      assert.equal(pp.variant,'pp500'); finishOld();
      await until(()=>releaseMesh);
      const current=(await replacement.call('results','mri')).find(r=>r.id===saved.summary.id);
      assert.equal(current.variant,'pp500'); assert.equal(current.meshState,'pending');
      releaseMesh();
      await until(async()=> (await replacement.call('results','mri')).find(r=>r.id===saved.summary.id).meshState==='ready');
      assert.equal(JSON.parse(fs.readFileSync(published)).summary.variant,'pp500');
    } finally {await replacement.backend.dispose();}
    console.log('PASS: publication before mesh, immediate Overlay, mesh failure/cancel/retry, restart recovery, stale variant rejection');
  } finally {
    assert.ok(path.resolve(storageRoot).startsWith(path.resolve(os.tmpdir())+path.sep));
    fs.rmSync(storageRoot,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1});
