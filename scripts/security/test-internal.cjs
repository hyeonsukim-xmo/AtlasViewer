const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const P=require('../../desktop/security/license-protocol.cjs');
const {openLicensing,loadBuild,validateBuild}=require('../../desktop/security/runtime.cjs');
const {WindowsKey}=require('../../desktop/security/windows-key.cjs');
const {protectedStore}=require('../../desktop/security/storage.cjs');
const guard=require('./package.cjs');
const {Authority,createServer,main:serverCommand}=require('./license-server.cjs');
const {main:admin}=require('./internal-admin.cjs');

function temporary(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'exmo-internal-'));
  t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});return root;
}
const issuer=()=>crypto.generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'});
const config=()=>({profile:'internal',issuerPublicKey:issuer(),serverUrl:'https://licenses.example.invalid/',allowLoopback:false});

test('packaged builds fail closed; build trust never comes from admin flags, activation or environment',t=>{
  const root=temporary(t),file=path.join(root,'build.json');
  assert.equal(loadBuild(false,file).profile,'development');assert.throws(()=>loadBuild(true,file));
  const good=config();fs.writeFileSync(file,JSON.stringify(good));assert.deepEqual(loadBuild(true,file),good);
  for(const change of [{profile:'development'},{admin:true},{skipLicense:true},{serverUrl:'http://lan-server/'},{issuerPublicKey:'private'}]){
    fs.writeFileSync(file,JSON.stringify({...good,...change}));assert.throws(()=>loadBuild(true,file));
  }
  assert.throws(()=>validateBuild({...good,profile:'customer',allowLoopback:true}));
  assert.throws(()=>guard.releasePolicy('customer',good),/mismatch/);
  assert.equal(guard.releasePolicy('customer',{...good,profile:'customer'}).profile,'customer');
  assert.deepEqual(guard.releasePolicy('internal',good),good);
  assert.throws(()=>guard({packager:{config:{files:[]}}}),/desktop:pack:internal/);
});

test('protected state has no plaintext fallback, handles missing files and rejects tampering',t=>{
  const root=temporary(t),file=path.join(root,'state');
  // Platform encryption itself is exercised by validate-internal-electron.cjs.
  const seal=crypto.randomBytes(32);
  const safe={isEncryptionAvailable:()=>true,encryptString:plain=>{
    const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',seal,nonce);
    return Buffer.concat([nonce,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);
  },decryptString:bytes=>{
    const cipher=crypto.createDecipheriv('aes-256-gcm',seal,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(12,-16)),cipher.final()]).toString();
  }};
  const store=protectedStore(file,safe);assert.equal(store.read(),null);store.write({token:'signed-license'});
  assert.deepEqual(store.read(),{token:'signed-license'});assert.ok(!fs.readFileSync(file).includes('signed-license'));
  const bytes=fs.readFileSync(file);bytes[15]^=1;fs.writeFileSync(file,bytes);assert.throws(()=>store.read());
  const disabled=protectedStore(file,{isEncryptionAvailable:()=>false});assert.throws(()=>disabled.write({token:'no'}));assert.throws(()=>disabled.read());
});

test('real Windows CNG enrollment, server approval, no-dongle activation, restart and revocation', {skip:process.platform!=='win32'},async t=>{
  const root=temporary(t),serverDir=path.join(root,'authority'),directory=path.join(root,'client');
  serverCommand(['init',serverDir,'internal']);const authority=new Authority(serverDir),server=createServer(authority);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const build={profile:'internal',issuerPublicKey:authority.publicKey.export({format:'pem',type:'spki'}),serverUrl:`http://127.0.0.1:${server.address().port}`,allowLoopback:true};
  // Persistence adapter only: a separate Electron integration check exercises actual DPAPI.
  const safeStorage={isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(text),decryptString:bytes=>bytes.toString()};
  let runtime,id;
  try {
    runtime=await openLicensing({build,directory,key:new WindowsKey(),safeStorage});
    assert.equal(runtime.status().state,'UNACTIVATED');const request=runtime.enrollment();id=request.installationId;
    await assert.rejects(runtime.authorize({runId:crypto.randomUUID(),engine:'ct'}),/UNACTIVATED/);
    const requestFile=path.join(root,'request.json'),activationFile=path.join(root,'activation.json');fs.writeFileSync(requestFile,JSON.stringify(request));
    admin(['approve',serverDir,requestFile,'dev-workstation',new Date(Date.now()+86400*30*1000).toISOString().replace(/\.\d{3}Z$/,'Z'),'ct,mri,ap,lat']);
    admin(['activation',serverDir,'dev-workstation',activationFile]);
    const activation=JSON.parse(fs.readFileSync(activationFile));
    await assert.rejects(runtime.activate({...activation,admin:true}));
    await assert.rejects(runtime.activate({...activation,binding:{...activation.binding,installationId:crypto.randomUUID()}}));
    await runtime.activate(activation);assert.equal(runtime.status().state,'VALID');
    for(const engine of [...P.ENGINES,'xray-classifier'])assert.equal((await runtime.authorize({runId:crypto.randomUUID(),engine})).engine,engine);
    runtime.close();runtime=await openLicensing({build,directory,key:new WindowsKey(),safeStorage});
    await runtime.refresh();assert.equal(runtime.status().state,'VALID');
    const checkExport=`$k=[System.Security.Cryptography.CngKey]::Open('EXMO.Atlas.Internal.${id}');try{$null=$k.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPrivateBlob);exit 9}catch{[Console]::Write('blocked')}finally{$k.Dispose()}`;
    assert.equal(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',checkExport],{windowsHide:true,encoding:'utf8'}),'blocked');
    authority.status('dev-workstation','revoked');await runtime.refresh();assert.equal(runtime.status().state,'REVOKED');
    await assert.rejects(runtime.authorize({runId:crypto.randomUUID(),engine:'mri'}),/REVOKED/);
    const settings=path.join(serverDir,'authority.json');fs.writeFileSync(settings,JSON.stringify({profile:'customer'}));
    assert.throws(()=>new Authority(serverDir),/profile/);
  } finally {
    runtime?.close();await new Promise(resolve=>server.close(resolve));authority.close();
    if(id)execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`foreach($suffix in @('', '.Model')){$k=[System.Security.Cryptography.CngKey]::Open('EXMO.Atlas.Internal.${id}'+$suffix);try{$k.Delete()}finally{$k.Dispose()}}`],{windowsHide:true});
  }
});
