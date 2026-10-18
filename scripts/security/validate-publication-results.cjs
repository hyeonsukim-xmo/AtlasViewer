// Existing isolated QA results only. No inference, no original file mutation, no remote network.
const {app,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{execFile}=require('node:child_process');
const S=require('../../desktop/publication-protocol.cjs');
const {solutionFields}=require('../../desktop/solutions.cjs');
const {openResultStorage}=require('../../desktop/security/result-storage.cjs');
const {encryptMesh}=require('../../desktop/publication-crypto.cjs');
const {verifyArtifact}=require('./result-verifier.cjs');
const qa=path.resolve(process.argv[2]||'outputs/selected-runtime-check/785af919-05cd-48d4-b000-7f73c20354ed/EXMO Atlas Internal');
const output=path.resolve('outputs/publication-check',crypto.randomUUID());fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'electron'));fs.mkdirSync(app.getPath('userData'),{recursive:true});fs.copyFileSync(path.join(qa,'Local State'),path.join(app.getPath('userData'),'Local State'));
async function run(){
  await app.whenReady();const root=path.join(qa,'imaging/runs'),storage=openResultStorage(path.join(qa,'result-security'),safeStorage).bootstrap(root);assert.ok(storage);
  const keys={mask:crypto.generateKeyPairSync('rsa',{modulusLength:3072}),mesh:crypto.generateKeyPairSync('rsa',{modulusLength:3072})};const evidence=[];
  for(const entry of fs.readdirSync(root)){
    const file=path.join(root,entry,'published.json');if(!fs.existsSync(file))continue;
    const p=JSON.parse(fs.readFileSync(file)),before=S.hash(fs.readFileSync(p.mask)),attemptId=crypto.randomUUID();
    const origin=JSON.parse(fs.readFileSync(path.join(root,entry,'identity.json'))),identity={originStoreId:origin.originStoreId,originResultId:origin.originResultId,analysisRevision:Object.values(origin.revisions)[0]};
    const scope={orgId:'qa',workspaceId:'validation',subject:'qa',installationId:'qa'},dir=path.join(output,'objects',attemptId);fs.mkdirSync(dir,{recursive:true});
    const started=performance.now();
    const exported=await new Promise((resolve,reject)=>{const child=execFile(path.resolve('work/modality-integration/envs/ct/Scripts/python.exe'),['-B','-X','utf8','scripts/security/validate-publication-results.py'],{maxBuffer:2*1024*1024},(e,out,err)=>e?reject(Error(err)):resolve(JSON.parse(out)));
      child.stdin.end(JSON.stringify({storage,result:p.result,variant:p.summary.variant,destination:dir,publicKey:keys.mask.publicKey.export({type:'spki',format:'pem'}),scope,identity,attemptId}));});
    const content=S.fromSnapshot(p.summary,{...identity,...solutionFields(p.summary)},exported.geometry,S.pick(exported.artifact,['sha256','bytes']));
    const manifest={schema:'exmo-upload-v1',attemptId,scope,content,contentDigest:S.digest(content),artifact:exported.artifact,attachmentRevision:0};
    await verifyArtifact(output,manifest,{mask:keys.mask.privateKey});
    let mesh=false;
    if(p.mesh){const meshId=crypto.randomUUID(),meshDir=path.join(output,'objects',meshId);fs.mkdirSync(meshDir);
      const artifact=await encryptMesh(p.mesh,meshDir,scope,identity,meshId,keys.mesh.publicKey.export({type:'spki',format:'pem'}));
      await verifyArtifact(output,{...manifest,attemptId:meshId,artifact},{mesh:keys.mesh.privateKey});mesh=true;}
    assert.equal(S.hash(fs.readFileSync(p.mask)),before);
    evidence.push({analysis:p.summary.analysis,route:p.summary.route,maskVerified:true,meshVerified:mesh,bytes:exported.artifact.bytes,seconds:(performance.now()-started)/1000,sourceUnchanged:true});
    console.log('PASS existing '+p.summary.analysis+' '+(p.summary.route??'volume')+' encrypted mask and '+(mesh?'3D':'projection metrics'));
  }
  assert.equal(evidence.length,5);fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({inferenceRerun:false,realStoredResults:true,results:evidence},null,2));
  // Test keys remain memory-only. Retain evidence, remove now-unreadable encrypted QA transfer copies.
  const objects=path.resolve(output,'objects');assert.equal(path.dirname(objects),output);fs.rmSync(objects,{recursive:true,force:true});console.log('Evidence: '+path.join(output,'verification.json'));
}
run().then(()=>app.exit(0)).catch(e=>{console.error(e);app.exit(1);});
