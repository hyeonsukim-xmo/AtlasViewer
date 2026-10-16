// Real signed packages and strict loaders. No patient inference or model writes.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {Authority,createServer}=require('./license-server.cjs');
const {grant}=require('./model-package.cjs');
const {openLicensing}=require('../../desktop/security/runtime.cjs');
const {WindowsKey}=require('../../desktop/security/windows-key.cjs');
const {AnalysisWorker}=require('../../desktop/analysis-worker.cjs');
const P=require('../../desktop/security/license-protocol.cjs');
const repo=path.resolve(__dirname,'../..');
async function main(){
  const directory=path.join(repo,'work/security-internal-local/authority'),portable=process.argv[2]?path.resolve(process.argv[2]):null;
  const engine=portable || path.join(repo,'work/security-delivery-v2'),device=process.argv[3] || 'cpu';assert.ok(['cpu','cuda:0'].includes(device));
  const supported=['ct',...(portable?['mri']:[]),'ap','lat_lt','lat_rt','xray-classifier'];
  const selected=process.argv[4]?.split(',') || supported;assert.ok(selected.length && selected.every(e=>supported.includes(e)));
  const output=path.join(repo,'outputs/security-models',crypto.randomUUID());fs.mkdirSync(output,{recursive:true});
  const authority=new Authority(directory),server=createServer(authority);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const key=new WindowsKey();let runtime,id,worker,licenseId;
  const results={patientDataUsed:false,fullCaseInference:false,device,payload:portable,engines:{}};
  try {
    const build={profile:'internal',issuerPublicKey:authority.publicKey.export({type:'spki',format:'pem'}),serverUrl:`http://127.0.0.1:${server.address().port}`,allowLoopback:true};
    runtime=await openLicensing({build,directory:path.join(output,'identity'),key,safeStorage:{isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from(v),decryptString:v=>v.toString()}});
    const request=runtime.enrollment();id=request.installationId;licenseId='loader-'+id;
    authority.approve({binding:{profile:'internal',licenseId,installationId:id,installationKey:request.installationKey},installationPublicKey:request.installationPublicKey,
      engines:['ct','mri','ap','lat'],contractEnd:Math.floor(Date.now()/1000)+3600,graceSeconds:3600,renewSeconds:300});
    const policy=path.join(output,'policy.json');fs.writeFileSync(policy,JSON.stringify({profile:'internal',issuerPublicKey:build.issuerPublicKey}));
    for(const e of selected) {
      const family=e==='ct'?'EXMO_CT':e==='mri'?'EXMO_MRI':'EXMO_XRAY',environment=e.startsWith('lat_')?'lat':e==='xray-classifier'?'ct':e;
      await runtime.activate(grant(authority,directory,licenseId,request,path.join(engine,'packages',family),e));
      const args=[path.join(__dirname,'check-model-loader.py'),'--engine',engine,'--policy',policy,'--source',path.join(repo,'work/modality-integration/packages',family),'--device',device,...(portable?['--forward']:[])];
      const bootstrap="import sys,runpy;sys.path.insert(0,sys.argv.pop(1));from runtime_bootstrap import configure_runtime;configure_runtime(sys.argv.pop(1));sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')";
      worker=new AnalysisWorker({python:portable?path.join(engine,'python/python.exe'):path.join(repo,'work/modality-integration/envs',environment,'Scripts/python.exe'),
        args:portable?['-I','-B','-X','utf8','-c',bootstrap,path.join(repo,'desktop'),path.join(engine,'envs',environment,'Lib/site-packages'),...args]:['-B',...args],
        env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2'},logPath:path.join(output,e+'.log')});
      const runId=crypto.randomUUID(),challenge=await worker.request({operation:'challenge',runId,engine:e},{timeout:30000});
      const job=['ct','mri','xray-classifier'].includes(e)?{analysis:e,device}:{analysis:'xray',route:e.toUpperCase(),device};
      const authorization=await runtime.authorizeModel({runId,job,challenge});
      results.engines[e]=await worker.request({operation:e==='mri'?'compare':'compare-loaders',runId,job,authorization},{timeout:300000});
      await worker.close();worker=null;fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify(results,null,2));console.log(e+': strict loader parity passed');
    }
    console.log('Evidence: '+path.join(output,'verification.json'));
  }finally{
    await worker?.close();runtime?.close();key.close();if(licenseId)authority.status(licenseId,'revoked');await new Promise(resolve=>server.close(resolve));authority.close();
    if(id)execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`foreach($s in @('', '.Model')){$k=[System.Security.Cryptography.CngKey]::Open('EXMO.Atlas.Internal.${id}'+$s);try{$k.Delete()}finally{$k.Dispose()}}`],{windowsHide:true});
  }
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
