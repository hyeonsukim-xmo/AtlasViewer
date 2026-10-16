// Real packaged main/preload/IPC, Windows CNG and DPAPI. Only native file/dialog choices are automated.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {app,BrowserWindow,dialog,safeStorage}=require('electron');
const {Authority,createServer}=require('./license-server.cjs');
const appRoot=path.resolve(process.argv[2] || 'release/internal/win-unpacked/resources/app.asar');
const authorityRoot=path.resolve(process.argv[3] || 'work/security-internal-local/authority');
const output=path.resolve('outputs/security-check',crypto.randomUUID());fs.mkdirSync(output,{recursive:true});
for(const event of ['uncaughtException','unhandledRejection'])process.on(event,error=>{
  fs.writeFileSync(path.join(output,'failure.txt'),String(error?.stack || error));console.error(error);app.exit(1);
});
app.setPath('appData',output);app.setPath('userData',path.join(output,'source'));
const requestFile=path.join(output,'enrollment.json'),activationFile=path.join(output,'activation.json');
let choice=0,installationId,server,authority;
dialog.showMessageBox=async(_window,options)=>{assert.notEqual(options.type,'error',options.message);return {response:choice};};
dialog.showSaveDialog=async()=>({canceled:false,filePath:requestFile});
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[activationFile]});
dialog.showErrorBox=(title,detail)=>{throw Error(`${title}: ${detail}`);};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test){for(let i=0;i<3000;i++){const value=await test();if(value)return value;await wait(100);}throw Error('Packaged UI timed out');}
const timer=setTimeout(()=>{console.error('Internal Electron check timed out');app.exit(1);},360000);

(async()=>{
  let code=0;
  try {
    const build=JSON.parse(fs.readFileSync(path.join(appRoot,'desktop/security/build.json'),'utf8'));
    assert.equal(build.profile,'internal');assert.equal(build.allowLoopback,true);
    authority=new Authority(authorityRoot);assert.equal(authority.publicKey.export({format:'pem',type:'spki'}),build.issuerPublicKey);
    const payloadVerifier=require(path.join(appRoot,'desktop/security/payload.cjs'));
    const probe=path.join(output,'integrity-probe.bin'),original=Buffer.from('verified');fs.writeFileSync(probe,original);
    const expected={path:'integrity-probe.bin',size:original.length,sha256:crypto.createHash('sha256').update(original).digest('hex')};
    payloadVerifier.checkFile(probe,expected);const stamp=fs.statSync(probe);
    fs.writeFileSync(probe,'VERIFIED');fs.utimesSync(probe,stamp.atime,stamp.mtime);
    assert.throws(()=>payloadVerifier.checkFile(probe,expected));fs.unlinkSync(probe);
    server=createServer(authority);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(new URL(build.serverUrl).port),'127.0.0.1',resolve);});
    require(path.join(appRoot,'desktop/main.cjs'));
    await app.whenReady();const window=await until(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('atlas://app/')));
    const run=code=>window.webContents.executeJavaScript(code);
    await until(()=>run('Boolean(document.querySelector(".license-status"))'));
    const startupFile=path.join(app.getPath('userData'),'startup-performance.json');
    await until(()=>fs.existsSync(startupFile));
    const startup=JSON.parse(fs.readFileSync(startupFile));
    assert.equal(startup.status,'ready');assert.equal(startup.profile,'internal');assert.ok(startup.totalMs>0);
    for(const name of ['electronReadyMs','helperIntegrityMs','resultStorageMs','licensingMs','rendererMs'])assert.ok(Number.isFinite(startup.timings[name]) && startup.timings[name]>=0);
    if(fs.existsSync(path.resolve(appRoot,'../engine/payload.json')))assert.ok(startup.timings.payload.files>0 && startup.timings.payload.hashMs>0);
    fs.copyFileSync(startupFile,path.join(output,'startup-performance.json'));
    const initial=await run('window.exmoDesktop.licenseStatus()');assert.equal(initial.state,'UNACTIVATED');
    assert.equal(app.getPath('userData'),path.join(output,'EXMO Atlas Internal'));
    assert.equal(window.webContents.getLastWebPreferences().sandbox,true);
    fs.writeFileSync(path.join(output,'unactivated.png'),(await window.webContents.capturePage()).toPNG());
    choice=1;await run('window.exmoDesktop.manageLicense()');const request=JSON.parse(fs.readFileSync(requestFile));installationId=request.installationId;
    const binding={profile:'internal',licenseId:'electron-'+installationId,installationId,installationKey:request.installationKey};
    authority.approve({binding,installationPublicKey:request.installationPublicKey,engines:['ct','mri','ap','lat'],contractEnd:Math.floor(Date.now()/1000)+3600,graceSeconds:3600,renewSeconds:300});
    fs.writeFileSync(activationFile,JSON.stringify({binding,installationPublicKey:request.installationPublicKey}));
    choice=2;assert.equal((await run('window.exmoDesktop.manageLicense()')).state,'VALID');
    const encrypted=fs.readFileSync(path.join(app.getPath('userData'),'licensing/lease.bin'));
    assert.ok(!encrypted.includes('token'));assert.ok(JSON.parse(safeStorage.decryptString(encrypted)).token);
    await until(()=>run('document.querySelector(".license-status")?.textContent.includes("인증됨") || document.querySelector(".license-status")?.textContent.includes("Authorized")'));
    fs.writeFileSync(path.join(output,'authorized.png'),(await window.webContents.capturePage()).toPNG());
    authority.status(binding.licenseId,'revoked');choice=3;
    assert.equal((await run('window.exmoDesktop.manageLicense()')).state,'REVOKED');
    assert.equal((await run('window.exmoDesktop.results("mri")')).ok,true);
    assert.equal(await run('typeof require'),'undefined');
    fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({packaged:true,cng:true,dpapi:true,activation:true,revocation:true,readableResults:true,gpuInference:false,startupMs:startup.totalMs,payloadFiles:startup.timings.payload?.files ?? 0},null,2));
    console.log('PASS: packaged Internal UI, CNG enrollment, online approval, real DPAPI lease, revocation, readable results. '+output);
  } catch(error){code=1;console.error(error);}
  finally {
    clearTimeout(timer);
    if(server?.listening)await new Promise(resolve=>server.close(resolve));authority?.close();
    if(installationId)execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`foreach($suffix in @('', '.Model')){$k=[System.Security.Cryptography.CngKey]::Open('EXMO.Atlas.Internal.${installationId}'+$suffix);try{$k.Delete()}finally{$k.Dispose()}}`],{windowsHide:true});
    app.exit(code);
  }
})();
