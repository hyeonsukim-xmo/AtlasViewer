// Read-only full verification of the installed payload; no inference or key material in the report.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
async function main([payload,publicKey,output,verifier]) {
  if(!payload || !publicKey || !output)throw Error('Usage: benchmark-startup.cjs [--node] PAYLOAD ISSUER_PUBLIC_PEM NEW_REPORT.json [BASELINE_VERIFIER.cjs]');
  if(fs.existsSync(output))throw Error('Use a new report path');
  const modulePath=verifier?path.resolve(verifier):require.resolve('../../desktop/security/payload.cjs');
  const {verifyPayloadAsync}=require(modulePath);
  const timings={};
  const started=performance.now();
  console.log('Verifying complete payload with '+(process.versions.electron?'Electron '+process.versions.electron:'Node '+process.version));
  const policy=await verifyPayloadAsync(payload,crypto.createPublicKey(fs.readFileSync(publicKey)),()=>{},timings);
  const report={schema:'exmo-startup-benchmark-v1',at:new Date().toISOString(),platform:process.platform,node:process.version,electron:process.versions.electron ?? null,
    cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,memoryBytes:os.totalmem(),payloadVersion:policy.version,payloadIndexSha256:policy.indexSha256,
    verifierSha256:crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex'),
    workerSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(modulePath),'payload-verifier.cjs'))).digest('hex'),
    cacheState:'OS file cache not flushed',wallMs:performance.now()-started,timings};
  fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});
  fs.writeFileSync(output,JSON.stringify(report,null,2),{flag:'wx'});
  console.log(JSON.stringify(report,null,2));
}
if(require.main===module || (process.versions.electron && path.resolve(process.argv[1] || '')===__filename)){
  const args=process.argv.slice(2);
  if(!process.versions.electron && args[0]!=='--node'){
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const run=require('node:child_process').spawnSync(require('electron'),[__filename,...args],{env,windowsHide:true,stdio:'inherit',timeout:300000});
    if(run.error)console.error(run.error.message);process.exitCode=run.status??1;
  }else{
    if(args[0]==='--node')args.shift();
    const app=process.versions.electron?require('electron').app:null;
    (app?app.whenReady():Promise.resolve()).then(()=>main(args))
      .then(()=>app?.exit(0),error=>{console.error(error.message);if(app)app.exit(1);else process.exitCode=1;});
  }
}
