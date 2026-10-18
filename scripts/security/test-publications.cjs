const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const F=require('./account-test-fixtures.cjs');
const S=require('../../desktop/publication-protocol.cjs');
const {encryptMesh}=require('../../desktop/publication-crypto.cjs');
const {verifyPending}=require('./result-verifier.cjs');
const {openSync}=require('../../desktop/sync.cjs');
const {fixture,attempt,commit,upload,source,geometry,pythonExport,meshFile}=require('./publication-test-fixtures.cjs');
const id=()=>crypto.randomUUID();
test('protected Python mask → HTTP multipart → private verification → metrics first, later mesh; no raw/PHI projection',async t=>{
  const f=await fixture(t),a=await attempt(f);
  await assert.rejects(f.rpc('begin',a.manifest),/ORIGIN_APPROVAL_REQUIRED/);
  await f.rpc('approve-origin',{originStoreId:f.source.identity.originStoreId});
  const result=await commit(f,a);assert.equal(result.state,'published');assert.equal(result.meshState,'pending');
  const read=await f.rpc('read',{resultId:result.resultId});assert.equal(read.analysis.rows[0].value,1064.96);assert.ok(!JSON.stringify(read).includes('SECRET_ID'));assert.ok(!JSON.stringify(read).includes('PRIVATE PATIENT'));assert.equal(read.analysis.mask,undefined);
  assert.equal((await f.rpc('complete',{attemptId:a.manifest.attemptId})).resultId,result.resultId);
  const second=await attempt(f);assert.notEqual(second.manifest.artifact.parts[0].sha256,a.manifest.artifact.parts[0].sha256);assert.equal(second.manifest.contentDigest,a.manifest.contentDigest);assert.equal((await f.rpc('begin',second.manifest)).resultId,result.resultId);
  const meshId=id(),dir=path.join(f.root,'mesh');fs.mkdirSync(dir);
  const artifact=await encryptMesh(meshFile(f.root),dir,f.scope,a.manifest.content.identity,meshId,f.config.meshPublicKey);
  const attachment={dir,manifest:{...a.manifest,attemptId:meshId,artifact,attachmentRevision:0}};
  const attached=await commit(f,attachment);assert.equal(attached.resultId,result.resultId);assert.equal(attached.meshState,'ready');assert.equal(attached.attachmentRevision,1);
  await assert.rejects(f.rpc('read',{resultId:result.resultId,kind:'mask'}),/PUBLICATION_INVALID/);
  await f.rpc('delete',{resultId:result.resultId,revision:1});await assert.rejects(f.rpc('begin',second.manifest),/PUBLICATION_DELETED/);await assert.rejects(f.rpc('complete',{attemptId:meshId}),/PUBLICATION_DELETED/);
  f.service.sweep();assert.equal(fs.existsSync(path.join(f.root,'objects',a.manifest.attemptId)),false);
});

test('changed content/attempt/target, membership and device revocation cannot commit or disclose another workspace',async t=>{
  const f=await fixture(t),a=await attempt(f);await f.rpc('approve-origin',{originStoreId:f.source.identity.originStoreId});await upload(f,a);
  await assert.rejects(f.rpc('begin',{...a.manifest,artifact:{...a.manifest.artifact,wrappedKey:crypto.randomBytes(384).toString('base64url')}}),/ATTEMPT_CONFLICT/);
  f.accounts.membership('manager','hospital-a','research','Research',['data-admin']);await assert.rejects(f.rpc('complete',{attemptId:a.manifest.attemptId}),/PUBLICATION_PERMISSION/);
  f.accounts.membership('manager','hospital-a','research','Research',['analyst','data-admin']);
  f.authority.db.prepare("UPDATE licenses SET status='revoked' WHERE installation=?").run(f.scope.installationId);await assert.rejects(f.rpc('complete',{attemptId:a.manifest.attemptId}),/PUBLICATION_DEVICE/);
  f.authority.db.prepare("UPDATE licenses SET status='active' WHERE installation=?").run(f.scope.installationId);
  await f.rpc('complete',{attemptId:a.manifest.attemptId});await verifyPending(f.root,f.keys);await f.rpc('complete',{attemptId:a.manifest.attemptId});
  const modified=structuredClone(a.manifest);modified.attemptId=id();modified.content.rows[0].value++;modified.contentDigest=S.digest(modified.content);await assert.rejects(f.rpc('begin',modified),/CONTENT_CONFLICT/);
  f.accounts.membership('manager','hospital-a','other','Other',['analyst']);await f.account.workspace('hospital-a','other');
  const otherScope={...f.scope,workspaceId:'other'},other={...a.manifest,attemptId:id(),scope:otherScope};
  await assert.rejects(f.account.publicationRequest('/v1/publications/begin',other,otherScope),/TARGET_MISMATCH/);
  f.accounts.membership('manager','hospital-a','other','Other',[]);await assert.rejects(f.account.publicationRequest('/v1/publications/begin',other,otherScope),/PUBLICATION_PERMISSION/);
});

