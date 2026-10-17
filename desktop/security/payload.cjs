const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const P=require('./license-protocol.cjs');
const M=require('./model-package.cjs');
function safeName(name){
  P.check(typeof name==='string' && name.length<500 && !/[\\<>:"|?*\x00-\x1f]/.test(name) && !name.startsWith('/') && !name.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)),'Unsafe payload path');return name;
}
function hashFile(file) {
  const stat=fs.lstatSync(file);P.check(stat.isFile() && !stat.isSymbolicLink());
  const hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(Math.max(1,Math.min(stat.size,4*1024**2))),fd=fs.openSync(file,'r');
  try {let count,total=0;while((count=fs.readSync(fd,buffer,0,buffer.length,null))){hash.update(buffer.subarray(0,count));total+=count;}P.check(total===stat.size && fs.fstatSync(fd).mtimeMs===stat.mtimeMs,'Payload changed during verification');return {size:total,sha256:hash.digest('hex')};}
  finally {fs.closeSync(fd);}
}
function inventory(root) {
  const result=[];
  const stat=fs.lstatSync(root);P.check(stat.isDirectory() && !stat.isSymbolicLink(),'Payload root must be a real directory');
  function visit(relative){
    for(const entry of fs.readdirSync(path.join(root,relative),{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
      P.check(!entry.isSymbolicLink(),'Payload reparse point prohibited');
      const name=relative?relative+'/'+entry.name:entry.name;
      if(entry.isDirectory())visit(name);
      else {P.check(entry.isFile());safeName(name);if(!['payload.json','files.json'].includes(name))result.push(name);}
    }
  }
  visit('');return result;
}
function inspectPayload(root,issuer,checkFile,timings={}) {
  let started=performance.now();
  root=path.resolve(root);const document=path.join(root,'payload.json');P.check(fs.statSync(document).size<=M.LIMIT);
  const signed=JSON.parse(fs.readFileSync(document,'utf8'));P.fields(signed,['token']);
  const policy=M.verify(signed.token,issuer,'exmo-runtime-payload-v1');
  P.fields(policy,['schema','version','profile','python','indexSha256','models',...(policy.layout!==undefined?['layout']:[])]);P.id(policy.version);
  P.check(policy.layout===undefined || policy.layout==='xray-shared-v1','Unsupported runtime layout');
  P.check(['internal','customer'].includes(policy.profile) && policy.python==='3.12.8');P.digest(policy.indexSha256);
  const indexFile=path.join(root,'files.json');P.check(fs.statSync(indexFile).size<=64*1024**2);
  const data=fs.readFileSync(indexFile);P.check(M.hash(data)===policy.indexSha256,'Payload index signature mismatch');
  const records=JSON.parse(data);P.check(Array.isArray(records) && records.length>0 && records.length<=150000);
  timings.indexMs=performance.now()-started;started=performance.now();
  const actual=inventory(root),names=new Set(),byName=new Map();P.check(actual.length===records.length,'Unexpected or missing runtime file');
  timings.inventoryMs=performance.now()-started;started=performance.now();
  for(const record of records){
    P.fields(record,['path','size','sha256']);safeName(record.path);P.integer(record.size);P.digest(record.sha256);
    P.check(!names.has(record.path.toLowerCase()));names.add(record.path.toLowerCase());
    byName.set(record.path,record);
    checkFile?.(path.join(root,record.path),record);
  }
  P.check(actual.every(name=>names.has(name.toLowerCase())));
  const sharedTorch='envs/xray-common/Lib/site-packages/torch/__init__.py';
  P.check(names.has(sharedTorch.toLowerCase())===(policy.layout==='xray-shared-v1'),'Shared runtime layout mismatch');
  if(policy.layout)P.check(!actual.some(name=>/^envs\/(ap|lat)\/Lib\/site-packages\/torch\//.test(name)),'Mixed shared and private torch runtimes');
  for(const name of ['python/python.exe','verified-packages.json',...['ct','mri','ap','lat','security'].map(e=>`envs/${e}/Lib/site-packages/cryptography/__init__.py`)])P.check(names.has(name.toLowerCase()),'Required runtime missing: '+name);
  P.fields(policy.models,M.ENGINES);
  for(const engine of M.ENGINES){
    const family=engine==='mri'?'EXMO_MRI':engine==='ct'?'EXMO_CT':'EXMO_XRAY';
    const file=engine==='mri'||engine==='ct'?'model-package.json':`model-package-${engine}.json`;
    const model=JSON.parse(fs.readFileSync(path.join(root,'packages',family,file),'utf8'));
    const manifest=M.manifest(model.token,issuer);
    P.check(M.hash(Buffer.from(model.token))===policy.models[engine] && manifest.engine===engine,'Model/runtime binding mismatch');
    const assets=manifest.assets || [{path:'weights/final.safetensors',size:manifest.size,cipherSha256:manifest.cipherSha256}];
    for(const expected of [...manifest.files,...assets.map(v=>({path:v.path+'.enc',size:v.size+16,sha256:v.cipherSha256}))]){
      const installed=byName.get('packages/'+family+'/'+expected.path);
      P.check(installed && installed.size===expected.size && installed.sha256===expected.sha256,'Model delivery is incomplete or inconsistent');
    }
  }
  P.check(!actual.some(name=>name.startsWith('packages/') && /\.(pth|safetensors|npz)$/i.test(name)),'Plaintext model in payload');
  timings.bindingMs=performance.now()-started;
  timings.files=records.length;timings.bytes=records.reduce((sum,r)=>sum+r.size,0);
  return {policy,records};
}
function checkFile(file,record){const value=hashFile(file);P.check(value.size===record.size && value.sha256===record.sha256,'Runtime file failed integrity verification: '+record.path);}
function verifyPayload(root,issuer){return inspectPayload(root,issuer,checkFile).policy;}
async function verifyPayloadAsync(root,issuer,onProgress=()=>{},timings={}){
  const started=performance.now();
  const {policy,records}=inspectPayload(root,issuer,undefined,timings);
  try{await verifyRecordsAsync(root,records,onProgress,timings);return policy;}
  finally{timings.totalMs=performance.now()-started;}
}
async function verifyRecordsAsync(root,records,onProgress=()=>{},timings={}){
  const {Worker}=require('node:worker_threads');
  const hashStarted=performance.now();
  const workers=[],counts=[0,0,0,0];
  timings.workers=[];
  try {
    await Promise.all(counts.map((_,index)=>new Promise((resolve,reject)=>{
      const worker=new Worker(path.join(__dirname,'payload-verifier.cjs'),{workerData:{root:path.resolve(root),records:records.filter((_,i)=>i%4===index)}});workers.push(worker);
      worker.on('error',reject);worker.on('exit',code=>code===0?resolve():reject(Error('Runtime integrity verification failed')));
      worker.on('message',value=>{counts[index]=value.completed;timings.workers[index]=value;onProgress(counts.reduce((a,b)=>a+b,0),records.length);});
    })));
  }finally{await Promise.all(workers.map(w=>w.terminate()));timings.hashMs=performance.now()-hashStarted;}
}
module.exports={safeName,hashFile,inventory,verifyPayload,verifyPayloadAsync,verifyRecordsAsync,checkFile};
