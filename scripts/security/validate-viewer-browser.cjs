// Real HTTP browser surface, no preload/IPC. Existing protected QA results, no inference.
const {BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {startViewer}=require('./viewer-test-fixtures.cjs');
module.exports=async function({f,output,context}){
  const {base}=await startViewer(context,f),reader='web-reviewer';f.accounts.membership(reader,'hospital-a','research','Research',['reviewer']);
  f.accounts.membership(reader,'hospital-b','research','Empty workspace',['reviewer']);f.idp.settings.subject=reader;
  const db=f.service.db,contexts=db.prepare('SELECT * FROM publication_contexts').all(),clones=[];
  const id=()=>require('node:crypto').randomUUID();
  const cloud=await f.rpc('list'),xray=cloud.filter(r=>r.analysis==='xray'),mri=cloud.find(r=>r.analysis==='mri');
  const linked={caseId:id(),studyId:id()};
  for(const row of xray)db.prepare('INSERT INTO publication_contexts VALUES(?,?) ON CONFLICT(result) DO UPDATE SET document=excluded.document').run(row.resultId,JSON.stringify({...linked,acquisitionId:id()}));
  const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'viewer-'+require('node:crypto').randomUUID()}}),c=win.webContents;
  // Desktop's global atlas-only navigation guard does not apply to this separate test browser.
  c.removeAllListeners('will-navigate');c.setWindowOpenHandler(()=>({action:'deny'}));
  const errors=[];c.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  const delay=ms=>new Promise(r=>setTimeout(r,ms)),js=code=>c.executeJavaScript(code);
  const wait=async(code,label)=>{for(let i=0;i<250;i++){try{if(await js(`Boolean(${code})`))return;}catch{}await delay(100);}throw Error('Web UI timeout: '+label+' '+errors.join(';'));};
  const click=async text=>{await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled).click()`);await delay(100);};
  const screenshot=async name=>fs.writeFileSync(path.join(output,'web-'+name+'.png'),(await c.capturePage()).toPNG());
  try{
    await win.loadURL(base);win.showInactive();await wait(`[...document.querySelectorAll('button')].some(b=>b.textContent==='로그인'&&!b.disabled)`,'sign in');
    assert.equal(await js('typeof window.exmoDesktop'),'undefined');assert.equal(await js('typeof window.require'),'undefined');await click('로그인');
    await wait(`document.querySelector('.viewer-workspace select')?.options.length===3`,'OIDC callback');
    const select=async index=>{
      await wait(`document.querySelector('.viewer-workspace select')&&!document.querySelector('.viewer-workspace select').disabled`,'workspace control ready');
      await js(`(()=>{const el=document.querySelector('.viewer-workspace select');el.value='${index}';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await wait(`document.querySelector('.viewer-workspace select')?.value==='${index}'&&!document.querySelector('.viewer-workspace select').disabled`,'workspace selection finished');
    };
    await select(0);await wait(`document.querySelectorAll('[data-remote-id]').length===5`,'five results');await screenshot('list');
    for(const row of await f.rpc('list')){
      const name='Case '+(row.context?.caseId||row.resultId).slice(0,8),label=`${name} ${row.analysis.toUpperCase()} ${row.route||''}`;
      await js(`document.querySelector('tr[aria-label="${label}"]').click()`);await wait(`document.querySelector('.viewer-detail .metric-table tbody tr')`,'measurements');
      if(row.analysis!=='xray'){
        await wait(`document.querySelector('canvas')&&!document.querySelector('.scene-loading')&&!document.querySelector('.scene-error')`,'published '+row.analysis+' 3D');
        await delay(500);await wait(`!document.querySelector('.scene-loading')&&!document.querySelector('.scene-error')`,'settled 3D');
        const rect=await js(`(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.floor(r.width),height:Math.floor(r.height)}})()`);
        const hash=async()=>require('node:crypto').createHash('sha256').update((await c.capturePage(rect)).toPNG()).digest('hex'),before=await hash();
        const x=rect.x+Math.floor(rect.width/2),y=rect.y+Math.floor(rect.height/2);
        c.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});c.sendInputEvent({type:'mouseMove',x:x+60,y:y+15,modifiers:['leftButtonDown']});c.sendInputEvent({type:'mouseUp',x:x+60,y:y+15,button:'left',clickCount:1});await delay(500);assert.notEqual(await hash(),before,'3D must visibly rotate');
        await screenshot(row.analysis+'-3d');await click('QC·후처리');await screenshot(row.analysis+'-qc');await click('측정값');await click('Overlay·측정·QC');
      }
      await wait(`document.querySelector('.remote-overlay img')?.naturalWidth>0`,'published overlay');
      const digest=await js(`fetch(document.querySelector('.remote-overlay img').src,{cache:'no-store'}).then(r=>r.arrayBuffer()).then(b=>crypto.subtle.digest('SHA-256',b)).then(b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join(''))`);
      assert.equal(digest,(await f.rpc('read',{resultId:row.resultId})).overlay.sha256);await screenshot(row.route||row.analysis);
      if(row.analysis==='mri'){
        win.setSize(820,1180);await delay(400);assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);await screenshot('tablet');win.setSize(1440,1000);
      }
      await js(`document.querySelector('.back-button').click()`);await wait(`!document.querySelector('.viewer-detail')&&document.querySelectorAll('[data-remote-id]').length===5`,'back to results');
    }
    await click('촬영 묶음 열기');await wait(`document.querySelectorAll('.remote-overlay img').length===3&&[...document.querySelectorAll('.remote-overlay img')].every(i=>i.naturalWidth>0)`,'grouped LT/AP/RT');
    const order=await js(`[...document.querySelectorAll('.case-canvas')].map(e=>e.dataset.resultId)`);
    assert.deepEqual(order,['LAT_LT','AP','LAT_RT'].map(route=>xray.find(r=>r.route?.replaceAll('-','_')===route).resultId));
    assert.equal(await js(`document.querySelectorAll('.metric-table thead th').length`),4);await click('QC·후처리');await screenshot('xray-study-qc');await js(`document.querySelector('.back-button').click()`);
    const laterals=xray.filter(r=>r.route!=='AP');
    for(const row of laterals)db.prepare('UPDATE publications SET deleted=1 WHERE id=?').run(row.resultId);
    await click('새로고침');await wait(`document.querySelectorAll('[data-remote-id]').length===3`,'AP-only study');
    assert.ok(await js(`document.querySelector('.viewer-study').textContent.includes('LT / RT')&&document.querySelector('.viewer-study').textContent.includes('미게시')`));
    await click('촬영 묶음 열기');await wait(`document.querySelectorAll('.case-canvas').length===1&&document.querySelector('.remote-overlay img')?.naturalWidth>0`,'AP-only detail');await screenshot('xray-ap-only');
    await js(`document.querySelector('.back-button').click()`);for(const row of laterals)db.prepare('UPDATE publications SET deleted=0 WHERE id=?').run(row.resultId);
    // Same approved MRI geometry replicated only inside this isolated UI fixture, not new patient/inference evidence.
    const acquisition={caseId:id(),studyId:id(),acquisitionId:id()};
    for(const rowId of [mri.resultId,...[id(),id()]]){
      if(rowId!==mri.resultId){clones.push(rowId);db.prepare('INSERT INTO publications SELECT ?,?,org,workspace,digest,content,mask_attempt,mesh_attempt,revision,deleted,publisher FROM publications WHERE id=?').run(id(),rowId,mri.resultId);
        db.prepare('INSERT INTO publication_overlays SELECT ?,attempt FROM publication_overlays WHERE result=?').run(rowId,mri.resultId);}
      db.prepare('INSERT INTO publication_contexts VALUES(?,?) ON CONFLICT(result) DO UPDATE SET document=excluded.document').run(rowId,JSON.stringify(acquisition));
    }
    await click('새로고침');await wait(`document.querySelectorAll('[data-remote-id]').length===7`,'comparison fixtures');
    await click('비교 선택 · 0/3');
    for(const rowId of [mri.resultId,...clones])await js(`document.querySelector('[data-remote-id="${rowId}"]').click()`);
    await js(`document.querySelector('[data-remote-id="${xray[0].resultId}"]').click()`);assert.equal(await js(`document.querySelectorAll('[data-remote-id][aria-selected="true"]').length`),3);
    await click('수치 비교');await wait(`document.querySelectorAll('canvas').length===3&&!document.querySelector('.scene-loading')&&!document.querySelector('.scene-error')`,'three compatible models');
    await delay(800);await click('Explode anatomy');await wait(`document.querySelectorAll('.case-canvas[data-layout="exploded"]').length===3`,'all exploded');await delay(900);
    await js(`document.querySelector('.metric-table tr[data-structure]').click()`);await delay(800);
    assert.equal(await js(`document.querySelectorAll('.case-title').length`),3);await screenshot('three-structures');
    const boxes=await js(`[...document.querySelectorAll('canvas')].map(e=>{const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.floor(r.width),height:Math.floor(r.height)}})`);
    const frameHashes=async()=>Promise.all(boxes.map(async box=>require('node:crypto').createHash('sha256').update((await c.capturePage(box)).toPNG()).digest('hex'))),beforeRotation=await frameHashes();
    const rx=boxes[0].x+Math.floor(boxes[0].width/2),ry=boxes[0].y+Math.floor(boxes[0].height/2);
    c.sendInputEvent({type:'mouseDown',x:rx,y:ry,button:'right',clickCount:1});c.sendInputEvent({type:'mouseMove',x:rx+50,y:ry+20,modifiers:['rightButtonDown']});c.sendInputEvent({type:'mouseUp',x:rx+50,y:ry+20,button:'right',clickCount:1});await delay(500);
    const afterRotation=await frameHashes();assert.notEqual(afterRotation[0],beforeRotation[0]);assert.deepEqual(afterRotation.slice(1),beforeRotation.slice(1),'other structures keep independent orientation');
    // The HTTP browser's native touch input exercises the same pointer paths used by a tablet.
    win.setSize(820,1180);await delay(300);await js(`document.querySelector('.result-imaging').scrollIntoView()`);await delay(300);
    await click('터치: 선택 구조 회전');win.show();win.focus();c.debugger.attach('1.3');
    const command=(method,args)=>Promise.race([c.debugger.sendCommand(method,args),delay(10000).then(()=>{throw Error('Touch command timeout: '+method);})]);
    await command('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});
    const rect=await js(`(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.floor(r.width),height:Math.floor(r.height)}})()`);
    const px=rect.x+Math.floor(rect.width/2),py=Math.max(120,rect.y+Math.floor(rect.height/2));
    const hash=async()=>require('node:crypto').createHash('sha256').update((await c.capturePage()).toPNG()).digest('hex'),before=await hash();
    console.log('Web touch viewport:',rect,px,py);
    const touch=(type,points)=>command('Input.dispatchTouchEvent',{type,touchPoints:points.map(([x,y],i)=>({x,y,id:i,radiusX:4,radiusY:4,force:1}))});
    await touch('touchStart',[[px,py]]);for(let n=1;n<=8;n++)await touch('touchMove',[[px+n*8,py+n*3]]);await touch('touchEnd',[]);await delay(700);
    assert.notEqual(await hash(),before,'selected structure must respond to actual touch drag');await screenshot('tablet-touch-rotation');
    await touch('touchStart',[[px-30,py],[px+30,py]]);await touch('touchMove',[[px-70,py],[px+70,py]]);await touch('touchEnd',[]);await delay(400);
    await c.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:false});c.debugger.detach();
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);win.setSize(1440,1000);await delay(300);
    await click('Assemble');await wait(`document.querySelectorAll('.case-canvas[data-layout="assembled"]').length===3`,'all assembled');await click('QC·후처리');await screenshot('three-qc');
    await js(`document.querySelector('.back-button').click()`);await click('선택 해제');
    await js(`document.querySelector('[data-remote-id="${mri.resultId}"]').click();document.querySelector('[data-remote-id="${xray[0].resultId}"]').click()`);
    await click('수치 비교');await wait(`document.querySelector('.viewer-error')&&!document.querySelector('.viewer-detail')`,'incompatible quantities blocked');
    await click('나란히 열람');await wait(`document.querySelectorAll('.case-canvas').length===2`,'explicit reference view');
    await select(1);await wait(`!document.querySelector('.viewer-detail')&&!document.querySelector('[data-remote-id]')`,'empty workspace clears prior result');
    await select(0);await wait(`document.querySelectorAll('[data-remote-id]').length===7`,'return to first scope');
    await js(`document.querySelector('[data-remote-id]').click()`);await wait(`document.querySelector('.viewer-detail')`,'opened before logout');
    await click('로그아웃');await wait(`!document.querySelector('.viewer-detail')&&[...document.querySelectorAll('button')].some(b=>b.textContent==='로그인'&&!b.disabled)`,'logout clears view');
    const cookies=await c.session.cookies.get({url:base});assert.ok(cookies.every(cookie=>cookie.httpOnly));
    assert.equal(await js(`Object.keys(localStorage).filter(k=>k!=='exmo.language').length`),0);
    await click('로그인');await wait(`document.querySelector('.viewer-workspace select')`,'relogin');await select(0);await wait(`document.querySelectorAll('[data-remote-id]').length===7`,'relogin scope');
    await js(`document.querySelector('[data-remote-id]').click()`);await wait(`document.querySelector('.viewer-detail')`,'opened before revoke');
    f.accounts.membership(reader,'hospital-a','research','Research',[]);await js(`document.dispatchEvent(new Event('visibilitychange'))`);
    await wait(`!document.querySelector('.viewer-detail')&&!document.querySelector('[data-remote-id]')`,'revocation clears data');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'web-verification.json'),JSON.stringify({passed:true,localTestServer:true,syntheticOidc:true,noDesktopIPC:true,storedRoutes:cloud.map(r=>r.route||r.analysis),ctMri3D:true,metricsQC:true,representativeOverlayHashes:true,workspaceSwitch:true,logout:true,revocation:true,threeCaseComparison:true,independentStructureRotation:true,comparisonUsesClonedMRI:true,xrayStudyOrder:true,apOnlyStudy:true,incompatibleComparisonBlocked:true,tabletTouchInput:true,tabletViewport:[820,1180],physicalTablet:false,inferenceRerun:false},null,2));
    console.log('PASS: Web OIDC → workspace → CT/MRI/X-ray measurements, QC, verified Overlay and 3D; isolation and session cleanup');
  }catch(error){if(c.debugger.isAttached())c.debugger.detach();await screenshot('failure');console.error('Viewer failure surface:',new URL(c.getURL()).pathname,await js('document.body.innerText'));throw error;
  }finally{
    f.idp.settings.subject='manager';if(c.debugger.isAttached())c.debugger.detach();win.destroy();
    for(const row of xray)db.prepare('UPDATE publications SET deleted=0 WHERE id=?').run(row.resultId);
    for(const rowId of clones){db.prepare('DELETE FROM publication_contexts WHERE result=?').run(rowId);db.prepare('DELETE FROM publication_overlays WHERE result=?').run(rowId);db.prepare('DELETE FROM publications WHERE id=?').run(rowId);}
    db.prepare('DELETE FROM publication_contexts').run();for(const row of contexts)db.prepare('INSERT INTO publication_contexts VALUES(?,?)').run(row.result,row.document);
  }
};
