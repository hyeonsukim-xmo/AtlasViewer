const {parentPort,workerData}=require('node:worker_threads');
const path=require('node:path'),{checkFile}=require('./payload.cjs');
const started=performance.now();let bytes=0;
for(let i=0;i<workerData.records.length;i++){
  const record=workerData.records[i],file=path.join(workerData.root,record.path);
  checkFile(file,record);
  bytes+=record.size;
  if(i%256===0)parentPort.postMessage({completed:i+1,bytes,elapsedMs:performance.now()-started});
}
parentPort.postMessage({completed:workerData.records.length,bytes,elapsedMs:performance.now()-started});
