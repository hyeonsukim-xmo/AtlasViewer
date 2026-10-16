const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {Authority,createServer,main}=require('./license-server.cjs');
const {packModels,ASSETS}=require('./pack-models.cjs');
const {grant}=require('./model-package.cjs');
const {openLicensing}=require('../../desktop/security/runtime.cjs');
const {WindowsKey}=require('../../desktop/security/windows-key.cjs');
const {AnalysisWorker}=require('../../desktop/analysis-worker.cjs');
const M=require('../../desktop/security/model-package.cjs');
const repo=path.resolve(__dirname,'../..');
test('CT, AP, both five-fold LAT and NPZ: independent keys, all assets, signed admission and cached authorization boundaries',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'exmo-all-models-')),authorityRoot=path.join(root,'authority'),engine=path.join(root,'engine');
  main(['init',authorityRoot,'internal']);const authority=new Authority(authorityRoot),server=createServer(authority);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const key=new WindowsKey();let runtime,worker,id;
  try {
    const targets={};fs.mkdirSync(path.join(engine,'packages'),{recursive:true});
    for(const family of ['ct','xray']) {
      const source=path.join(root,'source-'+family),target=path.join(engine,'packages',family==='ct'?'EXMO_CT':'EXMO_XRAY');
      const names=family==='ct'?['src/fixture.py','configs/inference.json','provenance/source_inventory.json','run.py']:
        ['code/fixture.py','classification/pipeline.py','inference_config.json','label_mapping.json','models/LAT_LT/plans.json','models/LAT_RT/plans.json'];
      const engines=family==='ct'?['ct']:['ap','lat_lt','lat_rt','xray-classifier'];
      for(const name of [...names,...engines.flatMap(e=>ASSETS[e])]) {
        const file=path.join(source,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,name.endsWith('.json')?'{}':'fixture:'+name);
      }
      packModels(authority,authorityRoot,source,target,'test-v2',family);
      for(const e of engines)targets[e]=target;
    }
    const build={profile:'internal',issuerPublicKey:authority.publicKey.export({type:'spki',format:'pem'}),serverUrl:`http://127.0.0.1:${server.address().port}`,allowLoopback:true};
    runtime=await openLicensing({build,directory:path.join(root,'client'),key,safeStorage:{isEncryptionAvailable:()=>true,encryptString:x=>Buffer.from(x),decryptString:x=>x.toString()}});
    const request=runtime.enrollment();id=request.installationId;
    const binding={profile:'internal',licenseId:'all-models',installationId:id,installationKey:request.installationKey};
    authority.approve({binding,installationPublicKey:request.installationPublicKey,engines:['ct','ap','lat'],contractEnd:Math.floor(Date.now()/1000)+3600,graceSeconds:3600,renewSeconds:300});
    const policy=path.join(root,'policy.json');fs.writeFileSync(policy,JSON.stringify({profile:'internal',issuerPublicKey:build.issuerPublicKey}));
    worker=new AnalysisWorker({python:path.join(repo,'work/modality-integration/envs/ct/Scripts/python.exe'),args:['-B',path.join(__dirname,'check-model-loader.py'),'--engine',engine,'--policy',policy],env:process.env,logPath:path.join(root,'private.log')});
    for(const e of Object.keys(targets)) {
      await runtime.activate(grant(authority,authorityRoot,binding.licenseId,request,targets[e],e));
      const runId=crypto.randomUUID(),challenge=await worker.request({operation:'challenge',runId,engine:e});
      const job=e==='ct'||e==='xray-classifier'?{analysis:e}:{analysis:'xray',route:{ap:'AP',lat_lt:'LAT_LT',lat_rt:'LAT_RT'}[e]};
      const authorization=await runtime.authorizeModel({runId,job,challenge});
      const result=await worker.request({operation:'assets',runId,job,authorization});
      assert.deepEqual(result.assets,Object.fromEntries(ASSETS[e].map(name=>[name,M.hash(Buffer.from('fixture:'+name))])));
      assert.ok(ASSETS[e].every(name=>!fs.existsSync(path.join(targets[e],name))));
      await assert.rejects(worker.request({operation:'assets',runId,job,authorization}),/rejected/);
    }
    // Applying a subsequent model grant must preserve already approved model grants.
    const runId=crypto.randomUUID(),challenge=await worker.request({operation:'challenge',runId,engine:'ct'}),job={analysis:'ct'};
    assert.ok(await runtime.authorizeModel({runId,job,challenge}));
    authority.status(binding.licenseId,'revoked');await runtime.refresh();
    await assert.rejects(runtime.authorizeModel({runId,job,challenge}),/REVOKED/);
  }finally{
    await worker?.close();runtime?.close();key.close();await new Promise(resolve=>server.close(resolve));authority.close();
    if(id)execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`foreach($s in @('', '.Model')){$k=[System.Security.Cryptography.CngKey]::Open('EXMO.Atlas.Internal.${id}'+$s);try{$k.Delete()}finally{$k.Dispose()}}`],{windowsHide:true});
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});
  }
});
