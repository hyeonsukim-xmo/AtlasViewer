// Read-only audit of a completed real fixture, including resource-limited runs.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const directory=path.resolve(process.argv[2]);
const runs=fs.readdirSync(path.join(directory,'runs')).map(id=>{
  const root=path.join(directory,'runs',id);
  const events=fs.readFileSync(path.join(root,'engine-private.log'),'utf8').trim().split('\n').map(JSON.parse);
  const published=JSON.parse(fs.readFileSync(path.join(root,'published.json'),'utf8'));
  const time=stage=>{const e=events.find(e=>e.stage===stage);assert.ok(e,stage);return e.monotonic_seconds;};
  return {id,result:published.result,start:time('model_loading'),
    gpu:[time('inference_start'),time('cpu_ready')],cpu:[time('cpu_started'),time('complete')],
    inverseSeconds:time('result_export_start')-time('native_inverse_start'),
    peakHostProcessBytes:events.find(e=>e.stage==='complete').peak_host_process_memory_bytes,
    jobCreated:fs.statSync(path.join(root,'job.json')).mtimeMs,
    publishedAt:fs.statSync(path.join(root,'published.json')).mtimeMs};
}).sort((a,b)=>a.start-b.start);
assert.equal(runs.length,JSON.parse(fs.readFileSync(path.join(directory,'library.json'),'utf8')).length);
for(let i=1;i<runs.length;i++) {
  assert.ok(runs[i].gpu[0]>=runs[i-1].gpu[1]);
  assert.ok(runs[i].cpu[0]>=runs[i-1].cpu[1]);
}
assert.ok(runs.some((r,i)=>i>0 && r.gpu[0]<runs[i-1].cpu[1]));
console.log(JSON.stringify({passed:true,scope:'Completed outputs and model-stage scheduling from persisted logs; not clinical validation',
  secondsFromFirstJobFileToLastPublication:(Math.max(...runs.map(r=>r.publishedAt))-Math.min(...runs.map(r=>r.jobCreated)))/1000,runs},null,2));
