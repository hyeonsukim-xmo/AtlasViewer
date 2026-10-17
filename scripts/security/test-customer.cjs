const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),https=require('node:https');
const {spawnSync}=require('node:child_process');
const P=require('../../desktop/security/license-protocol.cjs'),M=require('../../desktop/security/model-package.cjs'),E=require('../../desktop/security/model-envelope.cjs');
const {Authority,main:init}=require('./license-server.cjs'),{packModels,ASSETS}=require('./pack-models.cjs');
const {openLicensing}=require('../../desktop/security/runtime.cjs'),{AnalysisWorker}=require('../../desktop/analysis-worker.cjs');
const root=path.resolve(__dirname,'../..'),python=path.join(root,'work/security-poc/env/Scripts/python.exe');
function fixture(message){const r=spawnSync(python,['-B',path.join(__dirname,'customer-fixture.py')],{input:JSON.stringify(message)+'\n',encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
for(const version of [2,3])test(`customer v${version}: HTTPS, both JWE recipients, hardware proofs, worker admission and revocation`,async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'exmo-customer-')),authorityRoot=path.join(directory,'authority'),engine=path.join(directory,'engine');init(['init',authorityRoot,'customer']);
 const f=fixture({operation:'fixture'}),authority=new Authority(authorityRoot),pc=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),rsa=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
 const key={create:async()=>pc.publicKey.export({type:'spki',format:'pem'}),public:async()=>pc.publicKey.export({type:'spki',format:'pem'}),modelPublic:async()=>rsa.publicKey.export({type:'spki',format:'pem'}),sign:async(_,data)=>crypto.sign('sha256',data,pc.privateKey),unwrap:async(_,data)=>crypto.privateDecrypt({key:rsa.privateKey,oaepHash:'sha256'},data),close(){}};
 let removed=false,runtime,worker;const proofMessages=[];
 const dongle={enrollment:async()=>f.hardware,sign:async(_,data)=>{assert.equal(removed,false,'Dongle missing');proofMessages.push(data.toString());return crypto.sign('sha256',data,f.keys['9e']);},unwrap:async(_,token,context)=>{assert.equal(removed,false);return Buffer.from(fixture({operation:'unwrap',key:f.keys['9d'],token,context}),'base64url');},close(){}};
 const server=https.createServer({key:f.keys.tls,cert:f.certificate},async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.includes('challenge')?authority.challenge(body,version):authority.lease(body,version)));}catch{res.writeHead(400);res.end('{}');}});
 const previousCA=https.globalAgent.options.ca;https.globalAgent.options.ca=f.certificate;
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  assert.throws(()=>require('./customer-admin.cjs').issuerCrypto({operation:'verify',hardware:f.hardware}),'Production must reject synthetic attestation');
  runtime=await openLicensing({build:{profile:'customer',issuerPublicKey:authority.publicKey.export({type:'spki',format:'pem'}),serverUrl:`https://127.0.0.1:${server.address().port}`,allowLoopback:false,...(version===3?{licenseVersion:3}:{})},engineRoot:engine,scriptsRoot:path.join(root,'desktop'),directory:path.join(directory,'client'),key,dongle,resultStorage:{hasRecovery:()=>true,ready:()=>true},safeStorage:{isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from(v),decryptString:v=>v.toString()}});
  const request=await runtime.enrollment();M.validateEnrollment(request);const hardware=M.hardwareKeys(f.hardware);
  const binding={profile:'customer',licenseId:'test',installationId:request.installationId,installationKey:request.installationKey,dongleKey:P.fingerprint(hardware['9e']),agreementKey:P.fingerprint(hardware['9d'])};
  authority.approve({binding,installationPublicKey:request.installationPublicKey,donglePublicKey:hardware['9e'].export({type:'spki',format:'pem'}),engines:['ct'],contractEnd:Math.floor(Date.now()/1000)+3600,graceSeconds:3600,renewSeconds:300});
  authority.extend('test',Math.floor(Date.now()/1000)+7200);
  const source=path.join(directory,'source'),target=path.join(engine,'packages/EXMO_CT');fs.mkdirSync(path.dirname(target),{recursive:true});
  for(const name of ['src/fixture.py','configs/inference.json','provenance/source_inventory.json','run.py',...ASSETS.ct]){const file=path.join(source,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,name.endsWith('.json')?'{}':'fixture:'+name);}
  const digest=packModels(authority,authorityRoot,source,target,'test','ct').ct,dek=fs.readFileSync(path.join(authorityRoot,'model-keys',digest+'.key')),context=E.context(binding,digest);
  const inner=fixture({operation:'wrap',key:f.keys['9d'],plain:dek.toString('base64url'),context});dek.fill(0);
  const access=M.sign({schema:'exmo-model-access-v2',binding,modelDigest:digest,recipient:P.fingerprint(rsa.publicKey),jwe:E.wrap(inner,rsa.publicKey,context)},authority.key);
  authority.db.prepare("INSERT INTO models VALUES (?,'active')").run(digest);authority.db.prepare('INSERT INTO model_grants VALUES (?,?,?)').run('test','ct',digest);
  const policyScope=require('../../desktop/security/execution.cjs'),job={analysis:'ct',...policyScope.scope({analysis:'ct'})};
  if(version===3){
    fs.writeFileSync(path.join(engine,'payload.json'),JSON.stringify({token:M.sign({schema:'exmo-runtime-payload-v1',profile:'customer'},authority.key)}));
    const ctx={engineRoot:engine,scriptsRoot:path.join(root,'desktop'),issuer:authority.publicKey};
    authority.solutions('test',{orgId:'customer-org',entitlements:[{entitlementId:'ct-only',solutionId:job.solutionId,validFrom:0,validUntil:null,state:'active',revision:1,
      capabilities:['analyze','result-mutation'],executions:[policyScope.binding(job,ctx,'analyze',digest),policyScope.binding({...job,variant:'raw'},ctx,'result-mutation')]}]});
  }
  await runtime.activate({binding,installationPublicKey:request.installationPublicKey,hardware:f.hardware,models:{ct:access}});
  const policy=path.join(directory,'policy.json');fs.writeFileSync(policy,JSON.stringify({profile:'customer',issuerPublicKey:authority.publicKey.export({type:'spki',format:'pem'}),...(version===3?{licenseVersion:3}:{})}));
  worker=new AnalysisWorker({python:path.join(root,'work/modality-integration/envs/ct/Scripts/python.exe'),args:['-B',path.join(__dirname,'check-model-loader.py'),'--engine',engine,'--policy',policy],env:process.env,logPath:path.join(directory,'worker.log')});
  const runId=crypto.randomUUID(),challenge=await worker.request({operation:'challenge',runId,engine:'ct'}),authorization=await runtime.authorizeModel({runId,job,challenge});
  assert.ok(authorization.dongleSignature);assert.ok(proofMessages.some(v=>v.startsWith(`EXMO/MODEL-RUN/v${version===3?2:1}/dongle/`)));
  const result=await worker.request({operation:'assets',runId,job,authorization});assert.equal(result.assets[ASSETS.ct[0]],M.hash(Buffer.from('fixture:'+ASSETS.ct[0])));
  await assert.rejects(worker.request({operation:'assets',runId,job,authorization}));
  const mutation=await runtime.authorizeMutation({runId:crypto.randomUUID(),job:{...job,variant:'raw',source:{fixture:true}},challenge:{nonce:crypto.randomBytes(32).toString('base64url')}});
  assert.ok(crypto.verify('sha256',Buffer.from('EXMO/RESULT-MUTATION/v1/dongle/'+mutation.message),hardware['9e'],Buffer.from(mutation.dongleSignature,'base64url')));
  removed=true;await assert.rejects(runtime.authorizeModel({runId,job,challenge}));removed=false;
  authority.modelStatus(digest,'revoked');await runtime.refresh();await assert.rejects(runtime.authorizeModel({runId,job,challenge}));
 }finally{await worker?.close();runtime?.close();await new Promise(resolve=>server.close(resolve));authority.close();https.globalAgent.options.ca=previousCA;assert.ok(directory.startsWith(os.tmpdir()+path.sep));fs.rmSync(directory,{recursive:true,force:true});}
});