test('mask corruption or different label/count never passes verifier; staging stays invisible; cancellation and expiry',async t=>{
  const f=await fixture(t),a=await attempt(f);await f.rpc('approve-origin',{originStoreId:f.source.identity.originStoreId});await upload(f,a);
  assert.equal((await f.rpc('list')).length,0);
  const partFile=path.join(f.root,'objects',a.manifest.attemptId,'0.part');const bytes=fs.readFileSync(partFile);bytes[40]^=1;fs.writeFileSync(partFile,bytes);
  await assert.rejects(f.rpc('complete',{attemptId:a.manifest.attemptId}),/INCOMPLETE/);
  await f.rpc('part',{attemptId:a.manifest.attemptId,index:0,data:fs.readFileSync(path.join(a.dir,'0.part')).toString('base64')});
  await f.rpc('complete',{attemptId:a.manifest.attemptId});fs.writeFileSync(partFile,bytes);await verifyPending(f.root,f.keys);await assert.rejects(f.rpc('complete',{attemptId:a.manifest.attemptId}));assert.equal((await f.rpc('list')).length,0);
  await f.rpc('cancel',{attemptId:a.manifest.attemptId});await assert.rejects(f.rpc('status',{attemptId:a.manifest.attemptId}),/EXPIRED/);
  const b=await attempt(f);await f.rpc('begin',b.manifest);f.service.db.prepare('UPDATE attempts SET expires=0 WHERE id=?').run(b.manifest.attemptId);await assert.rejects(f.rpc('complete',{attemptId:b.manifest.attemptId}),/EXPIRED/);
});

test('outbox restart/resume, same-subject scope, lost commit response, late 3D and cancelled jobs preserve local data',async t=>{
  const f=await fixture(t);await f.rpc('approve-origin',{originStoreId:f.source.identity.originStoreId});const safeStorage=F.safeStorage(),directory=path.join(f.root,'outbox');
  let mesh=null,offline=true,lost=false;
  const account={status:()=>f.account.status(),refresh:()=>f.account.refresh(),publicationRequest:async(route,body,scope)=>{if(offline)throw TypeError('fetch failed');const response=await f.account.publicationRequest(route,body,scope);if(route.endsWith('/complete') && response.state==='verifying'){await verifyPending(f.root,f.keys);return response;}if(route.endsWith('/complete') && response.state==='published' && !lost){lost=true;throw TypeError('lost response');}return response;}};
  const imaging={publicationSource:async()=>f.source,exportPublication:(_,opts)=>pythonExport(f.root,opts),publicationMesh:async()=>mesh};
  let sync=openSync({directory,safeStorage,account,imaging,intervalMs:1e8});
  await sync.enqueue([{id:'case-a',revision:f.source.identity.analysisRevision}]);await sync.tick();assert.equal(sync.status().jobs[0].state,'waiting_network');await sync.close();
  assert.ok(!fs.readFileSync(path.join(directory,sync.status().jobs[0].id+'.bin')).includes(Buffer.from('PRIVATE PATIENT')));
  sync=openSync({directory,safeStorage,account,imaging,intervalMs:1e8});F.cleanup(t,()=>sync.close());assert.equal(sync.status().storageError,false);
  const jobId=sync.status().jobs[0].id;offline=false;
  f.idp.settings.subject='analyst';await f.account.logout();await f.account.login();await f.account.workspace('hospital-a','research');assert.equal(sync.status().jobs.length,0);await sync.tick();assert.equal((await f.service.list({sub:'manager'},f.scope)).length,0);
  f.idp.settings.subject='manager';await f.account.logout();await f.account.login();await f.account.workspace('hospital-a','research');sync.retry(jobId);await sync.tick();await sync.tick();
  if(sync.status().jobs[0].state==='waiting_network'){sync.retry(jobId);await sync.tick();}
  await sync.tick();assert.equal(sync.status().jobs[0].state,'published');assert.equal((await f.rpc('list')).length,1);
  mesh=meshFile(f.root);await sync.tick();await sync.tick();assert.equal(sync.status().jobs[0].meshState,'ready');assert.equal((await f.rpc('list')).length,1);
});

