const {parentPort,workerData}=require('node:worker_threads');
const path=require('node:path'),{checkFile}=require('./payload.cjs');
for(let i=0;i<workerData.records.length;i++){
 const record=workerData.records[i];checkFile(path.join(workerData.root,record.path),record);
 if(i%256===0)parentPort.postMessage(i+1);
}
parentPort.postMessage(workerData.records.length);
