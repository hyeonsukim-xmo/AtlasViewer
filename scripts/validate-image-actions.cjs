// Real renderer/models with isolated data; menu IPC captured for pixel/source checks.
const {app,BrowserWindow,ipcMain,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),fixture=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const output=path.join(root,'outputs/image-actions-check');fs.mkdirSync(output,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(output,'userdata-')));
const summary={...fixture.summary,metadata:{...fixture.summary.metadata,caseName:'Fixture'}};
const comparison={...summary,id:'aaaaaaaa-0000-4000-8000-000000000002',metadata:{...summary.metadata,caseName:'Comparison fixture'}};
const calls=[],png=nativeImage.createFromBuffer(Buffer.from([10,40,150,255]),{width:1,height:1}).toDataURL();
const pixelsEqual=(a,b,label)=>{
 const x=nativeImage.createFromDataURL(a),y=nativeImage.createFromDataURL(b),aa=x.toBitmap(),bb=y.toBitmap();
 assert.deepEqual(x.getSize(),y.getSize());
 let changed=0,large=0,total=0;for(let i=0;i<aa.length;i+=4){let delta=0;for(let j=0;j<3;j++)delta=Math.max(delta,Math.abs(aa[i+j]-bb[i+j]));if(delta)changed++;if(delta>20)large++;total+=delta;}
 console.log(label,JSON.stringify({changed:changed/(aa.length/4),large:large/(aa.length/4),mean:total/(aa.length/4)}));
 fs.writeFileSync(path.join(output,'before.png'),x.toPNG());fs.writeFileSync(path.join(output,'after.png'),y.toPNG());
 assert.ok(aa.equals(bb),label);
};
const original=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>original(channel,async(e,...args)=>{
 const operation=channel.replace('exmo:imaging:','');let value;
 if(operation==='status')value={reviewAvailable:true,estimationAvailable:true,device:'CPU'};
 else if(operation==='results')value=args[0]===summary.analysis?[summary,comparison]:[];
 else if(operation==='list')value=[];
 else if(operation==='job')value=null;
 else if(operation==='resultPreview')value={image:png,view:args[1]?.view||'axial',index:8,count:16,sides:['R','L','A','P'],metadata:summary.metadata,warnings:[]};
 else if(operation==='imageMenu'){calls.push(args[0]);value={action:'cancel'};}
 else return handler(e,...args);
 return {ok:true,value};
});
const imaging=require('../desktop/imaging.cjs'),install=imaging.installImaging;
imaging.installImaging=(...args)=>{const instance=install(...args);return{...instance,mesh:id=>[summary.id,comparison.id].includes(id)?fixture.mesh:null};};
require('../desktop/main.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const deadline=setTimeout(()=>app.exit(1),150000);
(async()=>{
 await app.whenReady();const win=BrowserWindow.getAllWindows()[0];win.setSize(1500,1000);
 const wc=win.webContents;if(wc.isLoading())await new Promise(r=>wc.once('did-finish-load',r));
 const evaluate=code=>wc.executeJavaScript(code);
 const run=fn=>evaluate('('+fn+')()');
 const wait=async fn=>{for(let i=0;i<200;i++){if(await run(fn))return;await delay(100);}throw Error('UI timeout: '+fn);};
 const button=label=>evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==="+JSON.stringify(label)+").click()");
 const bounds=async(index=0)=>evaluate("(()=>{const c=document.querySelectorAll('.result-scene canvas')["+index+"],r=c.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),pixelWidth:c.width,pixelHeight:c.height};})()");
 const off=async()=>{wc.sendInputEvent({type:'mouseMove',x:15,y:100});await delay(150);};
 const drag=async(button,index=0)=>{
  const b=await bounds(index),x=b.x+Math.round(b.width/2),y=b.y+Math.round(b.height/2);
  wc.sendInputEvent({type:'mouseMove',x,y});wc.sendInputEvent({type:'mouseDown',button,x,y,clickCount:1});
  for(let i=1;i<=8;i++){wc.sendInputEvent({type:'mouseMove',x:x+i*6,y:y+i*2,modifiers:[button+'ButtonDown']});await delay(20);}
  wc.sendInputEvent({type:'mouseUp',button,x:x+48,y:y+16,clickCount:1});await off();await delay(3000);
 };
 const exportView=async(index=0)=>{
  const b=await bounds(index),x=b.x+12,y=b.y+12,count=calls.length;
  wc.sendInputEvent({type:'mouseMove',x,y});
  wc.sendInputEvent({type:'mouseDown',button:'right',x,y,clickCount:1});
  wc.sendInputEvent({type:'mouseUp',button:'right',x,y,clickCount:1});await delay(150);
  assert.equal(calls.length,count+1,'Stationary right-click opens one menu');
  const payload=calls.at(-1),image=nativeImage.createFromDataURL(payload.image);
  assert.deepEqual(image.getSize(),{width:b.pixelWidth,height:b.pixelHeight},'Only clicked canvas exported');
  assert.equal(payload.source.kind,'result');return payload;
 };
 const captureBoth=async()=>[await exportView(0),await exportView(1)];
 const hoverHit=async index=>{
  const b=await bounds(index);
  for(let y=.12;y<.9;y+=.09)for(let x=.12;x<.9;x+=.09){
   const point={x:Math.round(b.x+b.width*x),y:Math.round(b.y+b.height*y)};
   wc.sendInputEvent({type:'mouseMove',...point});await delay(35);
   const ids=await run(()=>[...document.querySelectorAll('.result-scene .scene')].map(e=>e.dataset.highlighted));
   if(ids[index]){await delay(200);assert.equal(ids[0],ids[1],'Hover links same muscle');return{...point,id:ids[index]};}
  }
  throw Error('No muscle hit in pane '+index);
 };
 await wait(()=>document.querySelector('.recent-section button'));
 await run(()=>document.querySelector('.recent-section button').click());
 await wait(()=>document.querySelector('.medical-image img'));
 await run(()=>document.querySelector('.medical-image').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})));
 await delay(100);assert.equal(calls[0].image,png,'2D uses displayed composition');
 await button('3D anatomy');
 await wait(()=>document.querySelector('.result-scene canvas')&&!document.querySelector('.scene-loading'));await delay(1800);
 const initial=await exportView();assert.equal(initial.source.id,summary.id);
 await drag('middle');const panned=await exportView();assert.notEqual(panned.image,initial.image,'Assembled middle-drag pans');
 await drag('left');const rotated=await exportView();assert.notEqual(rotated.image,panned.image,'Assembled left-drag rotates');
 await button('Back');await delay(400);await button('Front');await delay(400);const stationary=await exportView();
 let count=calls.length;await drag('right');assert.equal(calls.length,count,'Right-drag no menu');
 pixelsEqual((await exportView()).image,stationary.image,'Right-drag never moves model');
 await button('Explode anatomy');
 await wait(()=>document.querySelectorAll('.result-scene canvas').length===2&&!document.querySelector('.scene-loading'));await delay(2000);
 assert.deepEqual(await run(()=>[...document.querySelectorAll('.case-canvas')].map(e=>e.dataset.layout)),['assembled','exploded']);
 assert.ok(!await run(()=>document.querySelector('h1').textContent.includes('Compare')),'One case remains one case');
 const layouts=await captureBoth();assert.notEqual(layouts[0].image,layouts[1].image,'Layouts differ');
 assert.match(layouts[0].filename,/_assembled_/);assert.match(layouts[1].filename,/_exploded_/);
 for(let index=0;index<2;index++){
  await off();const base=await wc.capturePage();const hit=await hoverHit(index),highlighted=await wc.capturePage();
  const other=await bounds(1-index),crop={x:other.x,y:other.y,width:other.width,height:other.height};
  assert.ok(!base.crop(crop).toBitmap().equals(highlighted.crop(crop).toBitmap()),'Remote mesh visibly highlights');
  wc.sendInputEvent({type:'mouseDown',button:'left',x:hit.x,y:hit.y,clickCount:1});
  wc.sendInputEvent({type:'mouseUp',button:'left',x:hit.x,y:hit.y,clickCount:1});await off();await delay(1500);
  const labels=await run(()=>[...document.querySelectorAll('.case-title')].map(e=>e.textContent));
  assert.ok(labels.length===2&&labels.every(text=>text.includes('cm³')),'Both panes show selected measurements');
  const selected=await captureBoth();assert.notEqual(selected[0].image,selected[1].image,'Context differs from focused selection');
  await drag('left',1);const leftRotated=await exportView(1);assert.notEqual(leftRotated.image,selected[1].image,'Focused left drag rotates');
  await drag('middle',1);const translated=await exportView(1);assert.notEqual(translated.image,leftRotated.image,'Focused middle drag pans');
  await button('Back');await delay(400);await button('Front');await delay(400);const stationaryFocus=await exportView(1);
  count=calls.length;await drag('right',1);assert.equal(calls.length,count);
  pixelsEqual((await exportView(1)).image,stationaryFocus.image,'Focused right drag never moves');
  await button('Reset');await button('Explode anatomy');
  await wait(()=>document.querySelectorAll('.result-scene canvas').length===2&&!document.querySelector('.scene-loading'));await delay(1800);
 }
 await run(()=>[...document.querySelectorAll('button')].find(b=>/^(비교 영상 추가|Add comparison)/.test(b.textContent)).click());
 await wait(()=>document.querySelector('.comparison-candidates article button'));
 await run(()=>document.querySelector('.comparison-candidates article button').click());
 await run(()=>document.querySelector('.comparison-dialog').close());
 await wait(()=>document.querySelectorAll('.result-scene canvas').length===2&&!document.querySelector('.scene-loading'));await delay(2000);
 assert.deepEqual(await run(()=>[...document.querySelectorAll('.case-canvas')].map(e=>e.dataset.resultId)),[summary.id,comparison.id]);
 const beforeOther=await exportView(0);await drag('left',1);
 const compared=await captureBoth();pixelsEqual(compared[0].image,beforeOther.image,'Case cameras independent');
 assert.equal(compared[0].source.id,summary.id);assert.equal(compared[1].source.id,comparison.id);
 assert.notEqual(compared[0].image,compared[1].image,'Cases have separate rendered pixels');
 for(let i=0;i<2;i++)fs.writeFileSync(path.join(output,'case-'+i+'.png'),nativeImage.createFromDataURL(compared[i].image).toPNG());
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,checks:['2D exact image','viewport dimensions/source/pixels','single-case paired layouts','bidirectional hover/click','left rotate/middle pan/right menu','independent cameras','one pane per compared case']}));
 console.log('PASS: per-case PNG, paired layouts, linked hover/selection and unified controls');clearTimeout(deadline);app.quit();
})().catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
