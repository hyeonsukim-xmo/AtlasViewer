const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const P=require('../../desktop/security/license-protocol.cjs'),V3=require('../../desktop/security/license-v3.cjs');
const M=require('../../desktop/security/model-package.cjs'),E=require('../../desktop/security/execution.cjs');
const {Authority,createServer,main}=require('./license-server.cjs');
const {LicenseClient,localTransport}=require('../../desktop/security/license-client.cjs');
const {openLicensing}=require('../../desktop/security/runtime.cjs');
const {AnalysisWorker}=require('../../desktop/analysis-worker.cjs');
const {packModels,ASSETS}=require('./pack-models.cjs'),{grant}=require('./model-package.cjs');
const repo=path.resolve(__dirname,'../..'),python=path.join(repo,'work/modality-integration/envs/ct/Scripts/python.exe');
const hash=n=>String(n).repeat(64),nonce=()=>crypto.randomBytes(32).toString('base64url');
const binding={profile:'internal',licenseId:'test-license',installationId:'test-install',installationKey:hash(1)};
const execution=(analysis='ct')=>({...E.scope({analysis}),capability:'analyze',engine:analysis,modelDigest:hash(analysis==='mri'?5:2),recipeDigest:hash(3),packageSetDigest:hash(4)});
const entitlement=(x,overrides={})=>({entitlementId:'ent-'+x.engine,solutionId:x.solutionId,validFrom:0,validUntil:null,state:'active',revision:1,capabilities:[x.capability],executions:[x],...overrides});
function lease(entries=[entitlement(execution())]){return {iss:V3.ISSUER,aud:V3.AUDIENCE,kind:'lease',schema:'exmo-device-lease-v3',orgId:'org-test',binding:structuredClone(binding),nonce:nonce(),iat:100,exp:700,renewAfter:200,revision:1,sequence:1,decision:'allow',entitlements:entries};}

test('strict v3 policy has identical JS/Python decisions for exact solution, capability, model, recipe, runtime and partial expiry',()=>{
  const cases=[],add=(mutate,expected=false)=>{const c={lease:lease(),execution:execution(),now:150};mutate?.(c);cases.push({...c,expected});};
  add(null,true);
  for(const key of ['solutionId','workflowId','engine','modelDigest','recipeDigest','packageSetDigest','capability'])add(c=>c.execution[key]=key.endsWith('Digest')?hash(9):key==='engine'?'mri':key==='capability'?'result-mutation':'other');
  for(const state of ['revoked','suspended'])add(c=>c.lease.entitlements[0].state=state);
  add(c=>c.lease.entitlements[0].validFrom=151);add(c=>c.lease.entitlements[0].validUntil=150);
  add(c=>c.now=700);add(c=>c.now=99);add(c=>c.lease.entitlements=[]);
  add(c=>c.lease.entitlements.push(entitlement(execution('mri'),{validUntil:149})),true);
  add(c=>{c.lease.entitlements.push(entitlement(execution('mri'),{validUntil:149}));c.execution=execution('mri');});
  add(c=>c.lease.entitlements.push(c.lease.entitlements[0]));add(c=>c.lease.extra=true);
  add(c=>c.lease.entitlements[0].executions.push(c.execution));add(c=>c.lease.entitlements[0].revision=0);
  add(c=>{c.execution={...execution('mri'),capability:'result-mutation',modelDigest:null};c.lease.entitlements=[entitlement(c.execution)];},true);
  add(c=>{c.lease.entitlements[0].executions[0].solutionId='exmo.thigh.other';});
  for(const engine of ['ap','lat_lt','lat_rt','xray-classifier']){
    const x={...execution(),...E.scope({analysis:'xray'}),engine,capability:engine==='xray-classifier'?'classify':'analyze'};
    add(c=>{c.execution=x;c.lease.entitlements=[entitlement(x)];},true);
    add(c=>{c.execution=x;});
  }
  add(c=>c.lease.entitlements=Array.from({length:65},(_,i)=>entitlement({...execution(),solutionId:'product-'+i},{entitlementId:'ent-'+i})));
  add(c=>c.lease.binding.installationId=12);
  const js=cases.map(c=>{try{V3.validate(c.lease,'lease',binding);V3.allowed(c.lease,c.execution,c.now);return true;}catch{return false;}});
  assert.deepEqual(js,cases.map(c=>c.expected));
  const py=JSON.parse(execFileSync(python,['-B',path.join(__dirname,'check-solution-policy.py')],{input:JSON.stringify(cases),encoding:'utf8',windowsHide:true}));
  assert.deepEqual(py,js);
  const pair=crypto.generateKeyPairSync('ed25519'),token=V3.signToken(lease(),pair.privateKey);
  assert.equal(V3.verifyToken(token,pair.publicKey,'lease',binding).orgId,'org-test');
  assert.throws(()=>P.verifyToken(token,pair.publicKey,'lease',binding));
  assert.throws(()=>V3.verifyToken(token,pair.publicKey,'lease',{...binding,installationId:'another'}));
  assert.throws(()=>V3.verifyToken(token+'a',pair.publicKey,'lease',binding));
});

