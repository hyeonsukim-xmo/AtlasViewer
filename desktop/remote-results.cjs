const crypto=require('node:crypto');
const S=require('./publication-protocol.cjs'),P=require('./security/license-protocol.cjs');
function openRemote({account}){
  const models=new Map();let epoch=0,stamp='',readGeneration=0;
  function scope(){
    const s=account.status();S.check(s.state==='signed-in' && s.me && s.workspace,'PUBLICATION_SIGN_IN');
    const member=s.me.memberships.find(m=>m.orgId===s.workspace.orgId && m.workspaceId===s.workspace.workspaceId);
    S.check(member?.roles.some(r=>['analyst','reviewer','data-admin'].includes(r)),'PUBLICATION_PERMISSION');
    S.check(s.deviceOrgId===s.workspace.orgId && s.installationId,'PUBLICATION_DEVICE');
    return S.scope({...s.workspace,subject:s.me.subject,installationId:s.installationId});
  }
  function invalidate(){models.clear();epoch++;readGeneration++;}
  function changed(){const next=S.canonical(account.status());if(next!==stamp){stamp=next;invalidate();}}
  const timer=setInterval(changed,500);timer.unref?.();
  async function rpc(route,body,binding){
    S.check(S.canonical(scope())===S.canonical(binding),'PUBLICATION_SIGN_IN');
    const value=await account.publicationRequest('/v1/publications/'+route,body,binding);
    S.check(S.canonical(scope())===S.canonical(binding),'PUBLICATION_SIGN_IN');return value;
  }
  function overview(v){
    P.id(v.resultId);S.check(v.state==='published' && ['ready','empty','pending'].includes(v.meshState));P.integer(v.attachmentRevision);
    const solution=require('./solutions.cjs').resolveSolution(v.solutionId);S.check(solution.analysis===v.analysis && ['raw','pp500','strong'].includes(v.variant));
    S.check(['cm³','cm²','pixel'].includes(v.unit));S.check(v.route===null||['AP','LAT_LT','LAT_RT','LAT-LT','LAT-RT'].includes(v.route));
    if(v.context!==null)S.context(v.context);
    S.check(v.overlayState===undefined||['ready','empty'].includes(v.overlayState));
    return {...S.pick(v,['resultId','attachmentRevision','meshState','solutionId','variant','analysis','route','unit','context']),overlayState:v.overlayState??'empty'};
  }
  return {
    invalidate,
    async list(){await account.refresh();changed();const binding=scope(),value=await rpc('list',{},binding);S.check(Array.isArray(value)&&value.length<=200);return value.map(overview);},
    async read(ids,loadMesh=true){
      S.check(typeof loadMesh==='boolean');
      S.check(Array.isArray(ids)&&ids.length>0&&ids.length<=3 && new Set(ids).size===ids.length);ids.forEach(P.id);
      changed();const request=loadMesh?++readGeneration:readGeneration;
      await account.refresh();changed();if(loadMesh)S.check(request===readGeneration,'PUBLICATION_REQUEST_SUPERSEDED');
      const binding=scope(),before=epoch,out=[],pendingModels=new Map();
      for(const resultId of ids){
        const v=await rpc('read',{resultId},binding);S.check(v.resultId===resultId);const analysis=S.content(v.analysis,true);
        const header=overview({...v,analysis:analysis.analysis});S.check(header.solutionId===analysis.solutionId && header.variant===analysis.variant && header.route===analysis.route && header.unit===analysis.unit);
        let meshUrl=null,overlayUrl=null;
        if(v.mesh!==null){P.fields(v.mesh,['sha256','bytes']);P.digest(v.mesh.sha256);P.integer(v.mesh.bytes);S.check(v.mesh.bytes>0 && v.mesh.bytes<=128*1024*1024 && header.meshState==='ready');
          if(loadMesh){const existing=[...models].find(([,m])=>m.kind==='mesh'&&m.resultId===resultId && m.revision===v.attachmentRevision && m.sha256===v.mesh.sha256 && S.canonical(m.binding)===S.canonical(binding));
            const key=existing?.[0]??crypto.randomUUID();pendingModels.set(key,existing?.[1]??{kind:'mesh',binding,resultId,revision:v.attachmentRevision,...v.mesh});meshUrl='/remote/'+key+'.glb';}}
        if(v.overlay!=null){
          P.fields(v.overlay,['sha256','bytes','width','height','capture','privacyReview']);P.digest(v.overlay.sha256);P.integer(v.overlay.bytes);S.check(v.overlay.bytes>0&&v.overlay.bytes<=16*1024*1024&&header.overlayState==='ready');
          S.overlay(S.pick(v.overlay,['width','height','capture','privacyReview']));S.check(v.overlay.sha256===v.overlay.privacyReview.sha256);
          if(loadMesh){const existing=[...models].find(([,m])=>m.kind==='overlay'&&m.resultId===resultId&&m.revision===v.attachmentRevision&&m.sha256===v.overlay.sha256&&S.canonical(m.binding)===S.canonical(binding));
            const key=existing?.[0]??crypto.randomUUID();pendingModels.set(key,existing?.[1]??{kind:'overlay',binding,resultId,revision:v.attachmentRevision,...S.pick(v.overlay,['sha256','bytes'])});overlayUrl='/remote/'+key+'.png';}
        }
        S.check(before===epoch,'PUBLICATION_SIGN_IN');out.push({...header,content:analysis,meshBytes:v.mesh?.bytes??null,meshUrl,overlay:v.overlay?{...S.pick(v.overlay,['width','height','capture','privacyReview']),url:overlayUrl}:null});
      }
      // Only current viewer handles survive; no patient data or GLB is stored in a browser cache.
      if(loadMesh){S.check(request===readGeneration,'PUBLICATION_REQUEST_SUPERSEDED');models.clear();for(const [key,value]of pendingModels)models.set(key,value);}
      return out;
    },
    async model(key,kind='mesh'){
      P.id(key);const model=models.get(key);S.check(model&&model.kind===kind,'PUBLICATION_NOT_FOUND');const before=epoch;
      S.check(S.canonical(scope())===S.canonical(model.binding),'PUBLICATION_SIGN_IN');
      let index=0,cancelled=false;const hash=crypto.createHash('sha256');
      const stream=new ReadableStream({async pull(controller){
        try{
          S.check(!cancelled && before===epoch && models.get(key)===model,'PUBLICATION_SIGN_IN');
          const part=await rpc(kind+'-part',{resultId:model.resultId,revision:model.revision,sha256:model.sha256,index},model.binding);
          S.check(!cancelled && before===epoch && models.get(key)===model,'PUBLICATION_SIGN_IN');
          P.fields(part,['data']);S.check(typeof part.data==='string' && part.data.length<=Math.ceil(S.CHUNK/3)*4);
          const bytes=Buffer.from(part.data,'base64');S.check(bytes.toString('base64')===part.data && bytes.length===Math.min(S.CHUNK,model.bytes-index*S.CHUNK),'PUBLICATION_ARTIFACT_INVALID');
          hash.update(bytes);index++;if(index===Math.ceil(model.bytes/S.CHUNK))S.check(hash.digest('hex')===model.sha256,'PUBLICATION_ARTIFACT_INVALID');
          controller.enqueue(bytes);if(index===Math.ceil(model.bytes/S.CHUNK))controller.close();
        }catch{if(!cancelled)controller.error(Error('Remote 3D request failed'));}
      },cancel(){cancelled=true;}});
      return new Response(stream,{headers:{'Content-Type':kind==='mesh'?'model/gltf-binary':'image/png','Content-Length':String(model.bytes),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    },
    close(){clearInterval(timer);invalidate();},
  };
}
function installRemoteUi({ipcMain,window,remote}){
  const channels=[];
  for(const [name,action] of Object.entries({list:()=>remote.list(),read:(ids,loadMesh)=>remote.read(ids,loadMesh),close:()=>remote.invalidate()})){
    const channel='exmo:remote:'+name;channels.push(channel);ipcMain.handle(channel,async(event,...args)=>{
      const frame=event.senderFrame,url=frame?new URL(frame.url):null;
      if(event.sender!==window.webContents || frame!==window.webContents.mainFrame || url?.protocol!=='atlas:' || url.host!=='app' || !['/','/index.html'].includes(url.pathname))throw Error('Untrusted remote result caller');
      try{return {ok:true,value:await action(...args)};}catch(e){return {ok:false,error:e.accountStatus===401?'PUBLICATION_SIGN_IN':e.accountStatus===403?'PUBLICATION_PERMISSION':/^PUBLICATION_[A-Z_]+$/.test(e.code??e.message)?e.code??e.message:'PUBLICATION_NETWORK'};}
    });
  }
  return ()=>{channels.forEach(c=>ipcMain.removeHandler(c));remote.close();};
}
module.exports={openRemote,installRemoteUi};
