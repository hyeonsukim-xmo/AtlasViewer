// Isolated UI/DPAPI/ASAR validation with a synthetic IdP; does not alter the installed application.
const {app,BrowserWindow,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const fixture=require('./account-test-fixtures.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'exmo-account-desktop-')),cleanup=[];
app.setPath('userData',path.join(root,'user'));fs.mkdirSync(app.getPath('userData'),{recursive:true});
const output=path.resolve('outputs/account-check');fs.mkdirSync(output,{recursive:true});
const contexts={after:fn=>cleanup.push(fn)};
const timeout=setTimeout(()=>{console.error('Account desktop check timed out');app.exit(1);},60000);
let active;
const bridge={status:()=>active?.status()??{state:'signed-out',me:null,workspace:null},close:()=>active?.close()};
for(const name of ['login','logout','refresh','workspace','enroll','enrollments','decide','activate','solution'])bridge[name]=(...args)=>active[name](...args);
require('../../desktop/security/account.cjs').openAccount=()=>bridge;
require('../../desktop/main.cjs');
async function verify(){
  const f=await fixture.setup(contexts),licensing=await fixture.device(contexts,f);
  const archive=path.resolve(process.argv[2]||'work/p4-package-check/win-unpacked/resources/app.asar');
  assert.ok(fs.existsSync(archive),'Build an isolated package before ASAR validation');
  const {openAccount}=require(path.join(archive,'desktop/security/account.cjs'));
  await app.whenReady();
  active=openAccount({config:f.config,directory:path.join(root,'account'),safeStorage,openExternal:f.idp.browser,licensing,allowLoopback:true});
  const signed=await active.login();assert.equal(signed.me.subject,'manager');
  const cache=fs.readFileSync(path.join(root,'account/session.bin'));assert.ok(!cache.includes(f.idp.settings.issued[0]));
  await active.workspace('hospital-a','research');const row=await active.enroll();fixture.prepare(f,await licensing.enrollment(),row);
  active.logout();f.idp.settings.subject='operator';
  // The real renderer/preload/IPC use an isolated account instance; no test mode ships in production.
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  let window;
  for(let i=0;i<200;i++){window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('atlas://app'));if(window && !window.webContents.isLoading())break;await delay(50);}
  assert.ok(window);window.show();const c=window.webContents;
  const run=fn=>c.executeJavaScript(`(${fn})()`);
  for(let i=0;i<100;i++){if(await run(()=>document.querySelector('.desktop-nav')))break;await delay(50);}
  await run(()=>{[...document.querySelectorAll('button')].find(b=>['계정','Account'].includes(b.textContent)).click();});
  await delay(150);
  await run(()=>{[...document.querySelectorAll('button')].find(b=>['브라우저에서 로그인','Sign in with browser'].includes(b.textContent)).click();});
  for(let i=0;i<150;i++){if(await run(()=>document.body.textContent.includes('EXMO 운영 관리')||document.body.textContent.includes('EXMO operations')))break;await delay(50);}
  assert.ok(await run(()=>document.body.textContent.includes('EXMO 운영 관리')||document.body.textContent.includes('EXMO operations')));
  await run(()=>{[...document.querySelectorAll('button')].find(b=>['내부용 면제 승인','Approve internal exemption'].includes(b.textContent)).click();});
  for(let i=0;i<100;i++){if(f.accounts.row(row.id).state==='approved')break;await delay(50);}
  assert.equal(f.accounts.row(row.id).state,'approved');
  for(let i=0;i<100;i++){if(await run(()=>!!document.querySelector('.account-solution:not(:disabled)')))break;await delay(50);}
  await run(()=>document.querySelector('.account-solution').click());
  for(let i=0;i<100;i++){if(f.accounts.dto(f.accounts.row(row.id)).solutions[0].state==='suspended')break;await delay(50);}
  assert.equal(f.accounts.dto(f.accounts.row(row.id)).solutions[0].state,'suspended');
  assert.equal(await run(()=>typeof window.require),'undefined');
  await delay(500);
  fs.writeFileSync(path.join(output,'operator.png'),(await c.capturePage()).toPNG());
  await run(()=>{[...document.querySelectorAll('button')].find(b=>['로그아웃','Sign out'].includes(b.textContent)).click();});await delay(100);
  assert.equal(active.status().me,null);
  fs.writeFileSync(path.join(output,'signed-out.png'),(await c.capturePage()).toPNG());
  fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({asar:archive,oidcPkce:true,dpapi:true,operatorUi:true,logout:true,sandbox:true,syntheticIdp:true},null,2));
}
verify().then(async()=>{active?.close();for(const finish of cleanup.reverse())await finish();console.log('PASS: packaged OIDC dependencies, real Electron DPAPI, sandboxed operator account UI and logout');clearTimeout(timeout);app.exit(0);}).catch(error=>{console.error(error);clearTimeout(timeout);app.exit(1);});