test('public contract rejects paths, extra fields, non-finite values and invalid schema; IPC requires the actual main frame',async()=>{
  assert.throws(()=>S.canonical({bad:NaN}));assert.throws(()=>S.canonical({bad:undefined}));
  const s=source(),c=S.fromSnapshot(s.summary,s.identity,geometry,{sha256:'a'.repeat(64),bytes:64*64*130*2});
  assert.throws(()=>S.content({...c,patientId:'do-not-send'}));assert.throws(()=>S.content({...c,rows:[{...c.rows[0],path:'C:/patient'}]}));
  const handlers=new Map(),window={webContents:{mainFrame:{url:'atlas://app/'}}};const remove=require('../../desktop/sync-ui.cjs').installSyncUi({ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)},window,sync:{status:()=>({}),close:async()=>{}}});
  const handle=handlers.get('exmo:sync:status');assert.equal((await handle({sender:window.webContents,senderFrame:window.webContents.mainFrame})).ok,true);
  await assert.rejects(handle({sender:{},senderFrame:window.webContents.mainFrame}),/Untrusted/);await assert.rejects(handle({sender:window.webContents,senderFrame:{url:'atlas://app/'}}),/Untrusted/);await remove();
});

test('quota, cryptographic PC proof replay, simultaneous attempts and restored database preserve one immutable result',async t=>{
  const f=await fixture(t),a=await attempt(f);await f.rpc('approve-origin',{originStoreId:f.source.identity.originStoreId});
  const claims={...f.scope,route:'/v1/publications/list',bodyDigest:S.digest({}),nonce:crypto.randomBytes(32).toString('base64url'),at:Math.floor(Date.now()/1000)};
  const signature=await f.licensing.publicationProof(claims),proof=Buffer.from(JSON.stringify({claims,signature})).toString('base64url');
  assert.deepEqual(f.service.authenticate({sub:'manager'},claims.route,{},proof),f.scope);
  assert.throws(()=>f.service.authenticate({sub:'manager'},claims.route,{},proof),/REPLAY/);
  assert.throws(()=>f.service.authenticate({sub:'manager'},claims.route,{extra:true},proof),/PROOF/);
  const quota=f.service.config.quotaBytes;f.service.config.quotaBytes=1;await assert.rejects(f.rpc('begin',a.manifest),/QUOTA/);f.service.config.quotaBytes=quota;
  const b=await attempt(f);await upload(f,a);await upload(f,b);
  await f.rpc('complete',{attemptId:a.manifest.attemptId});await f.rpc('complete',{attemptId:b.manifest.attemptId});await verifyPending(f.root,f.keys);
  const first=await f.rpc('complete',{attemptId:a.manifest.attemptId}),second=await f.rpc('complete',{attemptId:b.manifest.attemptId});assert.equal(first.resultId,second.resultId);
  const backup=path.join(f.root,'backup');fs.mkdirSync(backup);
  f.service.db.prepare('VACUUM INTO ?').run(path.join(backup,'results.sqlite'));fs.cpSync(path.join(f.root,'objects'),path.join(backup,'objects'),{recursive:true});
  const {Results}=require('./results-server.cjs');const restored=new Results(backup,f.authority.db,f.config);try{
    assert.equal(restored.list({sub:'manager'},f.scope).length,1);assert.equal(restored.read({sub:'manager'},f.scope,first.resultId).analysis.rows[0].count,64*64*130);
    restored.delete({sub:'manager'},f.scope,first.resultId,0);restored.sweep();assert.throws(()=>restored.begin({sub:'manager'},f.scope,{...a.manifest,attemptId:id()}),/DELETED/);
    assert.equal(restored.db.prepare('SELECT content FROM publications').get().content,'{}');
  }finally{restored.close();}
});

