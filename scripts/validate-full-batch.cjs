// Real dispatcher logic with simulated model work; no clinical inference is run.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');
const resources = process.argv[2];
const source = resources ? require('@electron/asar').extractFile(path.join(resources,'app.asar'),'desktop/imaging.cjs').toString('utf8') : fs.readFileSync(path.join(root,'desktop/imaging.cjs'),'utf8');
const start = source.indexOf('  handle("run",');
const end = source.indexOf('  handle("clear",',start);
assert.ok(start>0 && end>start);
const handlers = new Map();
const files = new Map(Array.from({length:118},(_,i)=>[String(i),{id:String(i),name:'Fixture '+i,ready:true,confirmation:'hu'}]));
const ids = [...files.keys()];
const fixture = {started:[],active:0,peak:0,fail:'57'};
const power = {active:new Set(),next:0};
const sleep = ms=>new Promise(resolve=>setTimeout(resolve,ms));
const context = {
  AbortController, runPipeline: require('../desktop/analysis-pipeline.cjs').runPipeline,
  resources: require('../desktop/analysis-pipeline.cjs').resources,
  pipelineController:null, pipelineResources:null, closeAnalysisWorkers:async()=>{},
  powerSaveBlocker:{start:type=>{assert.equal(type,'prevent-app-suspension');const id=++power.next;power.active.add(id);return id},stop:id=>{assert.ok(power.active.delete(id))}},
  files, selecting:false, batch:null, cancelled:false, disposed:false, child:null, pending:null, runPromise:null,
  randomUUID:require('node:crypto').randomUUID,
  handle:(name,fn)=>handlers.set(name,fn),
  validateAnalysis:value=>assert.equal(value,'ct'),
  getFile:(_analysis,id)=>{assert.ok(files.has(id));return files.get(id)},
  execute:async file=>{
    fixture.started.push(file.id);fixture.active++;fixture.peak=Math.max(fixture.peak,fixture.active);
    await sleep(2);fixture.active--;
    if(context.cancelled)return;
    if(file.id===fixture.fail)throw new Error('Simulated model failure');
    context.batch.completed.push({id:file.id});
  },
};
vm.runInNewContext(source.slice(start,end),context);
(async()=>{
  assert.throws(()=>handlers.get('run')('ct',ids,[],'cpu'));
  const batch=handlers.get('run')('ct',ids,ids,'cpu');
  assert.equal(power.active.size,1);
  assert.equal(batch.total,118);
  assert.throws(()=>handlers.get('run')('ct',ids,ids,'cpu'));
  await context.runPromise;
  assert.equal(power.active.size,0);
  assert.equal(context.batch.completed.length,117);
  assert.equal(context.batch.failed.length,1);
  assert.deepEqual(fixture.started,ids);
  assert.equal(fixture.peak,1);
  fixture.started=[];fixture.fail=null;
  handlers.get('run')('ct',ids,ids,'cpu');
  while(fixture.started.length<5)await sleep(1);
  await handlers.get('cancel')('ct');
  assert.equal(power.active.size,0);
  assert.equal(context.batch.state,'cancelled');
  assert.ok(fixture.started.length<118);
  assert.ok(context.batch.completed.length>0);
  const report={passed:true,packaged:!!resources,selected:118,attempted:118,completed:117,failed:1,peakConcurrentModels:fixture.peak,cancelledAfter:fixture.started.length,simulatedModelWork:true};
  const output=path.join(root,'outputs/full-batch-check');
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1});
