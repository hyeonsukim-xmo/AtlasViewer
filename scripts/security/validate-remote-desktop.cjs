const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const F=require('./publication-test-fixtures.cjs'),{verifyPending}=require('./result-verifier.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
module.exports=async function({window,c,call,f,sync,output}){
  const js=code=>c.executeJavaScript(code),wait=async(code,label)=>{for(let i=0;i<160;i++){if(await js(code))return;await delay(100);}throw Error('UI timeout: '+label);};
  const click=async(ko,en)=>{await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(ko)}||b.textContent.trim()===${JSON.stringify(en)}).click()`);await delay(150);};
  // Close transfer dialog with a real keyboard input; test the normal Desktop navigation.
  c.sendInputEvent({type:'keyDown',keyCode:'ESC'});c.sendInputEvent({type:'keyUp',keyCode:'ESC'});await delay(300);
  await sync.tick();
  const ct=(await call('results','ct'))[0],xrays=await call('results','xray');
  for(const result of [ct,...xrays]){const ref={id:result.id,revision:result.analysisRevision};await call('syncEnqueue',[ref]);}
  for(let i=0;i<160;i++){
    await verifyPending(f.root,f.keys);await sync.tick();const jobs=(await call('syncStatus')).jobs;
    assert.ok(!jobs.some(j=>['failed','needs_permission','quota_blocked'].includes(j.state)),JSON.stringify(jobs));
    if(jobs.length===5 && jobs.every(j=>j.state==='published' && j.meshState!=='pending')){await sync.tick();break;}await delay(200);
  }
  assert.equal((await f.rpc('list')).length,5);
  // Synthetic study linkage only in the isolated test DB: original sample metadata is not modified.
  const ctx={caseId:require('node:crypto').randomUUID(),studyId:require('node:crypto').randomUUID()};
  for(const row of await f.rpc('list'))if(row.analysis==='xray')f.service.db.prepare('UPDATE publication_contexts SET document=? WHERE result=?').run(JSON.stringify({...ctx,acquisitionId:row.context.acquisitionId}),row.resultId);
  await click('서버 결과','Server results');await wait(`document.querySelectorAll('[data-remote-id]').length===5`,'five remote results');
  fs.writeFileSync(path.join(output,'remote-list.png'),(await c.capturePage()).toPNG());
  await click('비교 선택 · 0/3','Select for comparison · 0/3');
  const remote=await f.rpc('list'),mri=remote.find(r=>r.analysis==='mri'),ctId=remote.find(r=>r.analysis==='ct').resultId;
  const select=id=>js(`document.querySelector('[data-remote-id="${id}"]').click()`);
  await select(mri.resultId);await select(ctId);
  await wait(`document.querySelectorAll('[data-remote-id][aria-selected="true"]').length===2`,'row selection');
  assert.equal(await js(`document.querySelector('.remote-detail')===null`),true);
  await wait(`[...document.querySelectorAll('button')].some(b=>['수치 비교','Quantitative comparison'].includes(b.textContent)&&b.disabled)`,'incompatible comparison blocked');
  await js(`document.querySelector('[data-remote-id="${mri.resultId}"] button').focus();document.querySelector('[data-remote-id="${mri.resultId}"] button').click()`);
  await wait(`document.querySelector('.remote-detail canvas') && !document.querySelector('.remote-detail .scene-loading')`,'published MRI 3D');
  assert.equal(await js(`document.querySelectorAll('.remote-detail .scene-error').length`),0);
  assert.equal(await js(`document.querySelectorAll('.remote-detail select[aria-label*="variant"]').length`),0);
  fs.writeFileSync(path.join(output,'remote-mri.png'),(await c.capturePage()).toPNG());
  await click('QC·후처리','QC / postprocessing');
  assert.equal(await js(`!![...document.querySelectorAll('.remote-detail button')].find(b=>b.textContent==='강화 후보 비교')`),false);
  await js(`document.querySelector('.remote-detail .back-button').click()`);await delay(200);
  assert.equal(await js(`document.querySelectorAll('[data-remote-id][aria-selected="true"]').length`),2);
  assert.equal(await js(`document.activeElement.closest('[data-remote-id]')?.getAttribute('data-remote-id')`),mri.resultId);
  await click('나란히 열람','Side-by-side review');await wait(`document.querySelectorAll('.remote-detail canvas').length===2 && !document.querySelector('.remote-detail .scene-loading')`,'CT + MRI reference review');
  assert.equal(await js(`document.querySelectorAll('.remote-detail .scene-error').length`),0);
  await click('Explode anatomy','Explode anatomy');await delay(500);
  fs.writeFileSync(path.join(output,'remote-reference.png'),(await c.capturePage()).toPNG());
  await js(`document.querySelector('.remote-detail tr[data-structure="sartorius"]').click()`);await delay(1200);
  const rects=await js(`[...document.querySelectorAll('.remote-detail canvas')].map(c=>{const r=c.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.floor(r.width),height:Math.floor(r.height)}})`);
  const digest=async rect=>require('node:crypto').createHash('sha256').update((await c.capturePage(rect)).toPNG()).digest('hex');
  const before=await Promise.all(rects.map(digest)),x=rects[0].x+Math.floor(rects[0].width/2),y=rects[0].y+Math.floor(rects[0].height/2);
  c.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});c.sendInputEvent({type:'mouseMove',x:x+60,y:y+20,modifiers:['leftButtonDown']});c.sendInputEvent({type:'mouseUp',x:x+60,y:y+20,button:'left',clickCount:1});await delay(300);
  const after=await Promise.all(rects.map(digest));assert.notEqual(after[0],before[0]);assert.equal(after[1],before[1]);
  await js(`document.querySelector('.remote-detail .back-button').click()`);await delay(200);
  await click('촬영 묶음 열기','Open study views');await wait(`document.querySelectorAll('.remote-detail .metric-case-name').length===3`,'LT AP RT group');
  const viewText=await js(`[...document.querySelectorAll('.remote-detail .metric-case-name small')].map(x=>x.textContent)`);assert.deepEqual(viewText,['LT','AP','RT']);
  assert.equal(await js(`document.querySelectorAll('.remote-detail canvas').length`),0);assert.equal(await js(`document.querySelectorAll('.remote-detail .medical-preview').length`),0);
  await js(`document.querySelector('.remote-detail .back-button').click()`);await delay(200);
  window.setSize(900,780);await delay(400);assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth`),true);
  fs.writeFileSync(path.join(output,'remote-narrow.png'),(await c.capturePage()).toPNG());window.setSize(1440,960);
  for(const route of ['LAT_RT','LAT_LT']){
    const row=remote.find(r=>r.route?.replaceAll('-','_')===route);await f.rpc('delete',{resultId:row.resultId,revision:row.attachmentRevision});await click('새로고침','Refresh');
    await wait(`!document.querySelector('[data-remote-id="${row.resultId}"]')`,'deleted view removed');
    assert.ok(await js(`document.querySelector('.remote-study').textContent.includes('미게시')`));
  }
  await click('촬영 묶음 열기','Open study views');await wait(`document.querySelectorAll('.remote-detail .metric-case-name').length===1`,'AP-only study');
  assert.deepEqual(await js(`[...document.querySelectorAll('.remote-detail .metric-case-name small')].map(x=>x.textContent)`),['AP']);
  await js(`document.querySelector('.remote-detail .back-button').click()`);await delay(200);
  await call('accountLogout');await wait(`!document.querySelector('.remote-detail') && document.querySelectorAll('[data-remote-id]').length===0`,'logout hides remote data');
  await call('accountLogin');await call('accountWorkspace','hospital-a','research');await wait(`document.querySelectorAll('[data-remote-id]').length===3`,'login returns to remote page');
  f.accounts.membership('manager','hospital-a','research','Research',['device-admin']);await click('새로고침','Refresh');await wait(`document.querySelectorAll('[data-remote-id]').length===0`,'revoked role clears data');
  await click('← 분석 작업으로','← Analysis workspace');await wait(`document.querySelectorAll('.recent-section tbody tr').length>0`,'local results after cloud denial');
  fs.writeFileSync(path.join(output,'remote-home.png'),(await c.capturePage()).toPNG());
  fs.writeFileSync(path.join(output,'remote-verification.json'),JSON.stringify({passed:true,storedRoutes:['CT','MRI','AP','LAT_LT','LAT_RT'],inferenceRerun:false,readonly:true,selectionPreserved:true,focusRestored:true,incompatibleComparisonBlocked:true,ctMri3D:true,independentRotation:true,xrayOrder:viewText,apOnly:true,logoutClears:true,loginReturns:true,roleRevocation:true,narrowWindow:true},null,2));
  console.log('PASS: P6 Desktop list / read-only 3D / selection + focus / X-ray grouping / logout + role revocation / local return');
};
