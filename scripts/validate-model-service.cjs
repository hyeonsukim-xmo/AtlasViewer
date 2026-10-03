// Real per-modality GPU service completion; no app data is modified.
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const {AnalysisWorker}=require('../desktop/analysis-worker.cjs');
const root=path.resolve(__dirname,'..');
const engine=path.join(process.env.LOCALAPPDATA,'EXMO Atlas/engine');
const reference=path.join(engine,'validation/transfer-20260928-042706-ce6e26');
const storage=fs.mkdtempSync(path.join(path.dirname(root),'ms-'));
const cases=(process.argv[2]||'ap,lat_lt,lat_rt,mri').split(',');
(async()=>{
  const reports=[];
  console.log(JSON.stringify({storage}));
  for(const name of cases) {
    const job=JSON.parse(fs.readFileSync(path.join(reference,name,'job.json'),'utf8'));
    const env=job.analysis==='mri'?'mri':job.route==='AP'?'ap':'lat';
    const worker=new AnalysisWorker({python:path.join(engine,'envs',env,'Scripts/python.exe'),
      args:['-X','utf8',path.join(root,'desktop/model-service.py'),'--engine-root',engine],
      env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:'4',OPENBLAS_NUM_THREADS:'2'},
      logPath:path.join(storage,name+'-private.log')});
    const started=performance.now();let handoffs=0;
    try {
      job.output=path.join(storage,name);job.device='cuda:0';
      const result=await worker.request({operation:'run',job},{id:name,timeout:20*60000,
        logPath:path.join(storage,name+'-events.jsonl'),onEvent:event=>{
          if(event.stage==='cpu_ready'){handoffs++;worker.send({operation:'resume_cpu',id:name});}
          console.log(JSON.stringify({name,stage:event.stage,seconds:(performance.now()-started)/1000}));
        }});
      assert.equal(handoffs,1);assert.equal(result.complete,true);
      assert.equal(result.execution.device,'cuda:0');assert.ok(result.execution.peak_gpu_memory_bytes>0);
      reports.push({name,seconds:(performance.now()-started)/1000,result:result.result,execution:result.execution});
    } finally {await worker.close();}
  }
  fs.writeFileSync(path.join(storage,'report.json'),JSON.stringify({passed:true,reports},null,2));
  console.log(JSON.stringify({passed:true,storage,reports}));
})().catch(error=>{console.error(error);process.exitCode=1});
