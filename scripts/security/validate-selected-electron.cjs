// Real packaged P3 main/preload, Windows CNG/DPAPI, signed installation and five sample routes.
// Issuer keys stay in an ignored, isolated QA authority; no existing license is modified.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {app,BrowserWindow,dialog}=require('electron');
const {Authority,createServer}=require('./license-server.cjs'),{grant}=require('./model-package.cjs');
const S=require('../../desktop/security/selection.cjs');
const root=path.resolve(__dirname,'../..'),appRoot=path.resolve(process.argv[2]),bundle=path.resolve(process.argv[3]),sourceAuthority=path.resolve(process.argv[4]),sourceRoot=path.resolve(process.argv[5]);
const output=process.argv[6]?path.resolve(process.argv[6]):path.join(root,'outputs/selected-runtime-check',crypto.randomUUID());
assert.equal(path.dirname(output),path.join(root,'outputs/selected-runtime-check'));fs.mkdirSync(output,{recursive:true});
let previousReport;
if(process.argv[6]){
  const client=path.join(output,'EXMO Atlas Internal/licensing');assert.ok(path.resolve(client).startsWith(output+path.sep));
  fs.rmSync(client,{recursive:true,force:true});
  for(const name of ['analysis-samples.json','failure.txt','executions.json'])if(fs.existsSync(path.join(output,name))){
    const prior=path.join(output,crypto.randomUUID()+'-'+name);fs.renameSync(path.join(output,name),prior);
    if(name==='analysis-samples.json' && JSON.parse(fs.readFileSync(prior)).complete)previousReport=prior;
  }
}
app.setPath('appData',output);app.setPath('userData',path.join(output,'source'));
const qaAuthority=path.join(output,'authority');fs.mkdirSync(qaAuthority,{recursive:true});
for(const name of ['authority.json','issuer-private.pem','issuer-public.pem'])fs.copyFileSync(path.join(sourceAuthority,name),path.join(qaAuthority,name));
fs.cpSync(path.join(sourceAuthority,'model-keys'),path.join(qaAuthority,'model-keys'),{recursive:true});
const enrollment=path.join(output,'enrollment.json'),activation=path.join(output,'activation.json');
let choice=0,pickedFiles=[activation],authority,server,installationId;
dialog.showMessageBox=async(_window,options)=>{assert.notEqual(options.type,'error',options.message);return {response:choice};};
dialog.showSaveDialog=async()=>({canceled:false,filePath:enrollment});
dialog.showOpenDialog=async()=>({canceled:false,filePaths:pickedFiles});
dialog.showErrorBox=(title,detail)=>{throw Error(title+': '+detail);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test){for(let i=0;i<1200;i++){const value=await test();if(value)return value;await pause(250);}throw Error('Selected UI timed out');}
const timeout=setTimeout(()=>{console.error('Selected runtime check timed out');app.exit(1);},3600000);
for(const event of ['uncaughtException','unhandledRejection'])process.on(event,error=>{fs.writeFileSync(path.join(output,'failure.txt'),String(error?.stack||error));console.error(error);app.exit(1);});
(async()=>{
  let code=0;
  try{
    const build=JSON.parse(fs.readFileSync(path.join(appRoot,'desktop/security/build.json')));
    assert.equal(build.profile,'internal');assert.equal(build.licenseVersion,3);assert.equal(build.allowLoopback,true);
    authority=new Authority(qaAuthority);server=createServer(authority);
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(new URL(build.serverUrl).port),'127.0.0.1',resolve);});
    require(path.join(appRoot,'desktop/main.cjs'));await app.whenReady();
    const window=await until(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('atlas://app/'))),run=code=>window.webContents.executeJavaScript(code);
    await until(()=>run('Boolean(document.querySelector(".license-status"))'));
    const call=async(method,...args)=>{const reply=await run(`window.exmoDesktop[${JSON.stringify(method)}](...${JSON.stringify(args)})`);assert.equal(reply.ok,true,JSON.stringify(reply));return reply.value;};
    const initial=await call('installations');assert.ok(initial.supported);if(!process.argv[6])assert.ok(initial.solutions.every(s=>!s.installed));
    const startup=JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'startup-performance.json')));assert.equal(startup.status,'ready');
    console.log('Common-only startup: '+Math.round(startup.totalMs)+' ms');
    choice=1;await run('window.exmoDesktop.manageLicense()');const request=JSON.parse(fs.readFileSync(enrollment));installationId=request.installationId;
    const binding={profile:'internal',licenseId:'p3-'+installationId,installationId,installationKey:request.installationKey};
    authority.approve({binding,installationPublicKey:request.installationPublicKey,engines:['ct','mri','ap','lat'],contractEnd:Math.floor(Date.now()/1000)+7200,graceSeconds:3600,renewSeconds:300});
    let approval={binding,installationPublicKey:request.installationPublicKey,models:{}};
    for(const [analysis,engines] of Object.entries(S.ENGINES))for(const engine of engines){
      const family=analysis==='ct'?'EXMO_CT':analysis==='mri'?'EXMO_MRI':'EXMO_XRAY';
      Object.assign(approval.models,grant(authority,qaAuthority,binding.licenseId,request,path.join(bundle,'components',analysis,'content/packages',family),engine).models);
    }
    const executions=path.join(output,'executions.json');require('./solution-admin.cjs').main(['bundle-executions',qaAuthority,bundle,executions]);
    const bindings=JSON.parse(fs.readFileSync(executions));
    authority.solutions(binding.licenseId,{orgId:'p3-qa',entitlements:['ct','mri','xray'].map(analysis=>{
      const solutionId=require('../../desktop/solutions.cjs').resolveSolution(analysis).id,values=bindings.filter(v=>v.solutionId===solutionId);
      return {entitlementId:'p3-'+analysis,solutionId,validFrom:0,validUntil:null,state:'active',revision:1,capabilities:[...new Set(values.map(v=>v.capability))],executions:values};
    })});
    fs.writeFileSync(activation,JSON.stringify(approval));choice=2;assert.equal((await run('window.exmoDesktop.manageLicense()')).state,'VALID');
    pickedFiles=[bundle];const selected=await call('chooseInstallation');assert.ok(selected.choices.every(c=>c.authorized));
    console.log('Installing all three signed selections');const started=performance.now();
    const installed=await call('installSolutions',selected.id,['ct','mri','xray']);assert.ok(installed.solutions.every(s=>s.installed && s.state==='ready'));
    const installationMs=performance.now()-started;
    await run("Array.from(document.querySelectorAll('button')).find(b=>['솔루션 관리','Manage solutions'].includes(b.textContent)).click()");await pause(500);
    fs.writeFileSync(path.join(output,'installation-ui.png'),(await window.webContents.capturePage()).toPNG());
    await run("document.querySelector('[role=dialog] button[aria-label=Close]')?.click()");
    // Escape uses the same accessible Dialog dismissal as the user.
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await pause(300);
    const previous=previousReport?JSON.parse(fs.readFileSync(previousReport)):null,cases={};let samples;
    // Resume failed routes; preserve successful real inference and recheck its saved output after update.
    for(const replay of [false,true]){
      const names=['ct','mri','ap','lat_lt','lat_rt'].filter(name=>Boolean(previous?.cases[name]?.passed)===replay);
      if(!names.length)continue;
      samples=await require('./validate-analysis-samples.cjs').runSamples({sourceRoot,storage:path.join(app.getPath('userData'),'imaging'),output,window,run,pick:files=>{pickedFiles=files;},names,previousReport:replay?previousReport:undefined});
      Object.assign(cases,samples.cases);
    }
    samples={...samples,cases,passed:Object.values(cases).every(c=>c.passed),fullCaseInference:!previousReport,previousReport};
    fs.writeFileSync(path.join(output,'analysis-samples.json'),JSON.stringify(samples,null,2));
    assert.ok(samples.passed,'Actual input pipeline failed; see analysis-samples.json');
    for(const analysis of ['ct','mri','xray'])await call('removeSolution',analysis);
    assert.ok((await call('installations')).solutions.every(s=>!s.installed));
    authority.status(binding.licenseId,'revoked');choice=3;assert.equal((await run('window.exmoDesktop.manageLicense()')).state,'REVOKED');
    for(const item of Object.values(samples.cases)){
      const preview=await call('resultPreview',item.resultId,{view:'axial',opacity:.45});assert.ok(preview.image.startsWith('data:image/png;base64,'));
      const publication=JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'imaging/runs',item.resultId,'published.json')));assert.ok(publication.readerId);
      if(publication.mesh)assert.equal(await run(`fetch('/result/${item.resultId}.glb').then(r=>r.status)`),200);
    }
    pickedFiles=[bundle];const denied=await call('chooseInstallation');assert.ok(denied.choices.every(c=>!c.authorized));
    const rejected=await run(`window.exmoDesktop.installSolutions(${JSON.stringify(denied.id)},['ct'])`);assert.equal(rejected.ok,false);assert.equal(rejected.diagnostic.code,'AUTHORIZATION');
    fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({passed:true,packaged:true,cng:true,dpapi:true,actualInputRoutes:5,selectedInstall:true,readAfterRemovalAndRevocation:true,startup,installationMs,physicalYubiKey:false},null,2));
    console.log('PASS: selected installer, five real routes, removal/revocation preserve saved results. '+output);
  }catch(error){code=1;fs.writeFileSync(path.join(output,'failure.txt'),String(error.stack||error));console.error(error);}
  finally{
    clearTimeout(timeout);if(server?.listening)await new Promise(r=>server.close(r));authority?.close();
    if(installationId)execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`foreach($suffix in @('', '.Model')){$k=[System.Security.Cryptography.CngKey]::Open('EXMO.Atlas.Internal.${installationId}'+$suffix);try{$k.Delete()}finally{$k.Dispose()}}`],{windowsHide:true});
    app.exit(code);
  }
})();
