// Real MRI strict loader + one deterministic synthetic 128^3 forward. No patient image or full inference rerun.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {AnalysisWorker}=require('../../desktop/analysis-worker.cjs');
const {WindowsKey}=require('../../desktop/security/windows-key.cjs');
const {openLicensing}=require('../../desktop/security/runtime.cjs');
const {Authority,createServer,main:init}=require('./license-server.cjs');
const {pack,grant}=require('./model-package.cjs');
async function main() {
  const repo=path.resolve(__dirname,'../..'),sourceEngine=path.resolve(process.argv[2] || 'work/modality-integration');
  const device=process.argv[3] || 'cuda:0';assert.ok(['cpu','cuda:0'].includes(device));
  const root=path.join(repo,'work/security-mri-validation',crypto.randomUUID());fs.mkdirSync(root,{recursive:true});
  const serverRoot=path.join(root,'authority'),engine=path.join(root,'engine'),target=path.join(engine,'packages/EXMO_MRI');
  fs.mkdirSync(path.dirname(target),{recursive:true});init(['init',serverRoot,'internal']);
  const authority=new Authority(serverRoot),server=createServer(authority);let runtime,worker,id;
  try {
    const modelDigest=pack(authority,serverRoot,path.join(sourceEngine,'packages/EXMO_MRI'),target,'mri-full6-v1');
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const build={profile:'internal',issuerPublicKey:authority.publicKey.export({format:'pem',type:'spki'}),serverUrl:`http://127.0.0.1:${server.address().port}`,allowLoopback:true};
    const policy=path.join(root,'model-policy.json');fs.writeFileSync(policy,JSON.stringify({profile:'internal',issuerPublicKey:build.issuerPublicKey}));
    runtime=await openLicensing({build,directory:path.join(root,'client'),key:new WindowsKey(),safeStorage:{isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(text),decryptString:b=>b.toString()}});
    const enrollment=runtime.enrollment();id=enrollment.installationId;
    authority.approve({binding:{profile:'internal',licenseId:'mri-validation',installationId:id,installationKey:enrollment.installationKey},
      installationPublicKey:enrollment.installationPublicKey,engines:['mri'],contractEnd:Math.floor(Date.now()/1000)+3600,graceSeconds:3600,renewSeconds:300});
    await runtime.activate(grant(authority,serverRoot,'mri-validation',enrollment,target));
    worker=new AnalysisWorker({python:path.join(sourceEngine,'envs/mri/Scripts/python.exe'),
      args:['-X','utf8',path.join(__dirname,'check-model-loader.py'),'--engine',engine,'--policy',policy,'--source',path.join(sourceEngine,'packages/EXMO_MRI'),'--device',device],
      env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:'4',OPENBLAS_NUM_THREADS:'2'},logPath:path.join(root,'private.log')});
    const runId=crypto.randomUUID(),job={id:'synthetic',analysis:'mri',device,input:'synthetic-only',output:'no-patient-output'};
    const challenge=await worker.request({operation:'challenge',runId},{timeout:15000});
    const authorization=await runtime.authorizeModel({runId,job,challenge});
    const started=performance.now();
    const report=await worker.request({operation:'compare',runId,job,authorization},{timeout:180000});
    assert.equal(report.weightsIdentical,true);assert.equal(report.logitsIdentical,true);assert.equal(report.maskIdentical,true);
    Object.assign(report,{modelDigest,totalSeconds:(performance.now()-started)/1000,fullCaseInference:false,patientDataUsed:false});
    await worker.close();worker=null;
    const logs=fs.readFileSync(path.join(root,'private.log'),'utf8');assert.ok(!logs.includes(authorization.key) && !logs.includes(authorization.lease));
    fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,root,...report},null,2));
  } finally {
    await worker?.close();runtime?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));authority.close();
    if(id)execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`foreach($suffix in @('', '.Model')){$k=[System.Security.Cryptography.CngKey]::Open('EXMO.Atlas.Internal.${id}'+$suffix);try{$k.Delete()}finally{$k.Dispose()}}`],{windowsHide:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
