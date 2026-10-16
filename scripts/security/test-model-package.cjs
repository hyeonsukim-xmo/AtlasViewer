const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process');
const {AnalysisWorker}=require('../../desktop/analysis-worker.cjs');
const {WindowsKey}=require('../../desktop/security/windows-key.cjs');
const {openLicensing}=require('../../desktop/security/runtime.cjs');
const M=require('../../desktop/security/model-package.cjs');
const {Authority,createServer,main:init}=require('./license-server.cjs');
const {pack,grant}=require('./model-package.cjs');
const repo=path.resolve(__dirname,'../..');
const python=path.join(repo,'work/modality-integration/envs/mri/Scripts/python.exe');

function fixture(directory) {
  fs.mkdirSync(directory);
  for(const name of ['configs','scripts','src','weights'])fs.mkdirSync(path.join(directory,name));
  const files={'run_inference.py':'# inert fixture\n','model_identity.json':'{}','weights/final.safetensors.manifest.json':'{}','weights/final.safetensors':'fixture-model-bytes'};
  for(const [name,value]of Object.entries(files))fs.writeFileSync(path.join(directory,name),value);
  fs.writeFileSync(path.join(directory,'runtime_hashes.json'),JSON.stringify(Object.fromEntries(Object.entries(files).map(([name,value])=>[name,M.hash(Buffer.from(value))]))));
}
function deleteKeys(id) {
  if(id)execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`foreach($suffix in @('', '.Model')){$k=[System.Security.Cryptography.CngKey]::Open('EXMO.Atlas.Internal.${id}'+$suffix);try{$k.Delete()}finally{$k.Dispose()}}`],{windowsHide:true});
}
test('encrypted MRI: real CNG envelope, signed admission, tamper/replay isolation, direct CLI denial and revocation', {skip:process.platform!=='win32'},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'exmo-model-')),authorityRoot=path.join(root,'authority'),source=path.join(root,'source');
  const engine=path.join(root,'engine'),target=path.join(engine,'packages/EXMO_MRI');fs.mkdirSync(path.dirname(target),{recursive:true});fixture(source);
  init(['init',authorityRoot,'internal']);const authority=new Authority(authorityRoot),server=createServer(authority);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const build={profile:'internal',issuerPublicKey:authority.publicKey.export({type:'spki',format:'pem'}),serverUrl:`http://127.0.0.1:${server.address().port}`,allowLoopback:true};
  let runtime,worker,id;const key=new WindowsKey();
  try {
    const modelDigest=pack(authority,authorityRoot,source,target,'test-v1');
    assert.ok(!fs.existsSync(path.join(target,'weights/final.safetensors')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target,'samples/manifest.json'))),[]);
    assert.throws(()=>pack(authority,authorityRoot,source,target,'test-v1'));
    runtime=await openLicensing({build,directory:path.join(root,'client'),key,
      safeStorage:{isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(text),decryptString:b=>b.toString()}});
    const enrollment=runtime.enrollment();id=enrollment.installationId;M.validateEnrollment(enrollment);
    const binding={profile:'internal',licenseId:'mri-test',installationId:id,installationKey:enrollment.installationKey};
    authority.approve({binding,installationPublicKey:enrollment.installationPublicKey,engines:['mri'],contractEnd:Math.floor(Date.now()/1000)+3600,graceSeconds:3600,renewSeconds:300});
    assert.throws(()=>grant(authority,authorityRoot,'mri-test',{...enrollment,modelKeySignature:crypto.randomBytes(70).toString('base64url')},target));
    const activation=grant(authority,authorityRoot,'mri-test',enrollment,target);
    await runtime.activate(activation);
    const policy=path.join(root,'policy.json');fs.writeFileSync(policy,JSON.stringify({profile:'internal',issuerPublicKey:build.issuerPublicKey}));
    const log=path.join(root,'private.log');
    worker=new AnalysisWorker({python,args:['-X','utf8',path.join(__dirname,'check-model-loader.py'),'--engine',engine,'--policy',policy],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},logPath:log});
    const job={id:'opaque',analysis:'mri',input:'unused',output:'unused',device:'cpu'};
    async function permit() {
      const runId=crypto.randomUUID(),challenge=await worker.request({operation:'challenge',runId},{timeout:10000});
      assert.equal(challenge.modelDigest,modelDigest);
      return {operation:'probe',runId,job,authorization:await runtime.authorizeModel({runId,job,challenge})};
    }
    const valid=await permit();const result=await worker.request(valid,{timeout:10000});
    assert.equal(result.sha256,M.hash(Buffer.from('fixture-model-bytes')));
    await assert.rejects(worker.request(valid),/rejected/);
    for(const mutate of [
      q=>{q.job={...q.job,input:'changed'};},
      q=>{q.authorization.key=crypto.randomBytes(32).toString('base64url');},
      async q=>{
        q.authorization.key=crypto.randomBytes(32).toString('base64url');
        const claims=JSON.parse(q.authorization.message);claims.keyDigest=M.hash(Buffer.from(q.authorization.key,'base64url'));
        q.authorization.message=JSON.stringify(claims);
        q.authorization.signature=(await key.sign(id,Buffer.from('EXMO/MODEL-RUN/v1/'+q.authorization.message))).toString('base64url');
      },
      q=>{q.authorization.lease=q.authorization.lease.slice(0,-4)+'AAAA';},
      q=>{q.authorization.access=q.authorization.access.slice(0,-4)+'AAAA';},
      q=>{q.authorization.signature=crypto.randomBytes(70).toString('base64url');},
      async q=>{const claims=JSON.parse(q.authorization.message);claims.iat-=120;claims.exp=claims.iat+60;q.authorization.message=JSON.stringify(claims);q.authorization.signature=(await key.sign(id,Buffer.from('EXMO/MODEL-RUN/v1/'+q.authorization.message))).toString('base64url');},
    ]) {
      const bad=await permit();await mutate(bad);await assert.rejects(worker.request(bad),/rejected/);
    }
    const encryptedPath=path.join(target,'weights/final.safetensors.enc'),original=fs.readFileSync(encryptedPath);
    for(const altered of [Buffer.from(original),Buffer.from(original.subarray(0,-1))]) {
      altered[0]^=1;fs.writeFileSync(encryptedPath,altered);
      await assert.rejects(worker.request(await permit()),/rejected/);fs.writeFileSync(encryptedPath,original);
      assert.equal((await worker.request(await permit())).sha256,result.sha256);
    }
    const code=path.join(target,'run_inference.py');fs.appendFileSync(code,'# changed');
    await assert.rejects(worker.request(await permit()),/rejected/);fs.writeFileSync(code,'# inert fixture\n');
    fs.writeFileSync(path.join(target,'untrusted.py'),'# extra');
    await assert.rejects(worker.request(await permit()),/rejected/);fs.unlinkSync(path.join(target,'untrusted.py'));
    assert.equal((await worker.request(await permit())).sha256,result.sha256);
    const jobFile=path.join(root,'job.json');fs.writeFileSync(jobFile,JSON.stringify(job));
    const direct=spawnSync(python,['-X','utf8',path.join(repo,'desktop/model-runner.py'),'--engine-root',engine,'--job',jobFile],{encoding:'utf8',windowsHide:true});
    assert.notEqual(direct.status,0);assert.match(direct.stderr,/direct CLI is disabled/);
    const legacy=path.join(root,'legacy/resources/imaging');fs.mkdirSync(legacy,{recursive:true});
    fs.writeFileSync(path.join(path.dirname(legacy),'app.asar'),'legacy marker');
    const securitySource=fs.readFileSync(path.join(repo,'desktop/model_security.py'),'utf8');
    const policyProbe='import model_security; assert model_security.load_policy() is None';
    fs.writeFileSync(path.join(legacy,'model_security.py'),securitySource);
    assert.equal(spawnSync(python,['-B','-S','-c',policyProbe],{cwd:legacy,windowsHide:true}).status,0,'Legacy/source builds do not require the new policy');
    fs.writeFileSync(path.join(legacy,'model_security.py'),securitySource.replace('PROTECTED_MRI = False','PROTECTED_MRI = True'));
    assert.notEqual(spawnSync(python,['-B','-S','-c',policyProbe],{cwd:legacy,windowsHide:true}).status,0,'Protected build refuses a missing policy');
    // Actual production dispatcher, with only the numerical engine stubbed: a rejected new run cannot kill CPU export.
    const serviceRoot=path.join(root,'service');fs.mkdirSync(serviceRoot);
    for(const file of ['model-service.py','model_security.py'])fs.copyFileSync(path.join(repo,'desktop',file),path.join(serviceRoot,file));
    fs.copyFileSync(policy,path.join(serviceRoot,'model-policy.json'));
    for(const name of ['torch','numpy','SimpleITK','monai'])fs.writeFileSync(path.join(serviceRoot,name+'.py'),'# test-only import stub\n');
    fs.writeFileSync(path.join(serviceRoot,'artifact_store.py'),'# Separate artifact tests exercise the real storage adapter.\ndef current(): return object()\n');
    fs.writeFileSync(path.join(serviceRoot,'model-runner.py'),`import sys, threading, json
_stdout=sys.stdout
_emit_lock=threading.Lock()
_context=threading.local()
def observed(stage, fn, **kw): return fn
def ct_torch(root, device): pass
def emit(stage, **values):
    control=getattr(_context, 'control', None)
    if control:
        values['job_id']=control.ident
        if stage in ('complete','failed'): control.finished=True
    with _emit_lock:
        _stdout.write(json.dumps({'exmo':True, 'stage':stage, **values})+'\\n'); _stdout.flush()
def run_job(root, job, protection=None):
    if job['analysis']=='ct':
        assert protection is None
        emit('complete', complete=True)
        return
    assert protection.weights(protection.root/'weights/final.safetensors').sha256 == '${result.sha256}'
    control=_context.control
    control.release_gpu()
    emit('cpu_ready')
    assert control.ready.wait(10) and not control.cancelled
    emit('complete', complete=True)
`);
    const service=new AnalysisWorker({python,args:['-X','utf8',path.join(serviceRoot,'model-service.py'),'--engine-root',engine],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},logPath:path.join(root,'service.log')});
    try {
      for(let n=0;n<3;n++) {
        const runId=crypto.randomUUID();await service.request({operation:'model_challenge',runId},{timeout:10000});
        service.send({operation:'model_discard',id:runId,runId});
      }
      const runId=crypto.randomUUID(),challenge=await service.request({operation:'model_challenge',runId},{timeout:10000});
      const authorization=await runtime.authorizeModel({runId,job,challenge});
      let ready;const started=new Promise(resolve=>{ready=resolve});
      const first=service.request({operation:'run',job,authorization},{id:runId,timeout:15000,onEvent:event=>{if(event.stage==='cpu_ready')ready();}});
      await Promise.race([started,first.then(()=>{throw Error('Unexpected early completion')})]);
      await assert.rejects(service.request({operation:'run',job},{timeout:10000}),/Model execution failed/);
      await assert.rejects(service.request({operation:'model_challenge',runId:'invalid'},{timeout:10000}));
      service.send({operation:'resume_cpu',id:runId});assert.equal((await first).complete,true);
      await assert.rejects(service.request({operation:'run',job,authorization},{id:runId,timeout:10000}),/Model execution failed/);
    } finally {await service.close();}
    const ctService=new AnalysisWorker({python,args:['-S','-X','utf8',path.join(serviceRoot,'model-service.py'),'--engine-root',engine],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},logPath:path.join(root,'ct-service.log')});
    try {await assert.rejects(ctService.request({operation:'run',job:{...job,analysis:'ct'}},{timeout:10000}),/Model execution failed/);}
    finally {await ctService.close();}
    const exportCheck=`$k=[System.Security.Cryptography.CngKey]::Open('EXMO.Atlas.Internal.${id}.Model');try{$null=$k.Export((New-Object System.Security.Cryptography.CngKeyBlobFormat('RSAPRIVATEBLOB')));exit 9}catch{[Console]::Write('blocked')}finally{$k.Dispose()}`;
    assert.equal(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',exportCheck],{windowsHide:true,encoding:'utf8'}),'blocked');
    authority.status('mri-test','revoked');await runtime.refresh();
    await assert.rejects(runtime.authorizeModel({runId:crypto.randomUUID(),job,challenge:{nonce:crypto.randomBytes(32).toString('base64url'),modelDigest}}),/REVOKED/);
    assert.throws(()=>grant(authority,authorityRoot,'mri-test',enrollment,target),/No active/);
    await worker.close();worker=null;
    const logs=fs.readFileSync(log,'utf8');assert.ok(!logs.includes(valid.authorization.key) && !logs.includes(valid.authorization.lease) && !logs.includes('fixture-model-bytes'));
    assert.ok(fs.existsSync(path.join(source,'weights/final.safetensors')));
  } finally {
    await worker?.close();runtime?.close();key.close();await new Promise(resolve=>server.close(resolve));authority.close();deleteKeys(id);
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});
  }
});
