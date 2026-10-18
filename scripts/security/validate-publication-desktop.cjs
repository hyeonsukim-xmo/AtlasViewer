// Isolated real Electron IPC/DPAPI + existing QA result + synthetic OIDC/result service.
const {app,BrowserWindow,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const F=require('./publication-test-fixtures.cjs');
const {verifyPending}=require('./result-verifier.cjs');
const qa=path.resolve('outputs/selected-runtime-check/785af919-05cd-48d4-b000-7f73c20354ed/EXMO Atlas Internal');
const output=path.resolve('outputs/publication-desktop-check',crypto.randomUUID());fs.mkdirSync(output,{recursive:true});
app.setPath('userData',path.join(output,'electron'));fs.mkdirSync(app.getPath('userData'));fs.copyFileSync(path.join(qa,'Local State'),path.join(app.getPath('userData'),'Local State'));
const finishes=[],context={after:fn=>finishes.push(fn)};let account,imaging,sync;
const accountModule=require('../../desktop/security/account.cjs'),bridge={status:()=>account?.status()??{state:'unconfigured',me:null,workspace:null},close(){}};
for(const name of ['login','logout','refresh','workspace','enroll','enrollments','decide','activate','solution','publicationRequest'])bridge[name]=(...args)=>account[name](...args);
accountModule.openAccount=()=>bridge;
const im=require('../../desktop/imaging.cjs'),install=im.installImaging;
im.installImaging=(window,options)=>{const keyStore=require('../../desktop/security/result-storage.cjs').openResultStorage(path.join(qa,'result-security'),safeStorage);
  const archived=process.argv.includes('--archived-reader')?require('../../desktop/security/installations.cjs').openInstallations({root:path.join(qa,'runtime-store'),issuer:crypto.createPublicKey(fs.readFileSync(path.join(qa,'../authority/issuer-public.pem'))),profile:'internal'}):null;
  imaging=install(window,{...options,...(archived?{installations:{...archived,collect:async()=>{}}}:{}),storageRoot:path.join(qa,'imaging'),originStoreId:keyStore.id(),artifactStorage:keyStore.bootstrap(path.join(qa,'imaging/runs'))});return imaging;};
const sy=require('../../desktop/sync.cjs'),open=sy.openSync;sy.openSync=options=>{sync=open(options);return sync;};
require('../../desktop/main.cjs');
const timeout=setTimeout(()=>{console.error('PUBLICATION_DESKTOP_TIMEOUT');app.exit(1);},120000);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function run(){
  await app.whenReady();const f=await F.fixture(context);account=f.account;
  let window;for(let i=0;i<200;i++){window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('atlas://app'));if(window && !window.webContents.isLoading())break;await delay(50);}
  assert.ok(window);window.show();const c=window.webContents;
  const call=async(name,...args)=>{const reply=await c.executeJavaScript(`window.exmoDesktop[${JSON.stringify(name)}](...${JSON.stringify(args)})`);assert.equal(reply.ok,true,JSON.stringify(reply));return reply.value;};
  const rows=await call('results','mri'),result=rows[0];assert.ok(result.analysisRevision);
  const ref={id:result.id,revision:result.analysisRevision};await call('syncApproveOrigin',ref);await call('syncEnqueue',[ref]);
  let state;
  for(let i=0;i<160;i++){await verifyPending(f.root,f.keys);await sync.tick();state=await call('syncStatus');
    assert.ok(!['failed','needs_permission','quota_blocked'].includes(state.jobs[0].state),JSON.stringify(state));
    if(state.jobs[0].state==='published' && state.jobs[0].meshState==='ready')break;await delay(250);}
  assert.equal(state.jobs[0].meshState,'ready');assert.equal((await f.rpc('list')).length,1);
  await c.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>['전송 현황','Transfers'].includes(b.textContent)).click()`);await delay(600);
  assert.equal(await c.executeJavaScript('typeof window.require'),'undefined');
  assert.ok(await c.executeJavaScript(`document.body.textContent.includes('게시 완료')||document.body.textContent.includes('Published')`));
  fs.writeFileSync(path.join(output,'transfers.png'),(await c.capturePage()).toPNG());
  fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({passed:true,syntheticIdp:true,localTestServer:true,existingMRI:true,realWorkerExport:true,realDpapi:true,realRendererIPC:true,metricsBeforeMesh:true,archivedReader:process.argv.includes('--archived-reader'),inferenceRerun:false},null,2));
  console.log('PASS: real Desktop worker → encrypted upload → verified result + later 3D; sandboxed transfer UI');
  await sync.close();await imaging.dispose();for(const finish of finishes.reverse())await finish();
}
app.once('will-quit',()=>{clearTimeout(timeout);const file=path.join(output,'verification.json');if(fs.existsSync(file)){const value=JSON.parse(fs.readFileSync(file));fs.writeFileSync(file,JSON.stringify({...value,gracefulQuit:true},null,2));}});
run().then(()=>app.quit()).catch(e=>{console.error(e);clearTimeout(timeout);app.exit(1);});
