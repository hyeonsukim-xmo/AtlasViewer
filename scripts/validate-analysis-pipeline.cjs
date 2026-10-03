const assert = require('node:assert/strict');
const {Capacity, resources, runPipeline, estimateMemory} = require('../desktop/analysis-pipeline.cjs');
const tick = () => new Promise(resolve=>setImmediate(resolve));
(async()=>{
  const capacity=new Capacity(10), a=await capacity.acquire(8);
  let entered=false;
  const waiting=capacity.acquire(5).then(value=>{entered=true;return value});
  await tick();assert.equal(entered,false);
  a.resize(4);const b=await waiting;assert.equal(capacity.used,9);
  a.release();a.release();b.release();assert.equal(capacity.used,0);
  const big=await capacity.acquire(20);
  const controller=new AbortController();
  const queued=capacity.acquire(1,controller.signal);controller.abort();
  await assert.rejects(queued,{name:'AbortError'});assert.equal(capacity.waiters.length,0);
  big.release();assert.equal(capacity.used,0);
  const lanes=resources({totalMemory:32*1024**3,freeMemory:24*1024**3});
  let active=0,peak=0,gpu=0,cpu=0,overlap=false;
  const failures=[],done=[];
  const delay=()=>new Promise(resolve=>setTimeout(resolve,8));
  await runPipeline(Array.from({length:12},(_,id)=>({id})),{
    signal:new AbortController().signal,failed:(file)=>failures.push(file.id),
    execute:async file=>{
      active++;peak=Math.max(peak,active);
      try {
        const g=await lanes.gpu.acquire();assert.equal(++gpu,1);overlap ||= cpu===1;
        await delay();gpu--;g.release();
        const c=await lanes.cpu.acquire();assert.equal(++cpu,1);overlap ||= gpu===1;
        try {await delay();if(file.id===3)throw Error('expected');done.push(file.id);}
        finally {cpu--;c.release();}
      } finally {active--;}
    },
  });
  assert.equal(peak,2);assert.ok(overlap);assert.deepEqual(failures,[3]);assert.equal(done.length,11);
  const cancellation=new AbortController();let starts=0;
  await runPipeline(Array.from({length:100},(_,id)=>({id})),{
    signal:cancellation.signal,failed:()=>assert.fail('Cancelled tasks are not failures'),
    execute:async()=>{starts++;cancellation.abort();throw Error('cancelled')},
  });
  assert.equal(starts,1);
  let modelActive=0,finalizing=0,postprocessing=0,postAndFinalOverlap=false;
  await runPipeline(Array.from({length:9},(_,id)=>({id})),{
    signal:new AbortController().signal,concurrency:3,failed:(_f,e)=>{throw e},
    execute:async()=>{
      const m=await lanes.model.acquire();assert.ok(++modelActive<=2);
      const g=await lanes.gpu.acquire();await delay();g.release();
      const c=await lanes.cpu.acquire();postprocessing++;postAndFinalOverlap ||= finalizing>0;
      await delay();postprocessing--;c.release();modelActive--;m.release();
      const f=await lanes.finalize.acquire();finalizing++;postAndFinalOverlap ||= postprocessing>0;
      await delay();finalizing--;f.release();
    },
  });
  assert.ok(postAndFinalOverlap,'Result preparation must not block the next CPU tail');
  assert.equal(lanes.model.used+lanes.cpu.used+lanes.gpu.used+lanes.finalize.used,0);
  for(const analysis of ['ct','mri','xray']) {
    const estimate=estimateMemory({analysis,metadata:{size:[512,512,711],spacing:[.85,.85,1]}});
    assert.ok(estimate.gpu>=estimate.cpu && estimate.cpu>0);
  }
  console.log('PASS: bounded GPU/CPU overlap, FIFO memory admission, oversized isolation, cancellation, failure continuation');
})().catch(error=>{console.error(error);process.exitCode=1});
