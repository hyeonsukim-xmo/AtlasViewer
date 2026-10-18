const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const S=require('./publication-protocol.cjs');
const {protectedStore}=require('./security/storage.cjs');
const {encryptMesh,publicKey}=require('./publication-crypto.cjs');
function openSync({directory,safeStorage,account,imaging,intervalMs=3000}){
  const context=require('./publication-context.cjs').openContexts(directory,safeStorage);
  const jobs=new Map();let active=null,closed=false,storageError=false;
  const file=id=>path.join(directory,id+'.bin'),store=id=>protectedStore(file(id),safeStorage,2*1024*1024);
  const save=job=>store(job.id).write(job);
  try{
    fs.mkdirSync(directory,{recursive:true});
    for(const entry of fs.readdirSync(directory))if(/^[0-9a-f-]{36}\.bin$/.test(entry)){
      try{const job=store(entry.slice(0,-4)).read();S.check(job?.id===entry.slice(0,-4) && job.schema===1);S.scope(job.scope);S.identity(S.pick(job.source.identity,['originStoreId','originResultId','analysisRevision']));jobs.set(job.id,job);}
      catch{storageError=true;}
    }
  }catch{storageError=true;}
  function scope(){
    const s=account.status();S.check(s.state==='signed-in' && s.me && s.workspace,'PUBLICATION_SIGN_IN');
    S.check(s.deviceOrgId===s.workspace.orgId && s.installationId,'PUBLICATION_DEVICE');
    return S.scope({...s.workspace,subject:s.me.subject,installationId:s.installationId});
  }
  const eligible=job=>{try{return S.canonical(scope())===S.canonical(job.scope);}catch{return false;}};
  const rpc=(job,name,body)=>{S.check(!closed && eligible(job),'PUBLICATION_SIGN_IN');return account.publicationRequest('/v1/publications/'+name,body,job.scope);};
  function state(job,value,code=null){job.state=value;job.error=code;save(job);}
  function status(){
    const current=account.status();return {configured:current.state!=='unconfigured',storageError,
      jobs:[...jobs.values()].filter(j=>j.scope.subject===current.me?.subject).map(j=>({id:j.id,resultId:j.localResultId,revision:j.source.identity.analysisRevision,
        name:j.name,state:j.state,error:j.error,orgId:j.scope.orgId,workspaceId:j.scope.workspaceId,uploaded:j.uploaded??0,total:j.manifest?.artifact.parts.length??0,
        cloudResultId:j.published?.resultId??null,meshState:j.published?.meshState??null,kind:j.manifest?.artifact.kind??'mask'}))};
  }
  async function enqueue(refs){
    S.check(!storageError,'PUBLICATION_STORAGE');S.check(Array.isArray(refs) && refs.length>0 && refs.length<=3);
    await account.refresh();const binding=scope();
    for(const ref of refs){Pfields(ref);const source=await imaging.publicationSource(ref.id,ref.revision);
      source.identity=S.pick(source.identity,['originStoreId','originResultId','analysisRevision','solutionId','workflowId']);
      S.check(S.canonical(scope())===S.canonical(binding),'PUBLICATION_SIGN_IN');
      const existing=[...jobs.values()].find(j=>j.source.identity.analysisRevision===source.identity.analysisRevision && j.source.identity.originStoreId===source.identity.originStoreId && j.scope.subject===binding.subject && j.scope.orgId===binding.orgId && j.scope.workspaceId===binding.workspaceId && j.state!=='cancelled');
      if(existing)continue;
      const job={schema:1,id:crypto.randomUUID(),localResultId:ref.id,name:source.summary.metadata?.caseName||source.summary.name,
        source,scope:binding,state:'queued',error:null,manifest:null,attemptId:null,retries:0,next:0};save(job);jobs.set(job.id,job);
    }
    void tick();return status();
  }
  function Pfields(ref){require('./security/license-protocol.cjs').fields(ref,['id','revision']);require('./security/license-protocol.cjs').id(ref.id);require('./security/license-protocol.cjs').id(ref.revision);}
  function discardParts(job){
    if(!job.attemptId)return;
    require('./security/license-protocol.cjs').id(job.attemptId);const dir=path.resolve(directory,job.attemptId);
    S.check(path.dirname(dir)===path.resolve(directory));fs.rmSync(dir,{recursive:true,force:true});
  }
  async function prepare(job,kind){
    state(job,'preparing');const keys=await rpc(job,'info',{});publicKey(keys.maskPublicKey);publicKey(keys.meshPublicKey);
    if(job.attemptId)discardParts(job);
    job.attemptId=crypto.randomUUID();job.manifest=null;save(job);
    const dest=path.join(directory,job.attemptId);fs.mkdirSync(dest);
    let artifact,content;
    if(kind==='mask'){
      const exported=await imaging.exportPublication(job.source,{destination:dest,publicKey:keys.maskPublicKey,scope:job.scope,
        identity:S.pick(job.source.identity,['originStoreId','originResultId','analysisRevision']),attemptId:job.attemptId});
      artifact=exported.artifact;content=S.fromSnapshot(job.source.summary,job.source.identity,exported.geometry,{sha256:artifact.sha256,bytes:artifact.bytes});
      if(job.content)S.check(S.digest(job.content)===S.digest(content),'PUBLICATION_CONTENT_CONFLICT');
      job.content=content;
    }else{
      const mesh=await imaging.publicationMesh(job.source);S.check(mesh,'PUBLICATION_MESH_PENDING');
      artifact=await encryptMesh(mesh,dest,job.scope,job.content.identity,job.attemptId,keys.meshPublicKey);content=job.content;
    }
    job.manifest=S.manifest({schema:'exmo-upload-v1',attemptId:job.attemptId,scope:job.scope,content,contentDigest:S.digest(content),artifact,attachmentRevision:kind==='mask'?0:job.published.attachmentRevision});
    state(job,'queued');
  }
  async function transfer(job){
    if(job.cancelRequested){
      if(job.manifest){
        try{const response=await rpc(job,'cancel',{attemptId:job.attemptId});if(response.state==='published'){job.published=response;job.cancelRequested=false;state(job,'published');return;}}
        catch(e){if(e.accountStatus!==404)throw e;}
      }
      discardParts(job);state(job,'cancelled');return;
    }
    if(job.published && !job.contextLinked){
      job.context??=(await rpc(job,'read',{resultId:job.published.resultId})).context??context(job.source);save(job);
      await rpc(job,'context',{resultId:job.published.resultId,context:job.context});job.contextLinked=true;save(job);
    }
    if(job.published && job.published.meshState!=='pending'){discardParts(job);job.manifest=null;job.attemptId=null;state(job,'published');return;}
    if(job.published && !job.manifest){
      if(!await imaging.publicationMesh(job.source)){state(job,'published');return;}
      await prepare(job,'mesh');
    }else if(!job.manifest)await prepare(job,'mask');
    let response=await rpc(job,'begin',job.manifest);
    if(response.state!=='published'){
      state(job,'uploading');
      for(let i=0;i<job.manifest.artifact.parts.length;i++){
        if(job.cancelRequested)return;
        S.check(eligible(job),'PUBLICATION_SIGN_IN');
        if(!response.uploaded[i]){
          const part=path.join(directory,job.attemptId,i+'.part');
          if(!fs.existsSync(part))throw Object.assign(Error('PUBLICATION_LOCAL_PART_MISSING'),{code:'PUBLICATION_LOCAL_PART_MISSING'});
          const data=await fs.promises.readFile(part);S.check(S.hash(data)===job.manifest.artifact.parts[i].sha256,'PUBLICATION_LOCAL_PART_MISSING');
          await rpc(job,'part',{attemptId:job.attemptId,index:i,data:data.toString('base64')});
        }
        job.uploaded=i+1;save(job);
      }
      if(job.cancelRequested)return;
      state(job,'verifying');response=await rpc(job,'complete',{attemptId:job.attemptId});
    }
    if(response.state==='published'){
      job.published=response;job.retries=0;job.next=0;job.uploaded=0;state(job,'published');discardParts(job);job.manifest=null;job.attemptId=null;save(job);
    }
  }
  async function tick(){
    if(active || closed || storageError)return active;
    active=(async()=>{
      for(const job of jobs.values()){
        if(closed)break;
        if(['failed','cancelled','needs_permission','quota_blocked'].includes(job.state) || job.next>Date.now())continue;
        if(job.published?.meshState!=='pending' && job.state==='published' && job.contextLinked)continue;
        if(!eligible(job)){if(job.state!=='needs_login')state(job,'needs_login','PUBLICATION_SIGN_IN');continue;}
        try{await transfer(job);}
        catch(e){
          if(closed)break;
          const code=e.code??e.message;
          if(code==='PUBLICATION_LOCAL_PART_MISSING' || code==='PUBLICATION_ATTEMPT_EXPIRED'){
            discardParts(job);job.manifest=null;job.attemptId=null;state(job,'queued',code);
          }else if(e.accountStatus===401 || ['PUBLICATION_SIGN_IN','Publication account changed','Publication workspace changed','Account operation cancelled','Sign in required'].includes(code))state(job,'needs_login','PUBLICATION_SIGN_IN');
          else if(e.accountStatus===403)state(job,'needs_permission',code);
          else if(e.accountStatus===413)state(job,'quota_blocked',code);
          else if(e.accountStatus && e.accountStatus<500 && e.accountStatus!==429 || code?.startsWith('PUBLICATION_'))state(job,'failed',code);
          else if(e.accountStatus>=500 || e.accountStatus===429 || ['TypeError','TimeoutError','AbortError'].includes(e.name)){
            job.retries++;job.next=Date.now()+Math.min(300000,1000*2**Math.min(job.retries,8))*(0.8+Math.random()*0.4);state(job,job.retries>=8?'failed':'waiting_network','PUBLICATION_NETWORK');
          }else state(job,'failed','PUBLICATION_LOCAL_RESULT');
        }
      }
    })().catch(()=>{storageError=true;}).finally(()=>{active=null;});return active;
  }
  const timer=setInterval(()=>{void tick();},intervalMs);timer.unref?.();
  return {status,enqueue,tick,
    async approveOrigin(ref){Pfields(ref);await account.refresh();const target=scope(),source=await imaging.publicationSource(ref.id,ref.revision);return account.publicationRequest('/v1/publications/approve-origin',{originStoreId:source.identity.originStoreId},target);},
    retry(id){const job=jobs.get(id);S.check(job && eligible(job),'PUBLICATION_SIGN_IN');S.check(!['cancelled'].includes(job.state));job.next=0;job.retries=0;state(job,'queued');void tick();return status();},
    cancel(id){const job=jobs.get(id);S.check(job && eligible(job),'PUBLICATION_SIGN_IN');job.cancelRequested=true;job.next=0;state(job,'queued');void tick();return status();},
    async close(){closed=true;clearInterval(timer);await active;},
  };
}
module.exports={openSync};
