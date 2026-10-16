// Real renderer/preload; deterministic failures replace analysis IPC and result transport only.
const {app,BrowserWindow,ipcMain,protocol}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {diagnose}=require('../desktop/diagnostics.cjs');
const {resultModelResponse}=require('../desktop/result-model-response.cjs');
const root=path.resolve(__dirname,'..'),output=path.join(root,'outputs/error-ui-check');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(output,'userdata-')));
const model=path.join(root,'public/models/exmo-1001921.glb'),data=fs.readFileSync(model);
const gltf=JSON.parse(data.subarray(20,20+data.readUInt32LE(12)).toString());
const rows=gltf.nodes.filter(n=>n.mesh!=null).map((n,i)=>({id:n.name,label:i+1,name:n.name,group:'All',color:'#67aacb',count:10,value:10,present:true}));
const metadata={caseName:'Fixture',studyDescription:'Error isolation test',seriesDescription:'Synthetic',format:'NRRD',size:[16,16,16],spacing:[1,1,1],slices:16};
const meshIssue=diagnose(Error('injected'),{stage:'mesh',code:'MESH_BUILD',caseId:'result-2',logRoot:output});
const cases=Array.from({length:3},(_,i)=>({id:`result-${i}`,inputId:`input-${i}`,name:`Fixture ${i}`,analysis:'ct',metadata:{...metadata,caseName:`Fixture ${i}`},rows,
 unit:'cm³',variant:'raw',route:null,meshBytes:i===2?null:data.length,meshState:i===2?'failed':'ready',meshDiagnostic:i===2?meshIssue:undefined,
 laterality:{method:'femur_components_lps_v1',status:'estimated'},qc:{flags:[],missing:[],unexpected:[]},createdAt:'2026-10-17T00:00:00Z'}));
let broken=true;const failures=[];
const original=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>original(channel,async(event,...args)=>{
 const op=channel.replace('exmo:imaging:','');let value;
 if(op==='status')value={reviewAvailable:true,estimationAvailable:true,device:'CPU'};
 else if(op==='list')value=[];
 else if(op==='results')value=args[0]==='ct'?cases:[];
 else if(op==='job')value=null;
 else if(op==='sceneFailure'){failures.push(args);value=diagnose(Object.assign(Error('renderer'),{reference:args[2],diagnosticCode:args[1]}),{stage:'3D display',caseId:args[0],logRoot:output});}
 else if(op==='resultPreview'){
   if(args[0]==='result-0'){const diagnostic=diagnose(Object.assign(Error('private-patient-path'),{code:'ENOMEM'}),{stage:'preview',caseId:args[0],logRoot:output});return {ok:false,error:diagnostic.message,diagnostic};}
   value={image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',index:8,count:16,view:'axial',sides:[],metadata,warnings:[]};
 }else return handler(event,...args);
 return {ok:true,value};
});
const serve=protocol.handle.bind(protocol);
protocol.handle=(scheme,handler)=>serve(scheme,request=>{
 const match=/^\/result\/(result-\d)\.glb$/.exec(new URL(request.url).pathname);
 return match?resultModelResponse(broken&&match[1]==='result-1'?null:model,output,match[1]):handler(request);
});
require(path.join(root,'desktop/main.cjs'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const deadline=setTimeout(()=>app.exit(1),90000);
(async()=>{
 await app.whenReady();const win=BrowserWindow.getAllWindows()[0];win.hide();const wc=win.webContents;
 if(wc.isLoading())await new Promise(r=>wc.once('did-finish-load',r));
 const run=fn=>wc.executeJavaScript(`(${fn})()`);
 const wait=async fn=>{for(let i=0;i<300;i++){if(await run(fn))return;await sleep(50);}throw Error('UI timeout: '+fn);};
 await wait(()=>document.querySelector('.protocol-table'));
 await run(()=>document.querySelector('.protocol-table tbody tr').click());
 await wait(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='분석 결과3'));
 await run(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='분석 결과3').click());
 await wait(()=>document.querySelector('.results-list tbody button'));
 await run(()=>document.querySelector('.results-list tbody button').click());
 await wait(()=>document.querySelector('.case-canvas [role="alert"]')?.textContent.includes('MEMORY'));
 await run(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('비교 영상 추가 (')).click());
 await wait(()=>document.querySelector('.comparison-dialog')?.open);
 await run(()=>document.querySelector('.comparison-candidates article button').click());
 await wait(()=>document.querySelectorAll('.case-canvas').length===2);
 await run(()=>document.querySelector('.comparison-candidates article button').click());
 await wait(()=>document.querySelectorAll('.case-canvas').length===3);
 await wait(()=>document.querySelector('[data-result-id="result-1"] img')?.naturalWidth>0);
 assert.equal(await run(()=>document.querySelectorAll('.case-canvas [role="alert"]').length),1);
 await run(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='3D anatomy').click());
 await wait(()=>document.querySelector('[data-result-id="result-1"] .scene-error')?.textContent.includes('FILE_MISSING'));
 await wait(()=>document.querySelector('[data-result-id="result-0"] canvas')&&!document.querySelector('[data-result-id="result-0"] .scene-loading'));
 assert.equal(await run(()=>document.querySelectorAll('.scene-error').length),1);
 assert.ok(await run(()=>!document.querySelector('[data-result-id="result-1"] .scene-loading')));
 assert.ok(await run(()=>document.querySelector('[data-result-id="result-2"] [role="status"]')?.textContent.includes('MESH_BUILD')));
 assert.ok(await run(()=>!document.body.textContent.includes('private-patient-path')));
 win.showInactive();await sleep(500);fs.writeFileSync(path.join(output,'case-errors.png'),(await wc.capturePage()).toPNG());
 broken=false;
 await run(()=>document.querySelector('.scene-error button').click());
 await wait(()=>!document.querySelector('[data-result-id="result-1"] .scene-loading')&&!document.querySelector('[data-result-id="result-1"] .scene-error'));
 assert.ok(await run(()=>document.querySelector('[data-result-id="result-1"] canvas')));
 assert.equal(failures.length,1);assert.equal(failures[0][0],'result-1');assert.equal(failures[0][1],'FILE_MISSING');
 assert.ok(fs.readFileSync(path.join(output,'diagnostics-private.jsonl'),'utf8').includes(failures[0][2]));
 console.log('PASS: per-case Overlay/3D errors, healthy comparison remains rendered, failed generation remains reviewable, loading stops, local retry succeeds, diagnostic reference logged');
 clearTimeout(deadline);app.quit();
})().catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
