const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const F=require('./publication-test-fixtures.cjs'),A=require('./account-test-fixtures.cjs');
const S=require('../../desktop/publication-protocol.cjs');
const {encryptMesh}=require('../../desktop/publication-crypto.cjs');
const {openRemote,installRemoteUi}=require('../../desktop/remote-results.cjs');
const {openContexts}=require('../../desktop/publication-context.cjs');
async function publish(f){
  await f.rpc('approve-origin',{originStoreId:f.source.identity.originStoreId});const a=await F.attempt(f),saved=await F.commit(f,a);
  const context=openContexts(f.root,A.safeStorage())(f.source);await f.rpc('context',{resultId:saved.resultId,context});
  return {a,saved,context};
}
async function attach(f,a,saved){
  const attemptId=crypto.randomUUID(),dir=path.join(f.root,attemptId);fs.mkdirSync(dir);
  const artifact=await encryptMesh(F.meshFile(f.root),dir,f.scope,a.manifest.content.identity,attemptId,f.config.meshPublicKey);
  return F.commit(f,{dir,manifest:{...a.manifest,attemptId,artifact,attachmentRevision:saved.attachmentRevision}});
}
test('published context, bounded read-only geometry, projection and revocation use real OIDC/PC authorization',async t=>{
  const f=await F.fixture(t),{a,saved,context}=await publish(f);await attach(f,a,saved);
  assert.equal(f.service.db.prepare('PRAGMA table_info(publications)').all().length,11,'P5 INSERT compatibility');
  const remote=openRemote({account:f.account});t.after(()=>remote.close());
  const rows=await remote.list();assert.deepEqual(rows[0].context,context);
  const [detail]=await remote.read([saved.resultId]);assert.ok(detail.meshUrl);assert.equal(detail.content.rows[0].value,a.manifest.content.rows[0].value);
  assert.equal((await remote.read([saved.resultId]))[0].meshUrl,detail.meshUrl,'refresh preserves an unchanged mesh URL');
  assert.ok(!/wrappedKey|SECRET_ID|PRIVATE PATIENT|originStoreId|"mask"/.test(JSON.stringify(detail)));
  const key=detail.meshUrl.split('/').at(-1).slice(0,-4),response=await remote.model(key);
  assert.equal(response.headers.get('cache-control'),'no-store');const bytes=Buffer.from(await response.arrayBuffer());assert.equal(S.hash(bytes),S.hash(fs.readFileSync(F.meshFile(f.root))));
  assert.equal(fs.existsSync(path.join(f.root,'objects',a.manifest.attemptId,'display.glb')),false);
  await assert.rejects(f.rpc('context',{resultId:saved.resultId,context:{...context,studyId:crypto.randomUUID()}}),/CONFLICT/);
  await assert.rejects(f.rpc('mesh-part',{resultId:saved.resultId,revision:1,sha256:'a'.repeat(64),index:0}),/PART/);
  f.accounts.membership('manager','hospital-a','research','Research',['reviewer']);await remote.list();await remote.read([saved.resultId]);
  await assert.rejects(f.rpc('context',{resultId:saved.resultId,context}),/PERMISSION/);
  f.accounts.membership('manager','hospital-a','research','Research',['device-admin']);await assert.rejects(remote.list(),/PERMISSION/);
  await f.account.logout();await assert.rejects(remote.model(key));
});
test('context persists privately and never groups unknown patients or coincidental dates',async t=>{
  const root=A.temporary(t),safe=A.safeStorage(),context=openContexts(root,safe),s=F.source();
  s.summary.inputId='input-a';s.summary.metadata={patientId:'SECRET_PATIENT',patientIssuer:'HOSPITAL',studyUid:'1.2.3',studyDate:'20261018'};
  const first=context(s);assert.deepEqual(openContexts(root,safe)(s),first);
  const second=structuredClone(s);second.summary.inputId='input-b';second.summary.route='AP';second.identity.originResultId=crypto.randomUUID();
  assert.equal(context(second).studyId,first.studyId);assert.notEqual(context(second).acquisitionId,first.acquisitionId);
  second.summary.metadata.studyUid='1.2.4';assert.notEqual(context(second).studyId,first.studyId);
  second.summary.metadata={};assert.notEqual(context(second).caseId,first.caseId);
  assert.ok(!fs.readFileSync(path.join(root,'study-links.bin')).includes(Buffer.from('SECRET_PATIENT')));
});
test('selection compares quantities, ontology, method and proven acquisition coverage; legacy is reference-only',async()=>{
  const {comparisonIssue}=await import('../../desktop/ui/remote-contract.ts');
  const s=F.source(),v=S.fromSnapshot(s.summary,s.identity,F.geometry,{sha256:'a'.repeat(64),bytes:64*64*130*2});
  const row={analysis:'mri',unit:'cm³',route:null,context:{acquisitionId:'same'},content:v};
  assert.equal(comparisonIssue([row,{...row,variant:'pp500'}]),null);
  assert.equal(comparisonIssue([row,{...row,unit:'cm²'}]),'quantity');
  assert.equal(comparisonIssue([row,{...row,content:{...v,rows:[]}}]),'ontology');
  assert.equal(comparisonIssue([row,{...row,route:'AP'}]),'method');
  assert.equal(comparisonIssue([row,{...row,context:null}]),'coverage');
  assert.equal(comparisonIssue([row,{...row,content:{...v,geometry:{...v.geometry,size:[1,1,1]}}}]),'coverage');
  assert.equal(comparisonIssue([row,row,row,row]),'count');
});
test('home actions distinguish installation, entitlement and device failure without depending on translated text',async()=>{
  const {solutionAction}=await import('../../desktop/ui/solution-readiness.ts');
  const state={installation:'installed'},license={profile:'internal',state:'VALID',solutions:[{solutionId:'ct',state:'active'},{solutionId:'mri',state:'expired'}]};
  assert.equal(solutionAction('ct',license,state),'open');
  assert.equal(solutionAction('mri',license,state),'license');
  assert.equal(solutionAction('xray',license,state),'license');
  assert.equal(solutionAction('ct',license,{installation:'missing'}),'install');
  assert.equal(solutionAction('ct',{...license,state:'REVOKED'},state),'license');
  assert.equal(solutionAction('ct',{...license,state:'GRACE'},state),'open');
  assert.equal(solutionAction('ct',license,undefined),'checking');
});
test('X-ray study grouping preserves LT/AP/RT, missing and ambiguous views without crossing cases',async()=>{
  const {remoteGroups,remoteStudy}=await import('../../desktop/ui/remote-selection.ts');
  const row=(id,route,caseId='a',studyId='s')=>({resultId:id,analysis:'xray',route,context:{caseId,studyId}});
  const rows=[row('r','LAT-RT'),row('ap','AP'),row('l','LAT_LT')];
  assert.deepEqual(remoteGroups(rows)[0].items.map(r=>r.resultId),['l','ap','r']);
  assert.deepEqual(remoteStudy(rows),{ids:['l','ap','r'],missing:[],ambiguous:false});
  assert.deepEqual(remoteStudy([rows[1]]),{ids:['ap'],missing:['LAT_LT','LAT_RT'],ambiguous:false});
  assert.deepEqual(remoteStudy(rows.slice(1)).missing,['LAT_RT']);
  assert.equal(remoteStudy([...rows,row('ap2','AP')]).ambiguous,true);
  assert.deepEqual(remoteStudy([...rows,row('unknown',null)]).ids,[]);
  assert.equal(remoteGroups([...rows,row('other','AP','b'),row('study2','AP','a','s2'),{...row('unlinked','AP'),context:null}]).length,4);
});
test('stream validates hash and stops an in-flight part after account changes; no persistent mesh cache',async()=>{
  const source=F.source(),content=S.fromSnapshot(source.summary,source.identity,F.geometry,{sha256:'a'.repeat(64),bytes:64*64*130*2});delete content.mask;delete content.identity;
  const id=crypto.randomUUID(),bytes=Buffer.alloc(S.CHUNK+64,7),state={state:'signed-in',me:{subject:'a',memberships:[{orgId:'org',workspaceId:'workspace',roles:['reviewer']}]},workspace:{orgId:'org',workspaceId:'workspace'},deviceOrgId:'org',installationId:'pc'};
  let release,second,corrupt=false;
  const account={status:()=>state,refresh:async()=>{},publicationRequest:async(route,body)=>{
    if(route.endsWith('/read'))return {state:'published',resultId:id,solutionId:content.solutionId,variant:'raw',analysis:content,route:null,unit:'cm³',attachmentRevision:1,meshState:'ready',context:null,mesh:{sha256:S.hash(bytes),bytes:bytes.length}};
    if(body.index===1){second?.();await new Promise(r=>{release=r;});}
    return {data:(corrupt?Buffer.alloc(Math.min(S.CHUNK,bytes.length-body.index*S.CHUNK),8):bytes.subarray(body.index*S.CHUNK,(body.index+1)*S.CHUNK)).toString('base64')};
  }};
  const remote=openRemote({account});
  try{
    let [detail]=await remote.read([id]),response=await remote.model(detail.meshUrl.split('/').at(-1).slice(0,-4));
    const waiting=new Promise(r=>{second=r;});const result=response.arrayBuffer();await waiting;state.me.subject='b';release();await assert.rejects(result,/Remote 3D/);
    state.me.subject='a';[detail]=await remote.read([id]);corrupt=true;const next=await remote.model(detail.meshUrl.split('/').at(-1).slice(0,-4));const pending=next.arrayBuffer();
    await new Promise(r=>{second=r;});release();await assert.rejects(pending,/Remote 3D/);
  }finally{remote.close();}
});
test('remote IPC rejects foreign/subframes and arbitrary IDs; closed view cannot fetch its previous handle',async t=>{
  const f=await F.fixture(t),{a,saved}=await publish(f);await attach(f,a,saved);const remote=openRemote({account:f.account});
  const handlers=new Map(),window={webContents:{mainFrame:{url:'atlas://app/'}}};
  const remove=installRemoteUi({ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)},window,remote});t.after(remove);
  const event={sender:window.webContents,senderFrame:window.webContents.mainFrame},read=handlers.get('exmo:remote:read');
  await assert.rejects(read({...event,sender:{}}),/Untrusted/);await assert.rejects(read({...event,senderFrame:{url:'atlas://app/'}}),/Untrusted/);
  assert.equal((await read(event,['../../private'])).ok,false);
  const detail=(await read(event,[saved.resultId])).value[0];await handlers.get('exmo:remote:close')(event);
  await assert.rejects(remote.model(detail.meshUrl.split('/').at(-1).slice(0,-4)),/NOT_FOUND/);
});
