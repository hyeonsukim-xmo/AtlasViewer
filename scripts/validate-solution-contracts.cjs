const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {randomUUID} = require('node:crypto');
const {solutions,resolveSolution,solutionFields,matchesSolution} = require('../desktop/solutions.cjs');
const {createResultIdentities} = require('../desktop/result-identities.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(),'exmo-solutions-'));
function publication(id='case', analysis='ct', route=null) {
  const folder=path.join(root,'runs',id);fs.mkdirSync(folder,{recursive:true});
  const mask=path.join(folder,'mask.nrrd');fs.writeFileSync(mask,'private native fixture');
  return {summary:{id,inputId:id,analysis,variant:'raw',route,unit:analysis==='xray'?'cm²':'cm³',
    metadata:{size:[8,8,8],spacing:[1,1,1]},rows:[{id:'sartorius',label:1,value:12,count:12,color:'#00ffff'}],
    qc:{flags:[]},laterality:null,createdAt:'2026-10-17T00:00:00Z'},
    record:{id,analysis,input:mask,metadata:{},ready:true},mask,sideMask:null,result:folder,mesh:null};
}
const copy = value => JSON.parse(JSON.stringify(value));
async function identities() {
  const store=createResultIdentities(root);
  const raw=publication(), file=path.join(raw.result,'published.json');
  fs.writeFileSync(file,JSON.stringify(raw));const original=fs.readFileSync(file);
  const a=await store.get(raw), b=await createResultIdentities(root).get(copy(raw));
  assert.deepEqual(a,b);assert.equal(a.provenance.source,'legacy-analysis');
  assert.deepEqual(fs.readFileSync(file),original,'Legacy publication is not rewritten');
  assert.equal(fs.readFileSync(raw.mask,'utf8'),'private native fixture');
  const mesh=copy(raw);Object.assign(mesh.summary,{meshState:'ready',meshBytes:99,timings:{mesh:3},metadata:{...raw.summary.metadata,patientId:'renamed'}});
  mesh.summary.rows[0].color='#ff00aa';
  assert.deepEqual(await store.get(mesh),a,'Late mesh, timings, patient assignment and palette do not mint revisions');
  const pp=copy(raw);pp.summary.variant='pp500';
  const strong=copy(raw);strong.summary.variant='strong';
  const [p,q]=await Promise.all([store.get(pp),store.get(strong)]);
  assert.notEqual(p.analysisRevision,a.analysisRevision);assert.notEqual(q.analysisRevision,p.analysisRevision);
  assert.equal(p.originResultId,a.originResultId);
  assert.equal((await createResultIdentities(root).get(copy(pp))).analysisRevision,p.analysisRevision,'Concurrent revisions are retained');
  assert.deepEqual(await createResultIdentities(root).get(copy(raw)),a,'Returning to Raw retains its revision');
  fs.writeFileSync(raw.mask,'different topology, same measurements');
  const changed=await store.get(copy(raw));assert.notEqual(changed.analysisRevision,a.analysisRevision);
  assert.equal(changed.originResultId,a.originResultId);
  fs.writeFileSync(raw.mask,'private native fixture');
  assert.deepEqual(await createResultIdentities(root).get(copy(raw)),a);
  const migrated=path.join(root,'relocated');fs.mkdirSync(migrated);
  fs.copyFileSync(path.join(root,'result-origin.json'),path.join(migrated,'result-origin.json'));
  fs.cpSync(raw.result,path.join(migrated,'runs','case'),{recursive:true});
  const moved=copy(raw);moved.result=path.join(migrated,'runs','case');moved.mask=path.join(moved.result,'mask.nrrd');
  assert.deepEqual(await createResultIdentities(migrated,a.originStoreId).get(moved),a,'Recovery/copy retains origin identity');
  await assert.rejects(createResultIdentities(migrated,randomUUID()).get(moved));
  const identity=path.join(raw.result,'identity.json');fs.writeFileSync(identity,'{corrupt');
  await assert.rejects(createResultIdentities(root).get(copy(raw)));
  assert.equal(fs.readFileSync(identity,'utf8'),'{corrupt','Never replace a corrupt identity with a new one');
  fs.unlinkSync(path.join(migrated,'result-origin.json'));
  await assert.rejects(createResultIdentities(migrated).get(moved),'Missing marker is not a new origin');
  console.log('PASS: stable origin/revisions, concurrent variants, Raw return, late mesh, replacement detection, recovery and corruption');
}
async function dispatcher() {
  const future=publication('future');
  future.summary.solutionId=future.record.solutionId='exmo.future.ct';
  fs.writeFileSync(path.join(future.result,'published.json'),JSON.stringify(future));
  fs.writeFileSync(path.join(root,'library.json'),JSON.stringify([future.record]));
  const known = [publication('ct'),publication('mri','mri'),...['AP','LAT_LT','LAT_RT'].map(route => publication(route,'xray',route))];
  fs.mkdirSync(path.join(known[1].result,'raw'));fs.writeFileSync(path.join(known[1].result,'raw','metrics.json'),JSON.stringify({classes:[{label_id:1,volume_ml:12,voxel_count:12}]}));
  const saved = new Map();
  for (const item of known) {
    const filename=path.join(item.result,'published.json');fs.writeFileSync(filename,JSON.stringify(item));saved.set(filename,fs.readFileSync(filename));
  }
  const palette=path.join(root,'palette.json');fs.writeFileSync(palette,'[]');
  const localRequire=createRequire(path.resolve('desktop/imaging.cjs'));
  const handlers=new Map(), frame={url:'atlas://app/'}, window={webContents:{mainFrame:frame,send(){}}};
  const context={module:{exports:{}},process,console,URL,setTimeout,clearTimeout,AbortController,
    require:name=>name==='electron'?{ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)}}:localRequire(name)};
  vm.runInNewContext(fs.readFileSync('desktop/imaging.cjs','utf8'),context);
  const backend=context.module.exports.installImaging(window,{engineRoot:root,storageRoot:root,scriptsRoot:root,palette});
  const call=(name,...args)=>handlers.get('exmo:imaging:'+name)({sender:window.webContents,senderFrame:frame},...args);
  try {
    assert.equal((await call('solutions')).value.length,3);
    for (const solution of solutions) {
      const result=await call('results',solution.id);assert(result.ok,result.error);
      assert.equal(result.value.length,solution.routes.length);
      assert.ok(result.value.every(row=>row.solutionId===solution.id && row.analysisRevision));
      assert.deepEqual(result.value,(await call('results',solution.analysis)).value,'Legacy aliases and stable IDs agree');
    }
    assert.equal((await call('list','ct')).value.length,0,'Same modality does not include a different solution');
    for (const [name,args] of [
      ['run',['exmo.future.ct',['future'],[],'cpu']],['run',['ct',['future'],[],'cpu']],
      ['preview',['ct','future']],['results',['exmo.future.ct']],['resultPreview',['future']],
      ['variant',['future','raw']],['exportResults',['ct',['future'],'en']],
      ['assignPatientStudy',['ct',['future'],{patientId:'x',patientIssuer:'y'}]],
    ]) assert.equal((await call(name,...args)).ok,false,`${name} must not route an unknown solution to CT`);
    for (const [filename,bytes] of saved)assert.deepEqual(fs.readFileSync(filename),bytes);
    console.log('PASS: five legacy routes, solution-scoped IPC, unknown same-modality isolation and unchanged publications');
  } finally {await backend.dispose();}
  const damaged=path.join(root,'runs','ct','identity.json');fs.writeFileSync(damaged,'{corrupt');
  const reopened=context.module.exports.installImaging(window,{engineRoot:root,storageRoot:root,scriptsRoot:root,palette});
  try {
    const reply=await call('results','ct');assert(reply.ok);
    assert.equal(reply.value.length,1);assert.equal(reply.value[0].rows[0].value,12);
    assert.equal(reply.value[0].identityDiagnostic.code,'RESULT_IDENTITY');
    assert.equal(reply.value[0].originResultId,undefined);
    assert.equal(fs.readFileSync(damaged,'utf8'),'{corrupt');
    assert.equal((await call('results','mri')).value.length,1,'Other solutions remain readable');
    console.log('PASS: corrupt identity is reported per case without hiding clinical results or reminting IDs');
  } finally {await reopened.dispose();}
}
(async()=>{
  try {
    assert.deepEqual(solutions.map(s=>s.routes).flat(),['ct','mri','AP','LAT_LT','LAT_RT']);
    for(const solution of solutions)assert.equal(resolveSolution(solution.analysis),resolveSolution(solution.id));
    assert.throws(()=>resolveSolution('exmo.future.ct'));assert.throws(()=>solutionFields({analysis:'ct',solutionId:null}));
    assert.throws(()=>solutionFields({analysis:'ct',solutionId:'exmo.thigh.mri'}));
    assert.throws(()=>solutionFields({analysis:'ct',resultSchema:'future-schema'}));
    assert.equal(matchesSolution({analysis:'ct',solutionId:'exmo.future.ct'},'ct'),false);
    await identities();
    // Keep the malformed identity fixture out of the five-route count below.
    fs.unlinkSync(path.join(root,'runs','case','published.json'));
    await dispatcher();
  } finally {
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
