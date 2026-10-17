const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const P=require('../../desktop/security/license-protocol.cjs');
const {read,atomicWrite}=require('../../desktop/security/storage.cjs');
const {validateBuild}=require('../../desktop/security/runtime.cjs');
const {hashFile,verifyPayload}=require('../../desktop/security/payload.cjs');
const M=require('../../desktop/security/model-package.cjs');
const S=require('../../desktop/security/selection.cjs');
function verifySelectionBundle(directory,issuer,profile){
  const catalog=S.catalog(directory,issuer,profile),policy=S.selection(catalog.sets.reader,issuer,profile);
  const component=S.component(path.join(directory,'components/common'),issuer,policy.components.common,'common',profile);
  S.exactInventory(path.join(directory,'components/common/content'),component.records);
  for(const r of component.records)require('../../desktop/security/payload.cjs').checkFile(path.join(directory,'components/common/content',r.path),r);
}
const root=path.resolve(__dirname,'../..');
const protectedPython=['model-runner.py','model_security.py'];
function frozenPython(name) {
  const source=fs.readFileSync(path.join(root,'desktop',name),'utf8');
  P.check(source.split('PROTECTED_MRI = False').length===2,'Unexpected worker build marker');
  return source.replace('PROTECTED_MRI = False','PROTECTED_MRI = True');
}
function releasePolicy(profile,config) {
  P.check(profile==='internal' || profile==='customer','Explicit internal/customer build profile required');
  const build=validateBuild(config);P.check(build.profile===profile,'Build profile mismatch');return build;
}
function guard(context) {
  // Also runs for direct electron-builder calls; a missing policy cannot silently produce an unguarded package.
  const files=context.packager.config.files ?? [];
  const entry=files.find(item=>typeof item==='object' && item.to==='desktop/security' && JSON.stringify(item.filter)==='["build.json","runtime-integrity.json"]');
  P.check(entry && path.resolve(entry.from)===path.join(root,'work/security-build'),'Use desktop:pack:internal with a reviewed build configuration');
  const configured=JSON.parse(read(path.join(entry.from,'build.json')));
  const policy=releasePolicy(configured.profile,configured);
  const worker=context.packager.config.extraResources?.find(item=>item.to==='imaging' && JSON.stringify(item.filter)===JSON.stringify(['model-policy.json',...protectedPython]));
  P.check(worker && path.resolve(worker.from)===path.resolve(entry.from),'Protected worker policy must be packaged');
  P.check(JSON.stringify(JSON.parse(read(path.join(worker.from,'model-policy.json'))))===JSON.stringify({profile:policy.profile,issuerPublicKey:policy.issuerPublicKey,...(policy.licenseVersion!==undefined?{licenseVersion:policy.licenseVersion}:{})}),'Worker policy mismatch');
  for(const name of protectedPython)P.check(fs.readFileSync(path.join(worker.from,name),'utf8')===frozenPython(name),'Protected worker build differs');
  P.check(context.packager.config.appId===(policy.profile==='internal'?'com.exmo.atlas.internal':'com.exmo.atlas'),'Build application identity differs');
  if(policy.profile==='customer' || policy.licenseVersion===3)P.check(context.packager.config.extraResources.some(item=>item.to==='engine'),'Customer payload required');
}
async function main([profile,target,configFile,payloadRoot]) {
  P.check(['dir','nsis'].includes(target));
  const policy=releasePolicy(profile,configFile?JSON.parse(read(configFile)):undefined);
  if(profile==='customer' || policy.licenseVersion===3)P.check(payloadRoot,'Customer builds require a signed offline engine payload');
  const selected=payloadRoot && fs.existsSync(path.join(payloadRoot,'catalog.json'));
  if(selected){P.check(policy.licenseVersion===3,'Selected packages require v3');verifySelectionBundle(payloadRoot,require('node:crypto').createPublicKey(policy.issuerPublicKey),profile);}
  else if(payloadRoot)P.check(verifyPayload(payloadRoot,require('node:crypto').createPublicKey(policy.issuerPublicKey)).profile===profile,'Payload belongs to another build profile');
  // Runtime executables are already covered by the issuer signature; re-signing would change their hashes.
  const runtimeRecords=payloadRoot?JSON.parse(fs.readFileSync(path.join(payloadRoot,selected?'components/common/files.json':'files.json'))):[];
  const signExts=[...new Set(runtimeRecords.filter(r=>r.path.endsWith('.exe')).map(r=>'!'+path.basename(r.path)))];
  if(profile==='customer' && target==='nsis')P.check(process.env.CSC_LINK || process.env.WIN_CSC_LINK || process.env.EXMO_SIGNING_CERTIFICATE_SHA1,'Customer installer requires an actual code-signing certificate; use customer dir for an unsigned QA candidate');
  const stage=path.join(root,'work/security-build');fs.mkdirSync(stage,{recursive:true});
  const lock=path.join(stage,'build.lock');const fd=fs.openSync(lock,'wx');
  try {
    const policyFile=path.join(stage,'build.json');atomicWrite(policyFile,JSON.stringify(policy));
    atomicWrite(path.join(stage,'model-policy.json'),JSON.stringify({profile:policy.profile,issuerPublicKey:policy.issuerPublicKey,...(policy.licenseVersion!==undefined?{licenseVersion:policy.licenseVersion}:{})}));
    for(const name of protectedPython)atomicWrite(path.join(stage,name),frozenPython(name));
    for(const args of [['node_modules/vite/bin/vite.js','build','--mode','desktop'],['--experimental-strip-types','scripts/write-imaging-palette.mjs']]) {
      const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true});
      P.check(result.status===0,'Desktop assets build failed');
    }
    const integrity={};
    for(const name of fs.readdirSync(path.join(root,'desktop')).filter(name=>name.endsWith('.py')))
      integrity['imaging/'+name]=M.hash(Buffer.from(protectedPython.includes(name)?frozenPython(name):fs.readFileSync(path.join(root,'desktop',name))));
    for(const name of ['model-policy.json'])integrity['imaging/'+name]=hashFile(path.join(stage,name)).sha256;
    integrity['security/windows-key.ps1']=hashFile(path.join(root,'desktop/security/windows-key.ps1')).sha256;
    for(const name of fs.readdirSync(path.join(root,'scripts/security/trust')).filter(name=>name.endsWith('.crt')))
      integrity['imaging/trust/'+name]=hashFile(path.join(root,'scripts/security/trust',name)).sha256;
    atomicWrite(path.join(stage,'runtime-integrity.json'),JSON.stringify(integrity));
    const {build,Platform,Arch}=require('electron-builder');
    await build({targets:Platform.WINDOWS.createTarget(target,Arch.x64),config:{extends:null,
      appId:profile==='internal'?'com.exmo.atlas.internal':'com.exmo.atlas',productName:profile==='internal'?'EXMO Atlas Internal':'EXMO Atlas',
      directories:{output:'release/'+profile},
      // electron-builder concatenates arrays with package.json; pass only the added resources.
      files:[{from:stage,to:'desktop/security',filter:['build.json','runtime-integrity.json']}],
      extraResources:[{from:stage,to:'imaging',filter:['model-policy.json',...protectedPython]},
        {from:path.join(root,'scripts/security/trust'),to:'imaging/trust',filter:['*.crt']},
        ...(payloadRoot?[{from:path.resolve(payloadRoot),to:'engine',filter:selected?['catalog.json','components/*/component.json','components/*/files.json','components/common/content/**/*']:['**/*']}]:[])],
      electronFuses:{runAsNode:false,enableNodeOptionsEnvironmentVariable:false,enableNodeCliInspectArguments:false,
        enableEmbeddedAsarIntegrityValidation:true,onlyLoadAppFromAsar:true},
      forceCodeSigning:profile==='customer' && target==='nsis',
      win:{signExts,...(process.env.EXMO_SIGNING_CERTIFICATE_SHA1?{signtoolOptions:{certificateSha1:process.env.EXMO_SIGNING_CERTIFICATE_SHA1}}:{})},
      nsis:{perMachine:profile==='customer',artifactName:profile==='internal'?'EXMO-Atlas-Internal-Setup-${version}.${ext}':'EXMO-Atlas-Setup-${version}.${ext}'},
    }});
    const directory=path.join(root,'release',profile,'win-unpacked');verifyPackage(directory,policy);
    if(profile==='customer' && target==='nsis') {
      const file=path.join(root,'release/customer',`EXMO-Atlas-Setup-${require('../../package.json').version}.exe`);
      const check=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','$s=Get-AuthenticodeSignature -LiteralPath $env:EXMO_CHECK_SIGNED_FILE; if($s.Status -ne "Valid"){exit 1}'],{env:{...process.env,EXMO_CHECK_SIGNED_FILE:file},windowsHide:true});
      P.check(check.status===0,'Customer installer signature verification failed');
    }
  } finally {fs.closeSync(fd);fs.rmSync(lock,{force:true});}
}
function verifyPackage(directory,policy) {
  const asar=require('@electron/asar'),archive=path.join(directory,'resources/app.asar');
  const files=asar.listPackage(archive).map(file=>file.replaceAll('\\','/'));
  P.check(!files.some(file=>/issuer-private|SIMULATED|license-server|internal-admin|authority.sqlite|\/work\/|\/scripts\//.test(file)),'Forbidden server/development file in package');
  const actual=validateBuild(JSON.parse(asar.extractFile(archive,path.join('desktop','security','build.json'))));
  P.check(JSON.stringify(actual)===JSON.stringify(policy),'Packaged build policy differs');
  P.check(fs.existsSync(path.join(directory,'resources/security/windows-key.ps1')) &&
    fs.existsSync(path.join(directory,'resources/imaging/model-runner.py')),'Runtime resource missing');
  const workerPolicy=JSON.parse(read(path.join(directory,'resources/imaging/model-policy.json')));
  P.check(JSON.stringify(workerPolicy)===JSON.stringify({profile:policy.profile,issuerPublicKey:policy.issuerPublicKey,...(policy.licenseVersion!==undefined?{licenseVersion:policy.licenseVersion}:{})}),'Worker trust differs from application trust');
  for(const name of protectedPython)P.check(fs.readFileSync(path.join(directory,'resources/imaging',name),'utf8')===frozenPython(name),'Packaged protected worker differs');
  const integrity=JSON.parse(asar.extractFile(archive,path.join('desktop','security','runtime-integrity.json')));
  for(const [file,digest] of Object.entries(integrity))P.check(hashFile(path.join(directory,'resources',file)).sha256===digest,'Packaged worker integrity mismatch');
  if(policy.profile==='customer' || policy.licenseVersion===3){
    const engine=path.join(directory,'resources/engine'),issuer=require('node:crypto').createPublicKey(policy.issuerPublicKey);
    if(fs.existsSync(path.join(engine,'catalog.json')))verifySelectionBundle(engine,issuer,policy.profile);else verifyPayload(engine,issuer);
  }
  console.log('Verified internal package: pinned build policy, CNG helper, no authority/simulated private keys.');
}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exit(1);});
module.exports=guard;
module.exports.releasePolicy=releasePolicy;
module.exports.main=main;
module.exports.verifyPackage=verifyPackage;
