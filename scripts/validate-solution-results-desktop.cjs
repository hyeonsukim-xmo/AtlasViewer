// Real saved CT/MRI/AP/LAT-LT/LAT-RT outputs, real Electron IPC and preview worker; no inference.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {app,BrowserWindow}=require('electron');
const root=path.resolve(__dirname,'..'),output=path.join(root,'outputs/solution-productization-check');
fs.mkdirSync(output,{recursive:true});
const source=path.resolve(process.env.EXMO_SOLUTION_RESULT_SOURCE || path.join(root,'outputs/imaging-check/userdata/imaging'));
const temporary=fs.mkdtempSync(path.join(output,'userdata-')),storage=path.join(temporary,'imaging');
app.setPath('userData',temporary);
process.env.EXMO_ENGINE_ROOT ||= path.join(root,'work/modality-integration');
const wanted=['ct','mri','AP','LAT_LT','LAT_RT'], originals=new Map(), cases=new Map();
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function copy(from,to) {
  originals.set(from,hash(from));fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);return to;
}
for(const id of fs.readdirSync(path.join(source,'runs'))) {
  const file=path.join(source,'runs',id,'published.json');if(!fs.existsSync(file))continue;
  const saved=JSON.parse(fs.readFileSync(file,'utf8')), summary=saved.summary;
  const route=summary.analysis==='xray'?summary.route:summary.analysis;
  if(!wanted.includes(route)||cases.has(route)||!fs.existsSync(saved.record.input))continue;
  originals.set(file,hash(file));
  const folder=path.join(storage,'runs',id);fs.mkdirSync(folder,{recursive:true});
  saved.result=path.join(folder,'artifacts');fs.mkdirSync(saved.result);
  for(const key of ['mask','sideMask','mesh'])if(saved[key]) saved[key]=copy(saved[key],path.join(saved.result,key,path.basename(saved[key])));
  saved.record.input=copy(saved.record.input,path.join(storage,'imports',summary.inputId,path.basename(saved.record.input)));
  if(summary.analysis==='mri') {
    const original=JSON.parse(fs.readFileSync(file,'utf8'));
    copy(path.join(original.result,'raw/metrics.json'),path.join(saved.result,'raw/metrics.json'));
  }
  fs.writeFileSync(path.join(folder,'published.json'),JSON.stringify(saved));cases.set(route,saved);
}
assert.deepEqual([...cases.keys()].sort(),[...wanted].sort(),'Five saved real routes are required');
const snapshots=new Map([...cases.values()].map(item=>[path.join(storage,'runs',item.summary.id,'published.json'),hash(path.join(storage,'runs',item.summary.id,'published.json'))]));
const consoleErrors=[];
app.on('web-contents-created',(_,wc)=>wc.on('console-message',(_,details)=>{if(details.level==='error')consoleErrors.push(details.message);}));
require(path.join(root,'desktop/main.cjs'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deadline=setTimeout(()=>{console.error('Saved result check timed out');app.exit(1);},180000);
(async()=>{
  const report={at:new Date().toISOString(),inference:false,cases:[],passed:false};
  report.sourceFiles=[...originals].map(([file,sha256])=>({file,sha256}));
  await app.whenReady();const window=BrowserWindow.getAllWindows()[0];window.hide();const wc=window.webContents;
  if(wc.isLoading())await new Promise(resolve=>wc.once('did-finish-load',resolve));
  const run=(fn,...args)=>wc.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`);
  const call=async(name,...args)=>{
    const reply=await run(async(name,args)=>window.exmoDesktop[name](...args),name,args);assert(reply.ok,reply.error);return reply.value;
  };
  const wait=async fn=>{for(let i=0;i<300;i++){if(await run(fn))return;await pause(50);}throw Error('Saved result UI timeout');};
  await wait(()=>document.querySelectorAll('.protocol-table tbody tr').length===3);
  const registry=await call('solutions');assert.equal(registry.length,3);
  for(const route of wanted) {
    const source=cases.get(route),solution=registry.find(item=>item.analysis===source.summary.analysis);
    const started=performance.now(),rows=await call('results',solution.id),result=rows.find(row=>row.id===source.summary.id);
    assert(result && result.analysisRevision && !result.identityDiagnostic);
    assert.deepEqual(result.rows.map(row=>[row.id,row.count,row.value]),source.summary.rows.map(row=>[row.id,row.count,row.value]));
    const repeated=(await call('results',solution.id)).find(row=>row.id===result.id);
    assert.equal(result.analysisRevision,repeated.analysisRevision);
    for(const view of source.summary.analysis==='xray'?['axial']:['axial','coronal','sagittal']) {
      const preview=await call('resultPreview',result.id,{view,index:1,opacity:.45});
      assert(preview.image.startsWith('data:image/png;base64,'));assert(preview.count>0);
    }
    if(source.mesh)assert(await run(async id=>(await fetch(`atlas://app/result/${id}.glb`)).ok,result.id));
    report.cases.push({route,solutionId:solution.id,originResultId:result.originResultId,analysisRevision:result.analysisRevision,
      measurementsUnchanged:true,preview:true,mesh:Boolean(source.mesh),elapsedMs:Math.round(performance.now()-started)});
  }
  await wait(()=>document.querySelectorAll('.recent-section tbody tr').length>0);
  window.showInactive();await pause(500);
  fs.writeFileSync(path.join(output,'home.png'),(await wc.capturePage()).toPNG());
  for(const analysis of ['ct','mri','xray']) {
    await run(()=>document.querySelector('.desktop-brand').click());
    await run(name=>[...document.querySelectorAll('.protocol-table button')].find(button=>button.getAttribute('aria-label')?.startsWith(name+' ')).click(),{ct:'CT',mri:'MRI',xray:'X-ray'}[analysis]);
    await wait(()=>document.querySelector('.desktop-workspace:not([hidden])'));
    assert(await run(()=>document.querySelector('.desktop-workspace:not([hidden])').textContent.length>0));
  }
  for(const [file,digest] of [...originals,...snapshots])assert.equal(hash(file),digest,'Original or copied publication changed');
  assert.deepEqual(consoleErrors,[]);
  report.passed=true;report.originalFilesUnchanged=originals.size;
  fs.writeFileSync(path.join(output,'saved-results.json'),JSON.stringify(report,null,2));
  console.log('PASS: real saved five routes, registry/preload/IPC, exact measurements, 9 native previews, CT/MRI GLB, original files unchanged');
  clearTimeout(deadline);app.removeAllListeners('window-all-closed');window.close();await pause(1000);
  // Chromium retains its cache handles until process exit; remove the medical fixture separately.
  assert(path.resolve(storage).startsWith(path.resolve(output)+path.sep));fs.rmSync(storage,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  app.quit();
})().catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