test('authenticated bytes with false metric counts and forged verification receipts are rejected',async t=>{
  const f=await fixture(t),a=await attempt(f);await f.rpc('approve-origin',{originStoreId:f.source.identity.originStoreId});
  a.manifest.content.rows[0].count--;a.manifest.content.rows[0].value-=0.002;a.manifest.contentDigest=S.digest(a.manifest.content);
  await upload(f,a);await f.rpc('complete',{attemptId:a.manifest.attemptId});await verifyPending(f.root,f.keys);
  await assert.rejects(f.rpc('complete',{attemptId:a.manifest.attemptId}),/ARTIFACT_INVALID/);
  const message=S.canonical({attemptId:a.manifest.attemptId,manifestDigest:S.digest(a.manifest),valid:true});
  f.service.db.prepare('UPDATE attempts SET receipt=? WHERE id=?').run(JSON.stringify({message,signature:crypto.randomBytes(64).toString('base64url')}),a.manifest.attemptId);
  await assert.rejects(f.rpc('complete',{attemptId:a.manifest.attemptId}),/RECEIPT/);assert.equal((await f.rpc('list')).length,0);
});

test('restart after a partial upload resumes missing parts; cancel before publication never exposes a result',async t=>{
  const f=await fixture(t);await f.rpc('approve-origin',{originStoreId:f.source.identity.originStoreId});
  const directory=path.join(f.root,'resume-outbox'),safeStorage=F.safeStorage();let failPart=true,cutBeforeBegin=false,parts=[];
  const account={status:()=>f.account.status(),refresh:()=>f.account.refresh(),publicationRequest:async(route,body,scope)=>{
    if(cutBeforeBegin && route.endsWith('/begin'))throw TypeError('network interrupted');
    if(route.endsWith('/part')){if(failPart && body.index===1)throw TypeError('network interrupted');parts.push(body.index);}
    const value=await f.account.publicationRequest(route,body,scope);if(route.endsWith('/complete'))await verifyPending(f.root,f.keys);return value;
  }};
  const imaging={publicationSource:async()=>f.source,exportPublication:(_,options)=>pythonExport(f.root,options),publicationMesh:async()=>null};
  let sync=openSync({directory,safeStorage,account,imaging,intervalMs:1e8});await sync.enqueue([{id:'case',revision:f.source.identity.analysisRevision}]);await sync.tick();
  assert.deepEqual(parts,[0]);assert.equal(sync.status().jobs[0].state,'waiting_network');const job=sync.status().jobs[0];await sync.close();
  sync=openSync({directory,safeStorage,account,imaging,intervalMs:1e8});F.cleanup(t,()=>sync.close());failPart=false;parts=[];
  sync.retry(job.id);await sync.tick();await sync.tick();assert.deepEqual(parts,[1]);assert.equal(sync.status().jobs[0].state,'published');
  f.source={...source(),identity:{...f.source.identity,originResultId:id(),analysisRevision:id()}};parts=[];failPart=true;
  await sync.enqueue([{id:'cancelled-case',revision:f.source.identity.analysisRevision}]);await sync.tick();
  const pending=sync.status().jobs.find(j=>j.resultId==='cancelled-case');assert.equal(pending.state,'waiting_network');sync.cancel(pending.id);await sync.tick();
  assert.equal(sync.status().jobs.find(j=>j.id===pending.id).state,'cancelled');assert.equal((await f.rpc('list')).length,1);
  cutBeforeBegin=true;f.source={...source(),identity:{...f.source.identity,originResultId:id(),analysisRevision:id()}};
  await sync.enqueue([{id:'never-begun',revision:f.source.identity.analysisRevision}]);await sync.tick();
  const never=sync.status().jobs.find(j=>j.resultId==='never-begun');assert.equal(never.state,'waiting_network');sync.cancel(never.id);await sync.tick();assert.equal(sync.status().jobs.find(j=>j.id===never.id).state,'cancelled');
});
