const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {AnalysisWorker}=require('../desktop/analysis-worker.cjs');
const directory=path.join(__dirname,'../outputs/worker-validation');fs.mkdirSync(directory,{recursive:true});
const server=`const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);
if(m.operation==='crash')process.exit(7);
if(m.operation==='hang')return;
if(m.operation==='handoff'){console.log(JSON.stringify({exmo:true,job_id:m.id,stage:'cpu_ready'}));return;}
if(m.operation==='model')console.log(JSON.stringify({exmo:true,job_id:m.id,stage:'complete',value:m.value}));
else console.log(JSON.stringify({id:m.id,result:m.value}));
});`;
const worker=()=>new AnalysisWorker({python:process.execPath,args:['-e',server],env:process.env,logPath:path.join(directory,'private.log')});
(async()=>{
  let w=worker();
  assert.deepEqual(await Promise.all([w.request({value:1}),w.request({value:2})]),[1,2]);
  assert.equal((await w.request({operation:'model',value:3})).value,3);
  await assert.rejects(w.request({operation:'crash'}));
  assert.equal(await w.request({value:4}),4,'Unexpected process exit may restart');
  await w.close();assert.equal(w.child,null);
  w=worker();
  const hanging=w.request({operation:'hang'});
  const rejected=assert.rejects(hanging);
  await Promise.all([w.stop(),w.stop()]);await rejected;assert.equal(w.pending.size,0);
  w=worker();
  await assert.rejects(w.request({operation:'handoff'},{onEvent:()=>{throw Error('handoff')}}));
  await w.stop();
  console.log('PASS: protocol routing, process crash/restart, cancellation and idempotent shutdown');
})().catch(error=>{console.error(error);process.exitCode=1});
