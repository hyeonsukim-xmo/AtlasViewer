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
let releaseMesh, failMesh = false, workers = [], onModelRun, onInspect, onModelChallenge, selectedPaths=[input];
class FakeWorker {
  constructor() { this.closed=false; workers.push(this); }
  async request(message, options) {
    if (message.operation === 'model_challenge') return onModelChallenge(message);
    if (message.operation === 'run') {
      await onModelRun?.(message,options);
      fs.mkdirSync(message.job.output, {recursive:true});
      return {complete:true, result:message.job.output};
    }
    if (message.operation === 'finalize') {
      assert.equal(message.deferMesh,true);
      const mask = path.join(message.result, 'mask.nii.gz'); fs.writeFileSync(mask,'native');
      return {summary:{id:message.id, inputId:message.record.id, analysis:message.record.analysis, variant:message.variant || 'raw',
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
    if(message.operation==='extract') {child.stdout.write(JSON.stringify({id:message.requestId,error:'Corrupt ZIP fixture',errorCode:'INPUT_INVALID',errorPublic:true})+'\n');return;}
    const result=message.operation==='inspect'?(onInspect?.(message)||[]):message.operation==='prepare'?message.record:message.operation==='finalize'?
      await new FakeWorker().request(message):{image:'data:image/png;base64,test'};
    child.stdout.write(JSON.stringify({id:message.requestId,result})+'\n');
  });
  child.kill=()=>{child.exitCode=0;child.emit('exit');};
  return child;
}
function install(analysisAuthorization) {
  const handlers=new Map(), frame={url:'atlas://app/'};
  const window={webContents:{mainFrame:frame,send(){}}};
  const electron={dialog:{showOpenDialog:async()=>({canceled:false,filePaths:selectedPaths})},ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},
    powerSaveBlocker:{start:()=>1,stop(){}}};
  const context={module:{exports:{}},process,console,setTimeout,clearTimeout,URL,AbortController,
    require:name=>name==='electron'?electron:name==='./analysis-worker.cjs'?{AnalysisWorker:FakeWorker}:
      name==='node:child_process'?{spawn}:localRequire(name)};
  vm.runInNewContext(fs.readFileSync(path.join(root,'desktop/imaging.cjs'),'utf8'),context);
  const backend=context.module.exports.installImaging(window,{engineRoot:storageRoot,storageRoot,scriptsRoot:root,palette,analysisAuthorization});
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
    const context={analysis:'ct',scope:'ct',visible:true,running:false,pendingMeshes:pending,receivedCompletion:{current:key},
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
async function sharedInputIsolation() {
  const catalog=path.join(storageRoot,'library.json'), original=fs.readFileSync(catalog);
  const directory=path.join(storageRoot,'shared-inputs');fs.mkdirSync(directory);
  const current={...record,id:'current',input:path.join(directory,'current.nrrd')};
  const future={...record,id:'future',solutionId:'exmo.future.ct',input:path.join(directory,'future.nrrd')};
  fs.writeFileSync(current.input,'current');fs.writeFileSync(future.input,'future');
  fs.writeFileSync(catalog,JSON.stringify([current,future]));
  const {backend,call}=install();
  try {
    await call('clear','exmo.thigh.ct');
    assert.equal(fs.readFileSync(future.input,'utf8'),'future','Clearing one solution must retain another solution\'s shared input directory');
    assert.deepEqual(JSON.parse(fs.readFileSync(catalog)).map(row=>row.id),['future']);
  } finally {await backend.dispose();fs.writeFileSync(catalog,original);}
  console.log('PASS: clearing one solution retains inputs referenced by another solution');
}
async function run(meshFailure=false,cancel=false) {
  failMesh=meshFailure; releaseMesh=undefined;
  const {backend,call}=install();
  try {
    const prior=new Set((await call('results','ct')).map(r=>r.id));
    await call('run','exmo.thigh.ct',['one'],[],'cpu');
    await until(()=>releaseMesh);
    const job=await call('job');
    assert.equal(job.state,'running'); assert.equal(job.completed.length,1);
    const result=(await call('results','ct')).find(r=>!prior.has(r.id));
    assert.equal(result.meshState,'pending'); assert.equal(result.meshBytes,null);
    assert.ok(result.timings.ready >= 0);
    assert.equal(result.solutionId,'exmo.thigh.ct');assert.ok(result.analysisRevision);
    assert.equal(result.provenance.source,'solution-registry');
    const published=path.join(storageRoot,'runs',result.id,'published.json');
    assert.equal(JSON.parse(fs.readFileSync(published)).summary.meshState,'pending');
    assert.ok((await call('resultPreview',result.id,{})).image);
    const reference=require('node:crypto').randomUUID();
    assert.equal((await call('sceneFailure',result.id,'GPU_RENDER',reference)).reference,reference);
    await assert.rejects(call('sceneFailure',result.id,'arbitrary-code',reference));
    if (cancel) await call('cancel','ct'); else releaseMesh();
    await until(async()=> (await call('job')).state!=='running');
    const done=(await call('results','ct')).find(r=>r.id===result.id);
    assert.equal(done.analysisRevision,result.analysisRevision,'Mesh completion or failure keeps the measurement revision');
    assert.equal(done.meshState,cancel?'interrupted':meshFailure?'failed':'ready');
    if (meshFailure || cancel) {
      assert.equal(done.meshDiagnostic.code,cancel?'CANCELLED':'MESH_BUILD');
      assert.ok(done.meshDiagnostic.reference);
      assert.equal(JSON.parse(fs.readFileSync(published)).summary.meshDiagnostic.reference,done.meshDiagnostic.reference);
    }
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
async function runAuthorization() {
  const {Authority,createServer}=require('./security/license-server.cjs');
  const {createFixture,simulatedClient}=require('./security/license-demo.cjs');
  const directory=path.join(storageRoot,'license-fixture');
  const fixture=createFixture(directory),authority=new Authority(fixture.server),server=createServer(authority);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=simulatedClient(directory,`http://127.0.0.1:${server.address().port}`);
  failMesh=false;releaseMesh=undefined;
  const records=['one','two','three'].map(id=>({...record,id}));
  fs.writeFileSync(path.join(storageRoot,'library.json'),JSON.stringify(records));
  let finishFirst;
  const first=new Promise(resolve=>{finishFirst=resolve;}),entered=[],admissions=[];
  onModelRun=async(message,options)=>{
    entered.push(message.job.id);
    if(message.job.id==='two') {
      authority.status('development-only','revoked');
      assert.equal(await client.refresh(),'REVOKED');
    }
    await options.onEvent({stage:'cpu_ready'});
    if(message.job.id==='one')await first;
  };
  const {backend,call}=install({authorize:async({runId,engine,signal})=>{
    assert.equal(engine,'ct');assert.equal(signal.aborted,false);
    assert.match(runId,/^[0-9a-f-]{36}$/);admissions.push(runId);
    return client.authorize({runId,engine,signal});
  }});
  try {
    await call('run','ct',records.map(r=>r.id),[],'cuda:0');
    await until(()=>entered.length===2);
    finishFirst();
    await until(()=>admissions.length===3);
    assert.deepEqual(entered,['one','two']);assert.equal(new Set(admissions).size,3);
    assert.ok(workers.filter(w=>!w.closed).length>0,'Revocation does not stop an active worker');
    finishFirst();
    for(let i=0;i<2;i++) {await until(()=>releaseMesh);const finish=releaseMesh;releaseMesh=undefined;finish();}
    await until(async()=>(await call('job')).state!=='running');
    const job=await call('job');assert.equal(job.completed.length,2);assert.equal(job.failed.length,1);
    assert.equal(job.failed[0].id,'three');assert.equal(job.failed[0].diagnostic.code,'LICENSE_REVOKED');
    assert.ok(job.failed[0].diagnostic.reference);
    for(const result of job.completed) {
      assert.ok(result.timings.authorization>=0,'Authorization time is separate from model inference');
      assert.equal((await call('results','ct')).find(r=>r.id===result.id).meshState,'ready');
      assert.ok((await call('resultPreview',result.id,{})).image,'Completed results stay viewable');
    }
    await call('run','ct',['one'],[],'cpu');
    await until(async()=>(await call('job')).state!=='running');
    assert.equal((await call('job')).completed.length,0,'Rerun gets a fresh authorization check');
    assert.deepEqual(entered,['one','two']);
  } finally {
    finishFirst();releaseMesh?.();await backend.dispose();onModelRun=undefined;
    client.close();await new Promise(resolve=>server.close(resolve));authority.close();
    fs.writeFileSync(path.join(storageRoot,'library.json'),JSON.stringify([record]));
  }
  console.log('PASS: running GPU/CPU cases finish after revocation; queued and repeated runs denied; results remain readable');
}
async function rejectInvalidGrants() {
  assert.throws(()=>install({}),/권한/);
  let started=0;onModelRun=()=>{started++;};
  try {
    for(const alter of [()=>null,grant=>({...grant,runId:'wrong'}),grant=>({...grant,engine:'lat'}),grant=>({...grant,state:'EXPIRED'})]) {
      const {backend,call}=install({authorize:async request=>alter({...request,state:'VALID'})});
      try {
        await call('run','ct',['one'],[],'cpu');
        await until(async()=>(await call('job')).state!=='running');
        const job=await call('job');assert.equal(job.completed.length,0);assert.equal(job.failed.length,1);
      } finally {await backend.dispose();}
    }
    assert.equal(started,0,'Malformed or mismatched grants must never start a model');
  } finally {onModelRun=undefined;}
}
async function authorizeXrayClassification() {
  fs.writeFileSync(path.join(storageRoot,'verified-packages.json'),'{}');
  for(const engine of ['ap','lat']){
    fs.mkdirSync(path.join(storageRoot,'envs',engine,'Scripts'),{recursive:true});
    fs.writeFileSync(path.join(storageRoot,'envs',engine,'Scripts/python.exe'),'stub');
  }
  let inspections=0,admissions=0;const inspected=[];onInspect=message=>{inspections++;inspected.push(message);};
  try {
    for(const allowed of [false,true]) {
      const {backend,call}=install({authorize:async request=>{
        admissions++;assert.equal(request.engine,'xray-classifier');
        if(!allowed)throw Error('REVOKED');return {...request,state:'VALID'};
      }});
      try {
        const rows=await call('choose','xray',false,'ko');
        assert.equal(inspections,allowed?2:1);
        assert.equal(Boolean(inspected.at(-1).classificationDenied),!allowed,'Metadata import proceeds but denied classification stays disabled');
      } finally {await backend.dispose();}
    }
    assert.equal(admissions,2);
    console.log('PASS: X-ray import cannot start classification without a fresh permitted grant');
  } finally {onInspect=undefined;fs.writeFileSync(path.join(storageRoot,'library.json'),JSON.stringify([record]));}
}
async function mixedArchiveImport() {
  fs.writeFileSync(path.join(storageRoot,'verified-packages.json'),'{}');
  const zip=path.join(storageRoot,'broken.zip');fs.writeFileSync(zip,'invalid archive');
  selectedPaths=[zip,input];onInspect=()=>[{...record,id:'import-valid'}];
  const {backend,call}=install();
  try {
    const rows=await call('choose','ct',false,'ko');
    assert.equal(rows.length,2);assert.equal(rows[0].name,'broken.zip');
    assert.equal(rows[0].diagnostic.code,'INPUT_INVALID');assert.equal(rows[0].ready,false);
    assert.equal(rows[1].id,'import-valid');assert.equal(rows[1].ready,true);
  } finally {
    await backend.dispose();selectedPaths=[input];onInspect=undefined;
    fs.writeFileSync(path.join(storageRoot,'library.json'),JSON.stringify([record]));
  }
  console.log('PASS: corrupt ZIP is a named failed input while another image still imports');
}
async function authorizeMriWorker() {
  fs.mkdirSync(path.join(storageRoot,'envs/mri/Scripts'),{recursive:true});
  fs.writeFileSync(path.join(storageRoot,'envs/mri/Scripts/python.exe'),'stub');
  fs.writeFileSync(path.join(storageRoot,'library.json'),JSON.stringify([{...record,analysis:'mri'}]));
  let runs=0,proofs=0;
  const proof={key:'private-pipe-only-test-key'},challenge={nonce:'worker-nonce',modelDigest:'model-digest'};
  onModelChallenge=message=>{assert.ok(message.runId);return challenge;};
  onModelRun=(message,options)=>{
    runs++;assert.deepEqual(message.authorization,proof);
    const saved=fs.readFileSync(path.join(path.dirname(message.job.output),'job.json'),'utf8');
    assert.ok(!saved.includes(proof.key) && !saved.includes('authorization'));
    assert.ok(options.id);
  };
  try {
    for(const allowed of [false,true]) {
      const {backend,call}=install({authorize:async request=>({...request,state:'VALID'}),
        authorizeModel:async request=>{
          proofs++;assert.deepEqual(request.challenge,challenge);assert.equal(request.job.analysis,'mri');
          if(!allowed)throw Error('MRI model approval missing');return proof;
        }});
      try {
        await call('run','mri',['one'],[],'cpu');
        if(allowed) {await until(()=>releaseMesh);const finish=releaseMesh;releaseMesh=undefined;finish();}
        await until(async()=>(await call('job')).state!=='running');
        assert.equal((await call('job')).completed.length,allowed?1:0);
      } finally {await backend.dispose();}
    }
    assert.equal(runs,1);assert.equal(proofs,2);
    console.log('PASS: protected MRI worker handshake, missing model approval denied, secrets absent from job files');
  } finally {onModelRun=undefined;onModelChallenge=undefined;fs.writeFileSync(path.join(storageRoot,'library.json'),JSON.stringify([record]));}
}
(async()=>{
  try {
    await checkResultPolling();
    await sharedInputIsolation();
    await run(); await run(true); await run(false,true);
    await runAuthorization();
    await rejectInvalidGrants();
    await authorizeXrayClassification();
    await mixedArchiveImport();
    await authorizeMriWorker();
    // A process exit during meshing must reopen the existing measurements as retryable.
    const directory=fs.readdirSync(path.join(storageRoot,'runs'))
      .find(id=>{const file=path.join(storageRoot,'runs',id,'published.json');return fs.existsSync(file) && JSON.parse(fs.readFileSync(file)).summary.analysis==='ct';});
    assert.ok(directory,'Select a published result, not a denied run directory');
    const published=path.join(storageRoot,'runs',directory,'published.json');
    const saved=JSON.parse(fs.readFileSync(published));
    saved.summary.meshState='pending'; saved.summary.meshBytes=null; saved.mesh=null;
    fs.writeFileSync(published,JSON.stringify(saved));
    const {backend,call}=install();
    try {assert.equal((await call('results','ct')).find(r=>r.id===saved.summary.id).meshState,'interrupted');}
    finally {await backend.dispose();}
    // A retried mesh must not overwrite a newer variant when it finishes late.
    saved.summary.analysis='mri'; saved.summary.qc={}; saved.record.analysis='mri';
    // This fixture becomes a different analysis, not a migration of the CT snapshot.
    for (const value of [saved.summary,saved.record]) {
      value.solutionId='exmo.thigh.mri';value.workflowId='thigh-mri-water-v1';
    }
    fs.unlinkSync(path.join(storageRoot,'runs',directory,'identity.json'));
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
