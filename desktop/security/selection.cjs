// Signed, fixed dependency closures. A catalog supplies data, never new workflows or commands.
const fs=require('node:fs'),path=require('node:path');
const P=require('./license-protocol.cjs'),M=require('./model-package.cjs');
const {inventory,safeName,verifyRecordsAsync}=require('./payload.cjs');
const GRAPH=Object.freeze({reader:['common'],ct:['common','gpu','ct'],mri:['common','mri'],xray:['common','gpu','xray']});
const ENGINES=Object.freeze({reader:[],ct:['ct'],mri:['mri'],xray:['ap','lat_lt','lat_rt','xray-classifier']});
const IDS=['common','gpu','ct','mri','xray'];
function read(file,limit=64*1024**2){const stat=fs.lstatSync(file);P.check(stat.isFile() && !stat.isSymbolicLink() && stat.size<=limit);return fs.readFileSync(file);}
function tokenFile(file){const value=JSON.parse(read(file,M.LIMIT));P.fields(value,['token']);return value.token;}
function profile(value,expected){P.check(['internal','customer'].includes(value) && (!expected || value===expected),'Package profile mismatch');}
function selection(token,issuer,expectedProfile){
  const value=M.verify(token,issuer,'exmo-selected-payload-v1');
  P.fields(value,['schema','version','profile','python','selection','components','models']);P.id(value.version);profile(value.profile,expectedProfile);
  P.check(value.python==='3.12.8' && Object.hasOwn(GRAPH,value.selection),'Unsupported selected runtime');
  P.fields(value.components,GRAPH[value.selection]);Object.values(value.components).forEach(P.digest);
  P.fields(value.models,ENGINES[value.selection]);Object.values(value.models).forEach(P.digest);
  return value;
}
function catalog(root,issuer,expectedProfile){
  const token=tokenFile(path.join(root,'catalog.json')),v=M.verify(token,issuer,'exmo-install-catalog-v1');
  P.fields(v,['schema','version','profile','sets']);P.id(v.version);profile(v.profile,expectedProfile);P.fields(v.sets,Object.keys(GRAPH));
  for(const [name,signed] of Object.entries(v.sets)){
    const s=selection(signed,issuer,v.profile);P.check(s.selection===name && s.version===v.version);
    for(const id of GRAPH[name])P.check(s.components[id]===selection(v.sets[id==='gpu'?'ct':id==='common'?'reader':id],issuer,v.profile).components[id],'Inconsistent shared component');
  }
  return v;
}
function owned(id,name){
  if(id==='common')return name.startsWith('python/') || name.startsWith('envs/reader/') || name.startsWith('envs/security/') || name.startsWith('adapters/') || name==='verified-packages.json';
  if(id==='gpu')return name.startsWith('envs/ap/') || name.startsWith('envs/xray-common/');
  if(id==='ct')return name.startsWith('envs/ct/') || name.startsWith('packages/EXMO_CT/');
  if(id==='mri')return name.startsWith('envs/mri/') || name.startsWith('packages/EXMO_MRI/');
  return name.startsWith('envs/lat/') || name.startsWith('packages/EXMO_XRAY/');
}
function component(root,issuer,expectedDigest,expectedId,expectedProfile){
  const token=tokenFile(path.join(root,'component.json'));P.check(M.hash(Buffer.from(token))===expectedDigest,'Component signature binding mismatch');
  const v=M.verify(token,issuer,'exmo-runtime-component-v1');P.fields(v,['schema','id','version','profile','indexSha256']);
  P.check(IDS.includes(v.id) && v.id===expectedId);P.id(v.version);profile(v.profile,expectedProfile);P.digest(v.indexSha256);
  const bytes=read(path.join(root,'files.json'));P.check(M.hash(bytes)===v.indexSha256,'Component index signature mismatch');
  const records=JSON.parse(bytes);P.check(Array.isArray(records) && records.length>0 && records.length<=150000);
  const names=new Set();
  for(const r of records){P.fields(r,['path','size','sha256']);safeName(r.path);P.integer(r.size);P.digest(r.sha256);
    P.check(owned(v.id,r.path) && !names.has(r.path.toLowerCase()),'Invalid component ownership');names.add(r.path.toLowerCase());}
  const required={common:['python/python.exe','envs/reader/Lib/site-packages/numpy/__init__.py','envs/security/Lib/site-packages/cryptography/__init__.py','adapters/imaging-worker.py','adapters/model-runner.py','adapters/model_security.py','adapters/model-policy.json','adapters/imaging-palette.json','verified-packages.json'],
    gpu:['envs/ap/Lib/site-packages/cryptography/__init__.py'],ct:['envs/ct/Lib/site-packages/cryptography/__init__.py'],mri:['envs/mri/Lib/site-packages/cryptography/__init__.py'],xray:['envs/lat/Lib/site-packages/cryptography/__init__.py']};
  for(const name of required[v.id])P.check(names.has(name.toLowerCase()),'Required component file missing: '+name);
  P.check(!records.some(r=>r.path.startsWith('packages/') && /\.(pth|safetensors|npz)$/i.test(r.path)),'Plaintext model in selected payload');
  return {token,policy:v,records};
}
function exactInventory(root,records){
  const names=inventory(root),expected=new Set(records.map(r=>r.path.toLowerCase()));
  P.check(names.length===records.length && names.every(n=>expected.has(n.toLowerCase())),'Unexpected or missing selected runtime file');
}
async function verifyFiles(root,records,onProgress=()=>{}){
  exactInventory(root,records);
  await verifyRecordsAsync(root,records,onProgress);
}
function inspectSet(root,issuer,expectedProfile){
  const token=tokenFile(path.join(root,'payload.json')),policy=selection(token,issuer,expectedProfile),records=[];
  for(const [id,digest] of Object.entries(policy.components))records.push(...component(path.join(root,'manifests',id),issuer,digest,id,policy.profile).records);
  const names=new Set(records.map(r=>r.path.toLowerCase()));P.check(names.size===records.length);
  // Metadata is authenticated separately; no unlisted executable is tolerated in the materialized set.
  const metadata=Object.keys(policy.components).flatMap(id=>[`manifests/${id}/component.json`,`manifests/${id}/files.json`]);
  const actual=inventory(root);P.check(actual.length===records.length+metadata.length && actual.every(n=>names.has(n.toLowerCase()) || metadata.includes(n)),'Unexpected selected runtime file');
  const byName=new Map(records.map(r=>[r.path,r]));
  for(const engine of ENGINES[policy.selection]){
    const family=engine==='ct'?'EXMO_CT':engine==='mri'?'EXMO_MRI':'EXMO_XRAY';
    const prefix='packages/'+family+'/',name=['ct','mri'].includes(engine)?'model-package.json':`model-package-${engine}.json`;
    const signed=tokenFile(path.join(root,prefix,name)),manifest=M.manifest(signed,issuer);
    P.check(M.hash(Buffer.from(signed))===policy.models[engine] && manifest.engine===engine,'Selected model binding mismatch');
    const assets=manifest.assets || [{path:'weights/final.safetensors',size:manifest.size,cipherSha256:manifest.cipherSha256}];
    for(const r of [...manifest.files,...assets.map(a=>({path:a.path+'.enc',size:a.size+16,sha256:a.cipherSha256}))]){
      const actual=byName.get(prefix+r.path);P.check(actual && actual.size===r.size && actual.sha256===r.sha256,'Selected model delivery incomplete');
    }
  }
  const worker=JSON.parse(read(path.join(root,'adapters/model-policy.json'),8192));
  P.fields(worker,['profile','issuerPublicKey','licenseVersion']);P.check(worker.profile===policy.profile && worker.licenseVersion===3 && P.fingerprint(require('node:crypto').createPublicKey(worker.issuerPublicKey))===P.fingerprint(issuer),'Selected worker trust mismatch');
  return {token,policy,records};
}
async function verifySet(root,issuer,expectedProfile,onProgress=()=>{}){
  const inspected=inspectSet(root,issuer,expectedProfile);
  await verifyRecordsAsync(root,inspected.records,onProgress);return inspected;
}
module.exports={GRAPH,ENGINES,IDS,read,tokenFile,selection,catalog,owned,component,exactInventory,verifyFiles,inspectSet,verifySet};
