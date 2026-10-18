const crypto=require('node:crypto');
const P=require('./security/license-protocol.cjs');
const {resolveSolution}=require('./solutions.cjs');
const CHUNK=1024*1024,MAX_BYTES=1024*1024*1024;
function check(value,code='PUBLICATION_INVALID'){if(!value)throw Object.assign(Error(code),{code});}
function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value && typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  check(value===null || typeof value==='boolean' || typeof value==='string' || typeof value==='number' && Number.isFinite(value));return JSON.stringify(value);
}
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const digest=value=>hash(canonical(value));
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
function identity(value){P.fields(value,['originStoreId','originResultId','analysisRevision']);Object.values(value).forEach(P.id);return value;}
function scope(value){P.fields(value,['orgId','workspaceId','subject','installationId']);P.id(value.orgId);P.id(value.workspaceId);P.id(value.installationId);check(typeof value.subject==='string' && value.subject.length>0 && value.subject.length<=512);return value;}
function aad(target,id,attempt,kind,index){return Buffer.from(JSON.stringify(['EXMO/PUBLICATION/v1',target.orgId,target.workspaceId,id.originStoreId,id.originResultId,id.analysisRevision,attempt,kind,index]));}
function proofMessage(claims){return Buffer.from('EXMO/PUBLICATION-PROOF/v1/'+canonical(claims));}
const numeric=(v,min=-Infinity)=>check(typeof v==='number' && Number.isFinite(v) && v>=min);
function allowed(value,keys){check(value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).every(k=>keys.includes(k)));}
function measurement(v){
  allowed(v,['count','value','fat','hu','entropy']);P.integer(v.count);numeric(v.value,0);
  for(const k of ['fat','hu','entropy'])if(v[k]!=null)numeric(v[k]);
}
function content(v){
  P.fields(v,['schema','identity','solutionId','workflowId','analysis','variant','route','unit','geometry','rows','parts','laterality','qc','mask','provenance']);
  check(v.schema==='exmo-publication-content-v1');identity(v.identity);
  const solution=resolveSolution(v.solutionId);check(solution.workflowId===v.workflowId && solution.analysis===v.analysis);
  check(['raw','pp500','strong'].includes(v.variant) && (v.analysis==='mri' || v.variant==='raw'));
  check(v.route===null || ['AP','LAT_LT','LAT_RT','LAT-LT','LAT-RT'].includes(v.route));
  check(v.analysis==='xray'?['cm²','pixel'].includes(v.unit):v.unit==='cm³');
  P.fields(v.geometry,['size','spacing','origin','direction']);
  for(const k of ['size','spacing','origin','direction'])check(Array.isArray(v.geometry[k]) && v.geometry[k].length===(k==='direction'?9:3));
  v.geometry.size.forEach(n=>{P.integer(n);check(n>0);});v.geometry.spacing.forEach(n=>numeric(n,Number.MIN_VALUE));
  v.geometry.origin.forEach(n=>numeric(n));v.geometry.direction.forEach(n=>numeric(n));
  const voxels=v.geometry.size.reduce((a,b)=>a*b,1);check(Number.isSafeInteger(voxels) && voxels*2<=MAX_BYTES);
  if(v.analysis==='xray')check(v.geometry.size[2]===1);
  check(Array.isArray(v.rows) && v.rows.length>0 && v.rows.length<=255);
  for(const r of v.rows){
    allowed(r,['label','id','name','color','group','count','value','rawValue','fat','hu','entropy','components','present','applicable','sides']);
    P.integer(r.label);check(r.label>0 && r.label<=65535);P.id(r.id);
    for(const k of ['name','group'])check(typeof r[k]==='string' && /^[A-Za-z0-9 _().-]{1,100}$/.test(r[k]));
    check(/^#[a-fA-F0-9]{6}$/.test(r.color));measurement(pick(r,['count','value','fat','hu','entropy']));
    check(typeof r.present==='boolean' && (r.applicable===undefined || typeof r.applicable==='boolean'));
    for(const k of ['rawValue','components'])if(r[k]!=null)numeric(r[k],0);
    if(r.sides){P.fields(r.sides,['left','right','unassigned','differenceCm3','differencePercent','flags']);
      for(const k of ['left','right','unassigned'])measurement(r.sides[k]);
      check(r.sides.left.count+r.sides.right.count+r.sides.unassigned.count===r.count);
      for(const k of ['differenceCm3','differencePercent'])if(r.sides[k]!=null)numeric(r.sides[k],0);flags(r.sides.flags);}
  }
  check(new Set(v.rows.map(r=>r.label)).size===v.rows.length && new Set(v.rows.map(r=>r.id)).size===v.rows.length);
  check(Array.isArray(v.parts) && v.parts.length<=1024);
  for(const p of v.parts){P.fields(p,['id','structureId','side','label']);P.id(p.id);P.id(p.structureId);P.integer(p.label);check(['left','right','unassigned'].includes(p.side) && v.rows.some(r=>r.id===p.structureId));}
  if(v.laterality){P.fields(v.laterality,['method','status','unassignedCm3']);P.id(v.laterality.method);check(['estimated','partial','unavailable'].includes(v.laterality.status));numeric(v.laterality.unassignedCm3,0);}
  allowed(v.qc,['flags','entropy','ttaDisagreement','missing','unexpected','tta','postprocessing']);flags(v.qc.flags);
  for(const k of ['entropy','ttaDisagreement'])if(v.qc[k]!=null)numeric(v.qc[k],0);
  for(const k of ['missing','unexpected']){check(Array.isArray(v.qc[k]) && v.qc[k].length<256);v.qc[k].forEach(P.integer);}
  check(['identity + L/R flip','5 folds + mirroring','None'].includes(v.qc.tta));
  if(v.qc.postprocessing){P.fields(v.qc.postprocessing,['removedCm3','removedPercent','changedVoxels']);Object.values(v.qc.postprocessing).forEach(n=>numeric(n));}
  P.fields(v.mask,['sha256','bytes']);P.digest(v.mask.sha256);check(v.mask.bytes===voxels*2);
  P.fields(v.provenance,['source','modelDigest','recipeDigest','packageSetDigest']);check(v.provenance.source==='fixed-local-result');
  for(const k of ['modelDigest','recipeDigest','packageSetDigest'])if(v.provenance[k]!==null)P.digest(v.provenance[k]);
  check(Buffer.byteLength(canonical(v))<192*1024);return v;
}
function flags(v){check(Array.isArray(v) && v.length<=100 && v.every(s=>typeof s==='string' && (/^[A-Za-z0-9 _.:()%-]{1,160}$/.test(s) || ['좌우 판정 보류 영역 포함','양측 검출 미확인'].includes(s))));}
function fromSnapshot(summary,id,geometry,mask){
  return content({schema:'exmo-publication-content-v1',identity:identity(pick(id,['originStoreId','originResultId','analysisRevision'])),
    ...pick(id,['solutionId','workflowId']),...pick(summary,['analysis','variant','unit']),route:summary.route??null,geometry,
    rows:summary.rows.map(r=>({...pick(r,['label','id','name','color','group','count','value','rawValue','fat','hu','entropy','components','present','applicable']),
      ...(r.sides?{sides:{...pick(r.sides,['differenceCm3','differencePercent','flags']),...Object.fromEntries(['left','right','unassigned'].map(k=>[k,pick(r.sides[k],['count','value','fat','hu','entropy'])]))}}:{})})),
    parts:(summary.parts??[]).map(p=>pick(p,['id','structureId','side','label'])),laterality:summary.laterality?pick(summary.laterality,['method','status','unassignedCm3']):null,
    qc:pick(summary.qc,['flags','entropy','ttaDisagreement','missing','unexpected','tta','postprocessing']),mask,
    // shortcut: Legacy snapshots omit execution digests; migrate provenance before audit-grade attribution, never substitute today's model.
    provenance:{source:'fixed-local-result',modelDigest:null,recipeDigest:null,packageSetDigest:null}});
}
function artifact(v){
  P.fields(v,['kind','sha256','bytes','wrappedKey','parts']);check(['mask','mesh'].includes(v.kind));P.digest(v.sha256);P.integer(v.bytes);check(v.bytes>0 && v.bytes<=MAX_BYTES);
  if(v.kind==='mesh')check(v.bytes<=128*1024*1024);
  check(P.decode(v.wrappedKey).length===384);check(Array.isArray(v.parts) && v.parts.length===Math.ceil(v.bytes/CHUNK));
  v.parts.forEach((p,i)=>{P.fields(p,['sha256','bytes']);P.digest(p.sha256);check(p.bytes===Math.min(CHUNK,v.bytes-i*CHUNK)+28);});return v;
}
function manifest(v){
  P.fields(v,['schema','attemptId','scope','content','contentDigest','artifact','attachmentRevision']);check(v.schema==='exmo-upload-v1');P.id(v.attemptId);scope(v.scope);content(v.content);check(digest(v.content)===v.contentDigest);
  artifact(v.artifact);P.integer(v.attachmentRevision);
  if(v.artifact.kind==='mask')check(v.artifact.sha256===v.content.mask.sha256 && v.artifact.bytes===v.content.mask.bytes && v.attachmentRevision===0);
  return v;
}
module.exports={CHUNK,MAX_BYTES,check,canonical,hash,digest,pick,identity,scope,aad,proofMessage,content,fromSnapshot,artifact,manifest};
