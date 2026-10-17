// Reopen an isolated P3 test store after models and its temporary CNG keys were removed.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {app,BrowserWindow,dialog}=require('electron');
const childProcess=require('node:child_process'),spawn=childProcess.spawn;let previewStarts=0;
childProcess.spawn=function(file,args,...rest){if(args?.some(a=>String(a).endsWith('imaging-worker.py')))previewStarts++;return spawn.call(this,file,args,...rest);};
const root=path.resolve(__dirname,'../..'),appRoot=path.resolve(process.argv[2]),qa=path.resolve(process.argv[3]);
assert.equal(path.dirname(qa),path.join(root,'outputs/selected-runtime-check'));
const evidence=JSON.parse(fs.readFileSync(path.join(qa,'analysis-samples.json')));assert.ok(evidence.passed);
const repair=process.argv[4]==='--repair-common';
if(repair){
  const store=path.join(qa,'EXMO Atlas Internal/runtime-store'),active=JSON.parse(fs.readFileSync(path.join(store,'active.json')));
  assert.match(active.reader,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const file=path.join(store,'sets',active.reader,'adapters/imaging-worker.py');assert.ok(fs.realpathSync(file).startsWith(qa+path.sep));
  fs.appendFileSync(file,'\n# isolated common-reader corruption fixture\n');
}
app.setPath('appData',qa);app.setPath('userData',path.join(qa,'source'));
dialog.showErrorBox=(title,detail)=>{console.error(title,detail);app.exit(1);};
const timeout=setTimeout(()=>{console.error('Reader restart timed out');app.exit(1);},300000);
require(path.join(appRoot,'desktop/main.cjs'));
(async()=>{
  await app.whenReady();let window;
  for(let i=0;i<1200;i++){
    window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('atlas://app/'));
    if(window && await window.webContents.executeJavaScript('Boolean(window.exmoDesktop && document.querySelector(".license-status"))'))break;
    await new Promise(r=>setTimeout(r,250));
  }
  assert.ok(window);const run=code=>window.webContents.executeJavaScript(code);
  const call=async(method,...args)=>{const reply=await run(`window.exmoDesktop[${JSON.stringify(method)}](...${JSON.stringify(args)})`);assert.equal(reply.ok,true,JSON.stringify(reply));return reply.value;};
  const installations=await call('installations');assert.ok(installations.supported && installations.solutions.every(s=>!s.installed));
  for(const [name,item] of Object.entries(evidence.cases)){
    const rows=await call('results',name==='ct'?'ct':name==='mri'?'mri':'xray'),result=rows.find(r=>r.id===item.resultId);assert.ok(result);
    assert.deepEqual(result.rows.map(r=>[r.id,r.count,r.value]),item.rows.map(r=>[r.id,r.count,r.value]));
    const preview=await call('resultPreview',result.id,{view:'axial',opacity:.45});assert.ok(preview.image.startsWith('data:image/png;base64,'));
    const starts=previewStarts;await call('resultPreview',result.id,{view:'axial',index:Math.min(preview.count-1,preview.index+1),opacity:.3});
    assert.equal(previewStarts,starts,'Scrolling a repaired reader restarted its worker');
    if(item.mesh)assert.equal(await run(`fetch('/result/${result.id}.glb').then(r=>r.status)`),200);
  }
  const startup=JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'startup-performance.json')));
  fs.writeFileSync(path.join(qa,repair?'repair-verification.json':'reopen-verification.json'),JSON.stringify({passed:true,repair,inferenceRerun:false,modelsInstalled:false,routes:5,startup},null,2));
  fs.writeFileSync(path.join(qa,repair?'repair-ui.png':'reopen-ui.png'),(await window.webContents.capturePage()).toPNG());
  console.log('PASS: '+(repair?'repaired reader, ':'')+'restart without models/temporary license keys, five preserved results; startup '+Math.round(startup.totalMs)+' ms');
  clearTimeout(timeout);app.quit();
})().catch(error=>{console.error(error);clearTimeout(timeout);app.exit(1);});
