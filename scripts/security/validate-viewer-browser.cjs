// Real HTTP browser surface, no preload/IPC. Existing protected QA results, no inference.
const {BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {startViewer}=require('./viewer-test-fixtures.cjs');
module.exports=async function({f,output,context}){
  const {base}=await startViewer(context,f),reader='web-reviewer';f.accounts.membership(reader,'hospital-a','research','Research',['reviewer']);
  f.accounts.membership(reader,'hospital-b','research','Empty workspace',['reviewer']);f.idp.settings.subject=reader;
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
    await select(0);await wait(`document.querySelectorAll('.viewer-table tbody tr').length===5`,'five results');await screenshot('list');
    const cloud=await f.rpc('list');
    for(const row of cloud){
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
      await js(`document.querySelector('.back-button').click()`);await wait(`document.querySelectorAll('.viewer-table tbody tr').length===5`,'back to results');
    }
    await js(`document.querySelector('.viewer-table tbody tr').click()`);await wait(`document.querySelector('.viewer-detail')`,'opened before scope change');
    await select(1);await wait(`!document.querySelector('.viewer-detail')&&!document.querySelector('.viewer-table tbody tr')`,'empty workspace clears prior result');
    await select(0);await wait(`document.querySelectorAll('.viewer-table tbody tr').length===5`,'return to first scope');
    await js(`document.querySelector('.viewer-table tbody tr').click()`);await wait(`document.querySelector('.viewer-detail')`,'opened before logout');
    await click('로그아웃');await wait(`!document.querySelector('.viewer-detail')&&[...document.querySelectorAll('button')].some(b=>b.textContent==='로그인'&&!b.disabled)`,'logout clears view');
    const cookies=await c.session.cookies.get({url:base});assert.ok(cookies.every(cookie=>cookie.httpOnly));
    assert.equal(await js(`Object.keys(localStorage).filter(k=>k!=='exmo.language').length`),0);
    await click('로그인');await wait(`document.querySelector('.viewer-workspace select')`,'relogin');await select(0);await wait(`document.querySelectorAll('.viewer-table tbody tr').length===5`,'relogin scope');
    await js(`document.querySelector('.viewer-table tbody tr').click()`);await wait(`document.querySelector('.viewer-detail')`,'opened before revoke');
    f.accounts.membership(reader,'hospital-a','research','Research',[]);await js(`document.dispatchEvent(new Event('visibilitychange'))`);
    await wait(`!document.querySelector('.viewer-detail')&&!document.querySelector('.viewer-table tbody tr')`,'revocation clears data');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'web-verification.json'),JSON.stringify({passed:true,localTestServer:true,syntheticOidc:true,noDesktopIPC:true,storedRoutes:cloud.map(r=>r.route||r.analysis),ctMri3D:true,metricsQC:true,representativeOverlayHashes:true,workspaceSwitch:true,logout:true,revocation:true,tabletViewport:[820,1180],physicalTablet:false,inferenceRerun:false},null,2));
    console.log('PASS: Web OIDC → workspace → CT/MRI/X-ray measurements, QC, verified Overlay and 3D; isolation and session cleanup');
  }catch(error){await screenshot('failure');console.error('Viewer failure surface:',new URL(c.getURL()).pathname,await js('document.body.innerText'));throw error;
  }finally{f.idp.settings.subject='manager';win.destroy();}
};