test('authority migration drains v2, partial revocation is atomic, offline v3 and restart preserve restrictions',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'exmo-v3-'));main(['init',root+'/authority','internal']);
  let now=1000,wall=1000;const a=new Authority(root+'/authority',()=>now),signer=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const config={binding:{...binding,installationKey:P.fingerprint(signer.publicKey)},installationPublicKey:signer.publicKey.export({type:'spki',format:'pem'}),engines:['ct','mri'],contractEnd:10000,graceSeconds:600,renewSeconds:60};
  a.approve(config);for(const n of [2,5])a.db.prepare("INSERT INTO models VALUES (?,'active')").run(hash(n));
  for(const engine of ['ct','mri'])a.db.prepare('INSERT INTO model_grants VALUES (?,?,?)').run(binding.licenseId,engine,execution(engine).modelDigest);
  const configClient={binding:config.binding,installationPublicKey:config.installationPublicKey,issuerPublicKey:a.publicKey.export({type:'spki',format:'pem'})};
  let saved=null,offline=false;const options={profile:'internal',config:configClient,store:{read:()=>saved,write:v=>saved=structuredClone(v)},sign:async(_,message)=>crypto.sign('sha256',message,signer.privateKey),clock:{wall:()=>wall,mono:()=>wall},post:async(route,body)=>{
    if(offline)throw Error('offline');return route.includes('challenge')?a.challenge(body,route.startsWith('/v3')?3:2):a.lease(body,route.startsWith('/v3')?3:2);
  }};
  let c=new LicenseClient(options);
  try{
    assert.equal(await c.refresh(),'VALID');
    const doc={orgId:'org-test',entitlements:[entitlement(execution()),entitlement(execution('mri'),{validUntil:1800})]};
    const longExecution={...execution(),solutionId:'x'.repeat(80),workflowId:'x'.repeat(80)};
    const oversized={orgId:doc.orgId,entitlements:[entitlement(longExecution,{executions:Array.from({length:256},(_,i)=>({...longExecution,recipeDigest:i.toString(16).padStart(64,'0')}))})]};
    const previous=a.db.prepare('SELECT revision FROM licenses WHERE id=?').get(binding.licenseId).revision;
    for(const dryRun of [true,false])assert.throws(()=>a.solutions(binding.licenseId,oversized,{dryRun}));
    assert.equal(a.db.prepare('SELECT revision FROM licenses WHERE id=?').get(binding.licenseId).revision,previous);
    const preview=a.solutions(binding.licenseId,doc,{dryRun:true});assert.equal(preview.readyAt,1600);assert.equal(a.db.prepare('SELECT count(*) n FROM solution_assignments').get().n,0);
    const document=path.join(root,'assignment.json');fs.writeFileSync(document,JSON.stringify(doc));
    const applied=require('./solution-admin.cjs').configure(a,'solutions',[binding.licenseId,document]);assert.ok(fs.existsSync(applied.backup));
    assert.equal(await c.refresh(),'REVOKED');c.close();saved=null;
    c=new LicenseClient({...options,version:3});assert.equal(await c.refresh(),'UNACTIVATED');
    now=wall=1600;assert.equal(await c.refresh(),'VALID');
    const auth=x=>c.authorize({runId:crypto.randomUUID(),engine:x.engine,execution:x});
    await auth(execution());await auth(execution('mri'));
    const revision=require('./solution-admin.cjs').configure(a,'solution-status',[binding.licenseId,'exmo.thigh.mri','revoked']);assert.ok(revision.revision>preview.revision);
    await c.refresh();await auth(execution());await assert.rejects(auth(execution('mri')),/not authorized/);
    offline=true;assert.equal(await c.refresh(),'GRACE');c.close();c=new LicenseClient({...options,version:3});
    await auth(execution());await assert.rejects(auth(execution('mri')),/not authorized/);
    const bad=structuredClone(doc);bad.entitlements[1].revision=1;assert.throws(()=>a.solutions(binding.licenseId,bad),/Stale entitlement/);
    offline=false;require('./solution-admin.cjs').configure(a,'solution-status',[binding.licenseId,'exmo.thigh.mri','active']);await c.refresh();
    now=wall=1800;await auth(execution());await assert.rejects(auth(execution('mri')),/not authorized/);
    const prior=JSON.parse(a.db.prepare('SELECT document FROM solution_assignments WHERE license=?').get(binding.licenseId).document);
    require('./solution-admin.cjs').configure(a,'solution-expiry',[binding.licenseId,'exmo.thigh.mri','7d']);
    const updated=JSON.parse(a.db.prepare('SELECT document FROM solution_assignments WHERE license=?').get(binding.licenseId).document);
    assert.deepEqual(updated.entitlements[0],prior.entitlements[0]);
    assert.equal(updated.entitlements[1].validUntil,now+7*86400);assert.equal(updated.entitlements[1].revision,prior.entitlements[1].revision+1);
    await c.refresh();await auth(execution('mri'));
    require('./solution-admin.cjs').configure(a,'solution-expiry',[binding.licenseId,'exmo.thigh.mri','perpetual']);
    assert.equal(JSON.parse(a.db.prepare('SELECT document FROM solution_assignments WHERE license=?').get(binding.licenseId).document).entitlements[1].validUntil,null);
    a.modelStatus(hash(2),'revoked');await c.refresh();await assert.rejects(auth(execution()),/not authorized/);
    assert.equal(a.db.prepare('SELECT count(*) n FROM challenges').get().n,0);
  }finally{c.close();a.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('v3 protected runtime and real Python loader reject shared-model substitution, forged recipes and old v2 admissions',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'exmo-v3-loader-')),ar=path.join(root,'authority'),engine=path.join(root,'engine');main(['init',ar,'internal']);
  const authority=new Authority(ar),server=createServer(authority);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const signing=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),wrapping=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
  const pem=key=>key.export({type:'spki',format:'pem'}),key={create:async()=>pem(signing.publicKey),public:async()=>pem(signing.publicKey),modelPublic:async()=>pem(wrapping.publicKey),
    sign:async(_,data)=>crypto.sign('sha256',data,signing.privateKey),unwrap:async(_,data)=>crypto.privateDecrypt({key:wrapping.privateKey,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},data),close(){}};
  const build={profile:'internal',licenseVersion:3,issuerPublicKey:pem(authority.publicKey),serverUrl:`http://127.0.0.1:${server.address().port}`,allowLoopback:true};
  let runtime,worker,resultWorker;
  try{
    const source=path.join(root,'source'),target=path.join(engine,'packages/EXMO_CT');
    for(const name of ['src/fixture.py','configs/inference.json','provenance/source_inventory.json','run.py',...ASSETS.ct]){
      const file=path.join(source,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,name.endsWith('.json')?'{}':'fixture:'+name);
    }
    fs.mkdirSync(path.dirname(target),{recursive:true});
    packModels(authority,ar,source,target,'test-v3','ct');
    fs.writeFileSync(path.join(engine,'payload.json'),JSON.stringify({token:M.sign({schema:'exmo-runtime-payload-v1',version:'fixture-v3',profile:'internal',python:'3.12.8',indexSha256:hash(0),models:{}},authority.key)}));
    runtime=await openLicensing({build,directory:path.join(root,'client'),key,engineRoot:engine,scriptsRoot:path.join(repo,'desktop'),
      safeStorage:{isEncryptionAvailable:()=>true,encryptString:x=>Buffer.from(x),decryptString:x=>x.toString()},resultStorage:{ready:()=>true}});
    const request=runtime.enrollment(),b={profile:'internal',licenseId:'v3-loader',installationId:request.installationId,installationKey:request.installationKey};
    authority.approve({binding:b,installationPublicKey:request.installationPublicKey,engines:['ct'],contractEnd:Math.floor(Date.now()/1000)+3600,graceSeconds:3600,renewSeconds:300});
    const activation=grant(authority,ar,b.licenseId,request,target,'ct'),md=M.hash(Buffer.from(JSON.parse(fs.readFileSync(path.join(target,'model-package.json'))).token));
    const job={analysis:'ct',...E.scope({analysis:'ct'})},ctx={engineRoot:engine,scriptsRoot:path.join(repo,'desktop'),issuer:authority.publicKey};
    const binding=E.binding(job,ctx,'analyze',md),mutation=E.binding({...job,variant:'raw'},ctx,'result-mutation');
    authority.solutions(b.licenseId,{orgId:'org-test',entitlements:[entitlement(binding,{capabilities:['analyze','result-mutation'],executions:[binding,mutation]})]});
    await runtime.activate(activation);
    assert.deepEqual(runtime.expiredSolutions(),[]);
    const policy=path.join(root,'policy.json');fs.writeFileSync(policy,JSON.stringify({profile:'internal',issuerPublicKey:build.issuerPublicKey,licenseVersion:3}));
    worker=new AnalysisWorker({python,args:['-B',path.join(__dirname,'check-model-loader.py'),'--engine',engine,'--policy',policy],env:process.env,logPath:path.join(root,'private.log')});
    const admit=async(transform)=>{
      const runId=crypto.randomUUID(),challenge=await worker.request({operation:'challenge',runId,engine:'ct'});
      let auth=await runtime.authorizeModel({runId,job,challenge}),runJob=structuredClone(job);
      if(transform){[auth,runJob]=transform(auth,runJob);}
      return worker.request({operation:'assets',runId,job:runJob,authorization:auth});
    };
    assert.ok((await admit()).assets);
    for(const field of ['solutionId','workflowId','recipeDigest','packageSetDigest'])await assert.rejects(admit((auth,j)=>{
      const c=JSON.parse(auth.message);c[field]=field.endsWith('Digest')?hash(9):'exmo.thigh.other';
      if(field==='solutionId'||field==='workflowId')j[field]=c[field];c.jobDigest=M.hash(Buffer.from(JSON.stringify(j)));
      auth.message=JSON.stringify(c);auth.signature=crypto.sign('sha256',Buffer.from('EXMO/MODEL-RUN/v2/'+auth.message),signing.privateKey).toString('base64url');return [auth,j];
    }),/rejected/);
    await assert.rejects(admit((auth,j)=>{const c=JSON.parse(auth.message);c.schema='exmo-model-run-v1';for(const k of ['solutionId','workflowId','capability','recipeDigest','packageSetDigest'])delete c[k];auth.message=JSON.stringify(c);auth.signature=crypto.sign('sha256',Buffer.from('EXMO/MODEL-RUN/v1/'+auth.message),signing.privateKey).toString('base64url');return [auth,j];}),/rejected/);
    const badRun=crypto.randomUUID(),challenge=await worker.request({operation:'challenge',runId:badRun,engine:'ct'});
    await assert.rejects(runtime.authorizeModel({runId:badRun,job:{...job,solutionId:'exmo.other.ct'},challenge}),/지원하지|mismatch/);
    const storage=path.join(root,'data');fs.mkdirSync(storage);
    const resultOptions={python,args:['-B','-X','utf8',path.join(__dirname,'check-result-authorization.py'),'--engine',engine,'--policy',policy,'--root',storage],
      env:process.env,logPath:path.join(root,'results-private.log'),artifactStorage:{root:path.join(storage,'runs'),key:crypto.randomBytes(32).toString('base64url')}};
    resultWorker=new AnalysisWorker(resultOptions);
    const publication=await resultWorker.request({operation:'fixture'}),identity=await require('../../desktop/result-identities.cjs').createResultIdentities(storage).bindSnapshot(publication,publication._snapshot.snapshotDigest);
    Object.assign(publication.summary,identity);
    fs.writeFileSync(path.join(storage,'runs',publication.summary.id,'published.json'),JSON.stringify(publication));
    const mutationJob={analysis:'ct',...E.scope(job),variant:'raw',id:publication.summary.id,record:publication.record,result:publication.result,
      createdAt:'synthetic',deferMesh:true,source:{originStoreId:identity.originStoreId,originResultId:identity.originResultId,analysisRevision:identity.analysisRevision,...publication._snapshot}};
    const permitMutation=async()=>{const runId=crypto.randomUUID(),challenge=await resultWorker.request({operation:'mutation_challenge',runId,job:mutationJob});
      return {operation:'admit',runId,job:mutationJob,authorization:await runtime.authorizeMutation({runId,job:mutationJob,challenge})};};
    const validMutation=await permitMutation();assert.equal(await resultWorker.request(validMutation),true);
    await assert.rejects(resultWorker.request(validMutation),/rejected/);
    const forged=await permitMutation(),claims=JSON.parse(forged.authorization.message);claims.recipeDigest=hash(9);forged.authorization.message=JSON.stringify(claims);
    forged.authorization.signature=crypto.sign('sha256',Buffer.from('EXMO/RESULT-MUTATION/v1/'+forged.authorization.message),signing.privateKey).toString('base64url');
    await assert.rejects(resultWorker.request(forged),/rejected/);
    await assert.rejects(resultWorker.request({operation:'mutation_challenge',runId:crypto.randomUUID(),job:{...mutationJob,source:{...mutationJob.source,maskDigest:hash(9)}}}),/rejected/);
    require('./solution-admin.cjs').configure(authority,'solution-status',[b.licenseId,job.solutionId,'revoked']);await runtime.refresh();
    await assert.rejects(permitMutation(),/not authorized/);
    const read=await resultWorker.request({operation:'read',result:publication.result});assert.deepEqual(read.summary.rows,publication.summary.rows);
    const changed=structuredClone(publication);changed.summary.rows[0].value=123;
    await assert.rejects(resultWorker.request({operation:'mesh',publication:changed}),/rejected/);
    const mesh=await resultWorker.request({operation:'mesh',publication});assert.ok(mesh.summary.meshBytes>0);assert.deepEqual(mesh.summary.rows,publication.summary.rows);
    const expired=JSON.parse(authority.db.prepare('SELECT document FROM solution_assignments WHERE license=?').get(b.licenseId).document);
    expired.entitlements[0].validUntil=authority.clock();expired.entitlements[0].revision++;
    authority.solutions(b.licenseId,expired);await runtime.refresh();assert.deepEqual(runtime.expiredSolutions(),[job.solutionId]);
    await assert.rejects(admit(),/not authorized/);
    await resultWorker.close();
    resultWorker=new AnalysisWorker({...resultOptions,args:resultOptions.args.map(v=>v===engine?path.join(root,'no-models-installed'):v)});
    assert.deepEqual((await resultWorker.request({operation:'read',result:publication.result})).summary.rows,publication.summary.rows);
    assert.ok((await resultWorker.request({operation:'mesh',publication})).summary.meshBytes>0);
    fs.appendFileSync(publication.mask,Buffer.from('changed'));
    await assert.rejects(resultWorker.request({operation:'read',result:publication.result}),/rejected/);
    authority.modelStatus(md,'revoked');await runtime.refresh();await assert.rejects(runtime.authorizeModel({runId:badRun,job,challenge}),/not authorized/);
    runtime.close();runtime=null;
    await assert.rejects(openLicensing({build:{...build,licenseVersion:2},directory:path.join(root,'client'),key,safeStorage:{}}),/migrated/);
  }finally{await worker?.close();await resultWorker?.close();runtime?.close();await new Promise(r=>server.close(r));authority.close();fs.rmSync(root,{recursive:true,force:true});}
});
