// Real renderer/3D model, isolated profile and mocked image-menu/preview IPC.
// Usage: electron scripts/validate-image-actions.cjs <local published.json>
const {app,BrowserWindow,ipcMain,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const fixture=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const output=path.join(root,'outputs/image-actions-check');fs.mkdirSync(output,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(output,'userdata-')));
const summary={...fixture.summary,metadata:{...fixture.summary.metadata,caseName:'Fixture'}};
const calls=[];
const png=nativeImage.createFromBuffer(Buffer.from([10,40,150,255]),{width:1,height:1}).toDataURL();
const original=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>original(channel,async(e,...args)=>{
 const operation=channel.replace('exmo:imaging:','');let value;
 if(operation==='status')value={reviewAvailable:true,estimationAvailable:true,device:'CPU'};
 else if(operation==='results')value=args[0]===summary.analysis?[summary]:[];
 else if(operation==='list')value=[];
 else if(operation==='job')value=null;
 else if(operation==='resultPreview')value={image:png,view:args[1]?.view||'axial',index:8,count:16,sides:['R','L','A','P'],metadata:summary.metadata,warnings:[]};
 else if(operation==='imageMenu'){calls.push(args[0]);value={action:'cancel'};}
 else return handler(e,...args);
 return {ok:true,value};
});
const imaging=require('../desktop/imaging.cjs');const install=imaging.installImaging;
imaging.installImaging=(...args)=>{const instance=install(...args);return{...instance,mesh:id=>id===summary.id?fixture.mesh:null};};
require('../desktop/main.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const deadline=setTimeout(()=>app.exit(1),90000);
(async()=>{
 await app.whenReady();const win=BrowserWindow.getAllWindows()[0];win.setSize(1200,900);
 const wc=win.webContents;if(wc.isLoading())await new Promise(r=>wc.once('did-finish-load',r));
 const run=fn=>wc.executeJavaScript(`(${fn})()`);
 const wait=async fn=>{for(let i=0;i<200;i++){if(await run(fn))return;await delay(100);}throw Error('UI timeout: '+fn);};
 await wait(()=>document.querySelector('.recent-section button'));
 await run(()=>document.querySelector('.recent-section button').click());
 await wait(()=>document.querySelector('.medical-image img'));
 await run(()=>document.querySelector('.medical-image').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})));
 await delay(100);assert.equal(calls.length,1);assert.equal(calls[0].image,png,'Save uses the exact displayed composition');
 assert.equal(calls[0].source.kind,'result');assert.equal(calls[0].source.id,summary.id);
 await run(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='3D anatomy').click());
 await wait(()=>document.querySelector('.result-scene canvas')&&!document.querySelector('.scene-loading'));
 await delay(1800);
 const bounds=await run(()=>{const r=document.querySelector('.result-scene canvas').getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};});
 const capture=async()=> (await wc.capturePage(bounds)).toPNG();
 const drag=async button=>{
  const x=bounds.x+Math.round(bounds.width/2),y=bounds.y+Math.round(bounds.height/2);
  wc.sendInputEvent({type:'mouseMove',x,y});wc.sendInputEvent({type:'mouseDown',button,x,y,clickCount:1});
  for(let i=1;i<=8;i++){wc.sendInputEvent({type:'mouseMove',x:x+i*6,y:y+i*2,modifiers:[button==='right'?'rightButtonDown':'middleButtonDown']});await delay(20);}
  wc.sendInputEvent({type:'mouseUp',button,x:x+48,y:y+16,clickCount:1});await delay(800);
 };
 const before=await capture();await drag('middle');const after=await capture();
 assert.ok(!before.equals(after),'Middle drag must move assembled model');
 await run(()=>document.querySelector('.result-scene canvas').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})));
 await delay(100);assert.equal(calls.length,2);assert.match(calls[1].filename,/_3D_/);
 assert.equal(calls[1].source.kind,'result');assert.equal(calls[1].source.id,summary.id);
 const saved=nativeImage.createFromDataURL(calls[1].image);assert.ok(saved.getSize().width>100);
 fs.writeFileSync(path.join(output,'3d-export.png'),saved.toPNG());
 const assembled=calls[1].image;
 await drag('right');
 await run(()=>document.querySelector('.result-scene canvas').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})));
 await delay(100);assert.equal(calls.at(-1).image,assembled,'Assembled right drag no longer pans');
 const menuCount=calls.length;
 await run(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Explode anatomy').click());
 await delay(1800);
 await run(()=>[...document.querySelectorAll('[data-structure]')].find(e=>e.textContent.includes('gluteus maximus')).click());
 await delay(1800);
 const prior=await capture();await drag('right');const rotated=await capture();
 assert.ok(!prior.equals(rotated),'Exploded selected structure still rotates with right drag');
 await run(()=>document.querySelector('.result-scene canvas').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})));
 await delay(100);assert.equal(calls.length,menuCount,'Exploded rotation never opens export menu');
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,checks:['2D displayed PNG forwarded','assembled middle-drag pan','3D nonempty export','exploded right-drag rotation retained','exploded menu suppressed']}));
 console.log('PASS: 2D image action, 3D export, middle-drag pan and preserved exploded right-drag');
 clearTimeout(deadline);app.quit();
})().catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
