const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const P=require('./license-protocol.cjs'),M=require('./model-package.cjs'),S=require('./selection.cjs');
const {atomicWrite}=require('./storage.cjs');
const {resolveSolution}=require('../solutions.cjs');
const uuid=value=>typeof value==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const empty=()=>({schema:1,reader:null,solutions:{}});
function pointer(value){
  P.fields(value,['schema','reader','solutions']);P.check(value.schema===1 && (value.reader===null || uuid(value.reader)));
  P.check(value.solutions && typeof value.solutions==='object' && !Array.isArray(value.solutions));
  for(const [name,id] of Object.entries(value.solutions))P.check(['ct','mri','xray'].includes(name) && uuid(id));return value;
}
function openInstallations({root,issuer,profile,onChange=()=>{},checkpoint=async()=>{}}){
  root=path.resolve(root);fs.mkdirSync(root,{recursive:true});
  for(const p of [root,...parents(root)])P.check(!fs.lstatSync(p).isSymbolicLink(),'Installation store reparse point prohibited');
  const sets=path.join(root,'sets'),staging=path.join(root,'staging');fs.mkdirSync(sets,{recursive:true});fs.mkdirSync(staging,{recursive:true});
  for(const directory of [sets,staging])P.check(!fs.lstatSync(directory).isSymbolicLink(),'Installation store reparse point prohibited');
  const activeFile=path.join(root,'active.json'),previousFile=path.join(root,'previous.json'),journalFile=path.join(root,'journal.json');
  const legacyReaderFile=path.join(root,'legacy-reader.json');
  const pins=new Map(),states=new Map();let busy=false,closed=false;
  function readPointer(file){return fs.existsSync(file)?pointer(JSON.parse(S.read(file,65536))):empty();}
  let active;
  try{active=readPointer(activeFile);}catch{active=readPointer(previousFile);atomicWrite(activeFile,JSON.stringify(active));}
  function location(id){P.check(uuid(id));const file=path.join(sets,id);P.check(path.dirname(file)===sets);return file;}
  function metadata(id){const file=location(id);P.check(!fs.lstatSync(file).isSymbolicLink());return S.selection(S.tokenFile(path.join(file,'payload.json')),issuer,profile);}
  function notify(name,state,extra={}){states.set(name,{state,...extra});onChange(status());}
  function status(){const prior=readPointer(previousFile);return {supported:true,busy,reader:states.get('reader'),solutions:['ct','mri','xray'].map(analysis=>({analysis,solutionId:resolveSolution(analysis).id,installed:Boolean(active.solutions[analysis]),canRollback:Boolean(prior.solutions[analysis] && prior.solutions[analysis]!==active.solutions[analysis]),
    ...(active.solutions[analysis]?{version:version(active.solutions[analysis])}:{}),...(states.get(analysis)||{state:active.solutions[analysis]?'installed':'not-installed'})}))};}
  function version(id){try{return metadata(id).version;}catch{return null;}}
  function readerFor(policy){
    const candidates=[active.reader,...fs.readdirSync(sets).filter(uuid)].filter(Boolean);
    return candidates.find(id=>{try{const p=metadata(id);return p.selection==='reader' && p.components.common===policy.components.common;}catch{return false;}});
  }
  function context(id){
    const policy=metadata(id),engineRoot=location(id),readerId=policy.selection==='reader'?id:readerFor(policy);
    P.check(readerId,'Required archived reader is missing');
    return {engineRoot,scriptsRoot:path.join(engineRoot,'adapters'),palette:path.join(engineRoot,'adapters/imaging-palette.json'),readerId,selection:policy.selection,packageSetDigest:M.hash(Buffer.from(S.tokenFile(path.join(engineRoot,'payload.json'))))};
  }
  async function acquire(analysis,readerId){
    P.check(!closed);const name=analysis==='reader'?'reader':resolveSolution(analysis).analysis;
    const id=readerId && name==='reader'?(readerFor(metadata(readerId))??readerId):(name==='reader'?active.reader:active.solutions[name]);P.check(id,'Required solution is not installed');
    pins.set(id,(pins.get(id)||0)+1);
    let released=false;const release=()=>{if(!released){released=true;pins.set(id,pins.get(id)-1);}};
    try{
      notify(name,'verifying');const checked=await S.verifySet(location(id),issuer,profile,(done,total)=>notify(name,'verifying',{completed:done,total}));
      P.check(checked.policy.selection===name,'Installed selection mismatch');notify(name,'ready');
      return {...context(id),release};
    }catch(error){release();notify(name,'repair-required');throw error;}
  }
  function retain(context){
    const id=path.basename(context.engineRoot);P.check(location(id)===context.engineRoot);pins.set(id,(pins.get(id)||0)+1);
    let released=false;return ()=>{if(!released){released=true;pins.set(id,pins.get(id)-1);}};
  }
  async function removeDirectory(file,base){
    const resolved=path.resolve(file);P.check(path.dirname(resolved)===base && uuid(path.basename(resolved)),'Unsafe installation cleanup');
    P.check(fs.realpathSync.native(base).toLowerCase()===path.resolve(base).toLowerCase(),'Installation cleanup redirected');
    if(fs.existsSync(resolved)){P.check(!fs.lstatSync(resolved).isSymbolicLink());await fsp.rm(resolved,{recursive:true,force:true});}
  }
  async function collect(inTransaction=false){
    if(busy && !inTransaction)return;
    const prior=readPointer(previousFile),keep=new Set([active.reader,...Object.values(active.solutions),prior.reader,...Object.values(prior.solutions)]);
    for(const id of fs.readdirSync(sets).filter(uuid)){
      if(keep.has(id) || pins.get(id)>0)continue;
      try{if(metadata(id).selection==='reader')continue;}catch{continue;}
      try{await removeDirectory(location(id),sets);}catch(error){
        if(!['EBUSY','EPERM','EACCES'].includes(error.code))throw error;
        // Windows may retain a library handle briefly. Retry retired bytes on the next collection.
        console.error('Retired installation cleanup deferred:',error.code);
      }
    }
  }
  async function recover(){
    P.check(!busy);for(const id of fs.readdirSync(staging).filter(uuid))await removeDirectory(path.join(staging,id),staging);
    if(fs.existsSync(journalFile)){
      const journal=JSON.parse(S.read(journalFile,65536));P.check(journal.schema===1 && uuid(journal.id));
      atomicWrite(journalFile,JSON.stringify({...journal,phase:'recovered'}));
    }await collect();
  }
  async function inspect(bundle){
    const c=S.catalog(bundle,issuer,profile),choices={};
    for(const [name,token] of Object.entries(c.sets)){
      const policy=S.selection(token,issuer,profile);let bytes=0;
      for(const [id,digest] of Object.entries(policy.components))bytes+=S.component(path.join(bundle,'components',id),issuer,digest,id,profile).records.reduce((n,r)=>n+r.size,0);
      choices[name]={version:policy.version,bytes,token};
    }return {version:c.version,choices};
  }
  async function install(bundle,names,authorize,{commonOnly=false}={}){
    P.check(!busy && !closed && Array.isArray(names) && new Set(names).size===names.length && names.every(n=>['ct','mri','xray'].includes(n)));
    P.check(commonOnly?names.length===0:names.length>0);busy=true;
    const transaction=crypto.randomUUID(),directory=path.join(staging,transaction),next=structuredClone(active);
    const journal={schema:1,id:transaction,phase:'staging',before:active};
    try{
      const reviewed=await inspect(bundle);fs.mkdirSync(directory);atomicWrite(journalFile,JSON.stringify(journal));
      const reuse=new Map();
      // Reuse only bytes verified in this transaction. Hard links retain shared runtimes on uninstall.
      async function remember(id){const checked=await S.verifySet(location(id),issuer,profile);for(const r of checked.records)reuse.set(r.path+':'+r.sha256+':'+r.size,path.join(location(id),r.path));return checked;}
      let readerVerified=false;
      if(active.reader){try{await remember(active.reader);readerVerified=true;}catch{}}
      const shared=new Set(names.flatMap(name=>Object.entries(S.selection(reviewed.choices[name].token,issuer,profile).components).filter(([id])=>id!=='common').map(([,digest])=>digest)));
      for(const [name,old] of Object.entries(active.solutions)){
        try{if(names.includes(name) || Object.entries(metadata(old).components).some(([id,digest])=>id!=='common' && shared.has(digest)))await remember(old);}catch{}
      }
      for(const name of ['reader',...names]){
        const token=reviewed.choices[name].token,policy=S.selection(token,issuer,profile);
        if(name==='reader' && readerVerified){const old=metadata(active.reader);if(old.components.common===policy.components.common){next.reader=active.reader;continue;}}
        const id=crypto.randomUUID(),target=path.join(directory,id);fs.mkdirSync(target);const records=[];
        for(const [component,digest] of Object.entries(policy.components)){
          const source=path.join(bundle,'components',component),checked=S.component(source,issuer,digest,component,profile);
          S.exactInventory(path.join(source,'content'),checked.records);
          const meta=path.join(target,'manifests',component);fs.mkdirSync(meta,{recursive:true});
          for(const filename of ['component.json','files.json'])await fsp.copyFile(path.join(source,filename),path.join(meta,filename),fs.constants.COPYFILE_EXCL);
          records.push(...checked.records.map(r=>({...r,source:path.join(source,'content',r.path)})));
        }
        if(name!=='reader')await authorize({token,records});
        let done=0;for(const r of records){
          const dest=path.join(target,r.path);await fsp.mkdir(path.dirname(dest),{recursive:true});const existing=reuse.get(r.path+':'+r.sha256+':'+r.size);
          if(existing){try{await fsp.link(existing,dest);}catch(error){if(!['EXDEV','EPERM','ENOTSUP'].includes(error.code))throw error;await fsp.copyFile(existing,dest,fs.constants.COPYFILE_EXCL);}}
          else await fsp.copyFile(r.source,dest,fs.constants.COPYFILE_EXCL);
          if(++done%100===0)notify(name,'installing',{completed:done,total:records.length});
        }
        await fsp.writeFile(path.join(target,'payload.json'),JSON.stringify({token}),{flag:'wx'});
        await S.verifySet(target,issuer,profile,(done,total)=>notify(name,'verifying',{completed:done,total}));
        await checkpoint('verified',name);
        await fsp.rename(target,location(id));
        for(const r of records)reuse.set(r.path+':'+r.sha256+':'+r.size,path.join(location(id),r.path));
        if(name==='reader')next.reader=id;else next.solutions[name]=id;
      }
      for(const name of names){const id=next.solutions[name],checked=await S.verifySet(location(id),issuer,profile);await authorize({token:checked.token,records:checked.records});}
      await checkpoint('before-commit');
      // Pre-selection results stay on the first reader, including after a later update.
      if(!fs.existsSync(legacyReaderFile))atomicWrite(legacyReaderFile,JSON.stringify(next.reader));
      const prior=readPointer(previousFile);prior.reader=active.reader;
      for(const name of names){if(active.solutions[name])prior.solutions[name]=active.solutions[name];else delete prior.solutions[name];}
      atomicWrite(previousFile,JSON.stringify(prior));atomicWrite(activeFile,JSON.stringify(next));active=next;
      try{atomicWrite(journalFile,JSON.stringify({...journal,phase:'committed'}));}catch(error){console.error('Installation activated; journal completion deferred:',error.code);}
      await checkpoint('committed');
      for(const name of names)notify(name,'ready');await collect(true);
    }catch(error){for(const name of names)notify(name,'install-failed');throw error;}
    finally{busy=false;onChange(status());if(fs.existsSync(directory))await removeDirectory(directory,staging);}
    return status();
  }
  async function remove(analysis){
    P.check(!busy && !closed);const name=resolveSolution(analysis).analysis;busy=true;
    try{const next=structuredClone(active),prior=readPointer(previousFile);delete next.solutions[name];delete prior.solutions[name];
      atomicWrite(previousFile,JSON.stringify(prior));atomicWrite(activeFile,JSON.stringify(next));active=next;states.delete(name);await collect(true);return status();
    }finally{busy=false;onChange(status());}
  }
  async function rollback(analysis,authorize){
    P.check(!busy && !closed);const name=resolveSolution(analysis).analysis,prior=readPointer(previousFile),id=prior.solutions[name];P.check(id && id!==active.solutions[name],'No previous installed version');busy=true;
    try{const checked=await S.verifySet(location(id),issuer,profile);await authorize({token:checked.token,records:checked.records});
      const next=structuredClone(active);next.solutions[name]=id;prior.solutions[name]=active.solutions[name];atomicWrite(previousFile,JSON.stringify(prior));atomicWrite(activeFile,JSON.stringify(next));active=next;notify(name,'ready');return status();
    }finally{busy=false;onChange(status());}
  }
  function legacyReader(){const id=fs.existsSync(legacyReaderFile)?JSON.parse(S.read(legacyReaderFile,128)):active.reader;P.check(uuid(id));return id;}
  return {status,inspect,install,remove,rollback,recover,acquire,retain,collect,context,reader:()=>active.reader,legacyReader,close(){closed=true;}};
}
function parents(file){const values=[];for(let p=path.dirname(file);;p=path.dirname(p)){values.push(p);if(p===path.dirname(p))return values;}}
module.exports={openInstallations,pointer};
