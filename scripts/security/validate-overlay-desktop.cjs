const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const S=require('../../desktop/publication-protocol.cjs'),PNG=require('../../desktop/publication-image.cjs');
const {verifyPending}=require('./result-verifier.cjs');
module.exports=async function({window,c,call,f,sync,output}){
  const delay=ms=>new Promise(r=>setTimeout(r,ms)),js=code=>c.executeJavaScript(code);
  const wait=async(code,label)=>{for(let i=0;i<200;i++){if(await js(code))return;await delay(100);}throw Error('Overlay UI timeout: '+label);};
  const click=async(text)=>{await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled).click()`);await delay(100);};
  c.sendInputEvent({type:'keyDown',keyCode:'ESC'});c.sendInputEvent({type:'keyUp',keyCode:'ESC'});await delay(200);
  const rows=[...(await call('results','ct')).slice(0,1),...(await call('results','mri')).slice(0,1),...await call('results','xray')];assert.equal(rows.length,5);
  const expected=new Map();
  async function drain(){for(let i=0;i<160;i++){await sync.tick();await verifyPending(f.root,f.keys);const jobs=(await call('syncStatus')).jobs;
    assert.ok(!jobs.some(j=>['failed','needs_permission','quota_blocked'].includes(j.state)),JSON.stringify(jobs));
    if(jobs.length===5&&jobs.every(j=>j.state==='published'&&j.overlayState==='ready'&&j.meshState!=='pending'))return;await delay(100);}throw Error('Overlay upload timeout');}
  for(const row of rows){
    const options={view:'axial',index:0,window:'soft',opacity:.45,classIds:null,side:'all'},ref={id:row.id,revision:row.analysisRevision};
    const draft=await call('overlayCreate',ref,options),rect={x:0,y:0,width:Math.min(30,draft.width),height:Math.min(20,draft.height)};
    const final=await call('overlayRedact',draft.id,[rect]),decoded=PNG.decode(Buffer.from(final.image.slice(22),'base64'));
    for(let y=0;y<rect.height;y++)assert.ok(decoded.pixels.subarray(y*decoded.width*3,(y*decoded.width+rect.width)*3).every(v=>v===0));
    const wrong=(final.sha256[0]==='0'?'1':'0')+final.sha256.slice(1);
    assert.equal((await c.executeJavaScript(`window.exmoDesktop.overlayApprove(${JSON.stringify(draft.id)},${JSON.stringify(wrong)})`)).ok,false);
    await call('overlayApprove',final.id,final.sha256);expected.set(row.id,final.sha256);
  }
  await drain();
  for(const job of (await call('syncStatus')).jobs){const value=await f.rpc('read',{resultId:job.cloudResultId});assert.equal(value.overlay.sha256,expected.get(job.resultId));assert.equal(value.analysis.mask,undefined);}
  // Exercise the actual editor, not only IPC: final review, checkbox, queue confirmation.
  await js(`document.querySelector('.desktop-brand').click()`);await wait(`document.querySelectorAll('.recent-section tbody tr').length>0`,'local results');
  await js(`[...document.querySelectorAll('.recent-section tbody tr')].find(r=>r.children[1].textContent==='MRI').click()`);
  await wait(`[...document.querySelectorAll('button')].some(b=>b.textContent==='대표 Overlay 게시'&&!b.disabled)`,'current slice publication');
  await click('대표 Overlay 게시');await wait(`document.querySelector('.overlay-review-image img')`,'editor image');
  await click('가림 영역 추가');await click('최종 사본 검토');await wait(`document.querySelector('.overlay-approval input')`,'final confirmation');
  assert.equal(await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='확인한 사본과 결과 게시').disabled`),true);
  fs.writeFileSync(path.join(output,'overlay-final-review.png'),(await c.capturePage()).toPNG());
  await js(`document.querySelector('.overlay-approval input').click()`);await click('확인한 사본과 결과 게시');
  await wait(`document.querySelector('.overlay-review-dialog').textContent.includes('전송 대기열에 추가')`,'approved queued');await drain();
  c.sendInputEvent({type:'keyDown',keyCode:'ESC'});c.sendInputEvent({type:'keyUp',keyCode:'ESC'});await delay(200);await js(`document.querySelector('.desktop-brand').click()`);
  await click('서버 결과');await wait(`document.querySelectorAll('[data-remote-id]').length===5`,'remote list');
  const cloud=await f.rpc('list');
  for(const row of cloud){
    await js(`document.querySelector('[data-remote-id="${row.resultId}"] button').click()`);await wait(`document.querySelector('.remote-detail')`,'remote detail');
    if(row.analysis!=='xray')await click('Overlay·측정·QC');
    await wait(`document.querySelector('.remote-overlay img')?.naturalWidth>0`,'actual authorized PNG');
    const src=await js(`document.querySelector('.remote-overlay img').getAttribute('src')`);
    const digest=await js(`fetch(${JSON.stringify(src)},{cache:'no-store'}).then(r=>r.arrayBuffer()).then(b=>crypto.subtle.digest('SHA-256',b)).then(b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join(''))`);
    const read=await f.rpc('read',{resultId:row.resultId});assert.equal(digest,read.overlay.sha256);
    fs.writeFileSync(path.join(output,'overlay-remote-'+(row.route||row.analysis)+'.png'),(await c.capturePage()).toPNG());
    await js(`document.querySelector('.remote-detail .back-button').click()`);await delay(100);
  }
  await js(`document.querySelector('.desktop-brand').click()`);
  // Existing remote validation starts with this dialog open.
  await click('전송 현황');
  fs.writeFileSync(path.join(output,'overlay-verification.json'),JSON.stringify({passed:true,storedRoutes:rows.map(r=>r.route||r.analysis),archivedReader:true,inferenceRerun:false,realDpapi:true,irreversibleRedaction:true,changedHashRejected:true,finalReviewUI:true,encryptedUpload:true,remotePixelHash:true},null,2));
  console.log('PASS: real CT/MRI/AP/LT/RT representative images, redaction / approval UI, encrypted upload and authorized remote pixels');
};
