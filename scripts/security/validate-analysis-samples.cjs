// Packaged application IPC and UI, delivered sample inputs, real authorized GPU inference.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const CASES={
  ct:['ct',null,'EXMO_CT/samples/EXMO_CASE_001/input_ct.nii.gz'],
  mri:['mri',null,'EXMO_MRI/samples/sample_01/W.nrrd'],
  ap:['xray','AP','EXMO_XRAY/samples/AP/AP_01/input.nrrd'],
  lat_lt:['xray','LAT_LT','EXMO_XRAY/samples/LAT_LT/LAT_LT_01/input.nrrd'],
  lat_rt:['xray','LAT_RT','EXMO_XRAY/samples/LAT_RT/LAT_RT_01/input.nrrd'],
};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
async function hash(file){const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');}
async function until(test,seconds=120){const end=Date.now()+seconds*1000;while(Date.now()<end){const value=await test();if(value)return value;await new Promise(r=>setTimeout(r,250));}throw Error('Sample check timed out');}
function encrypted(file){const fd=fs.openSync(file,'r'),header=Buffer.alloc(8);try{fs.readSync(fd,header,0,8,0);}finally{fs.closeSync(fd);}assert.equal(header.toString(),'EXMOAF01','Result mask must remain encrypted');}
async function runSamples({sourceRoot,storage,output,window,run,pick,names=Object.keys(CASES),previousReport}){
  assert.ok(names.length && new Set(names).size===names.length && names.every(name=>CASES[name]));
  const previous=previousReport?read(previousReport):null;if(previous)assert.equal(previous.complete,true);
  const report={startedAt:new Date().toISOString(),syntheticOnly:false,fullCaseInference:!previous,previousReport,device:'cuda:0',complete:false,passed:false,cases:{}};
  const save=()=>fs.writeFileSync(path.join(output,'analysis-samples.json'),JSON.stringify(report,null,2));
  const call=async(method,...args)=>{const response=await run(`window.exmoDesktop[${JSON.stringify(method)}](...${JSON.stringify(args)})`);assert.equal(response.ok,true,response.error);return response.value;};
  const click=selector=>run(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw Error('Missing UI element');element.click();})()`);
  const screen=async name=>fs.writeFileSync(path.join(output,name+'.png'),(await window.webContents.capturePage()).toPNG());
  save();
  for(const name of names){
    const [analysis,route,relative]=CASES[name],item=report.cases[name]={passed:false};
    try {
      const source=path.join(sourceRoot,'packages',relative);item.inputSha256=await hash(source);
      await click('.desktop-brand');await until(()=>run('Boolean(document.querySelector(".protocol-table tbody tr"))'));
      await run(`Array.from(document.querySelectorAll('.protocol-table tbody tr')).find(row=>row.querySelector('.modality-label').textContent===${JSON.stringify({ct:'CT',mri:'MRI',xray:'X-ray'}[analysis])}).click()`);
      let result;
      if(previous){
        const saved=previous.cases[name];assert.ok(saved?.inputId);assert.equal(saved.inputSha256,item.inputSha256);
        const matches=(await call('results',analysis)).filter(r=>saved.resultId?r.id===saved.resultId:r.inputId===saved.inputId);assert.equal(matches.length,1);
        result=matches[0];assert.equal(result.inputId,saved.inputId);
        if(!saved.resultId)item.recoveredCompletedOutput=true;
        item.inputId=result.inputId;item.reusedResultId=result.id;console.log(name+': checking saved real inference result');
        if(result.variant!=='raw')result=await call('variant',result.id,'raw');
      }else{
        pick([source]);item.stage='import';save();console.log(name+': importing real sample');
        const imported=await call('chooseFiles',analysis,false,'en');assert.equal(imported.length,1);
        const input=imported[0];assert.equal(input.ready,true,input.error);assert.equal(input.classification?.route_to_segmentation || null,route);
        item.inputId=input.id;item.classification=input.classification;
        const preview=await call('preview',analysis,input.id,{view:'axial'});assert.ok(preview.image.startsWith('data:image/png;base64,'));item.inputPreview=true;save();
        await call('run',analysis,[input.id],[input.id],'cuda:0');let last='',early=false;
        const job=await until(async()=>{
          const value=await call('job'),stage=value.active?.map(t=>t.stage).join(' / ') || value.stage;
          if(stage!==last){console.log(name+': '+stage);last=stage;item.stage=stage;save();}
          early ||= value.completed.some(r=>r.meshState==='pending');
          return value.state==='running'?null:value;
        },1200);
        assert.equal(job.state,'complete',JSON.stringify(job.failed));assert.equal(job.completed.length,1);
        result=(await call('results',analysis)).find(r=>r.id===job.completed[0].id);assert.ok(result);assert.equal(result.inputId,input.id);
        item.batchSeconds=job.elapsedSeconds;item.observedEarly=early;
      }
      assert.ok(result.rows.length && result.rows.some(row=>row.count>0 && row.value>0));
      assert.ok(result.rows.every(row=>Number.isFinite(row.value) && row.value>=0 && Number.isInteger(row.count) && row.count>=0));
      const publication=read(path.join(storage,'runs',result.id,'published.json')),complete=read(path.join(publication.result,'desktop-complete.json'));
      assert.equal(complete.complete,true);assert.equal(complete.execution.device,'cuda:0');assert.ok(complete.execution.peak_gpu_memory_bytes>0);
      encrypted(publication.mask);item.encryptedMask=true;item.resultId=result.id;item.rows=result.rows;item.qc=result.qc;item.execution=complete.execution;item.timings=result.timings;item.stage='result checks';save();
      item.views={};let colored=false;
      for(const view of analysis==='xray'?['axial']:['axial','coronal','sagittal']){
        const plain=await call('resultPreview',result.id,{view,opacity:0});
        const overlay=await call('resultPreview',result.id,{view,index:plain.index,opacity:.45});
        assert.ok(overlay.image.startsWith('data:image/png;base64,'));assert.equal(overlay.count,plain.count);assert.ok(overlay.count>0);
        colored ||= overlay.image!==plain.image;
        fs.writeFileSync(path.join(output,`${name}-${view}-overlay.png`),Buffer.from(overlay.image.split(',')[1],'base64'));
        item.views[view]={count:overlay.count,index:overlay.index,overlayChangesPixels:overlay.image!==plain.image};
        if(overlay.count>1){const index=(overlay.index+1)%overlay.count,next=await call('resultPreview',result.id,{view,index});assert.equal(next.index,index);item.views[view].sliceChange=true;}
      }
      assert.ok(colored,'No visible segmentation overlay');
      if(analysis!=='xray'){
        assert.equal(result.meshState,'ready');assert.ok(result.meshBytes>0);
        assert.equal(await run("fetch('/result/00000000-0000-0000-0000-000000000000.glb').then(r=>r.status)"),404);
        assert.equal(await run(`fetch('/result/${result.id}.glb',{method:'POST'}).then(r=>r.status)`),403);
        item.mesh=await run(`(async()=>{const response=await fetch('/result/${result.id}.glb');if(!response.ok)throw Error('GLB fetch failed: '+response.status);const data=await response.arrayBuffer(),view=new DataView(data);if(view.getUint32(0,true)!==0x46546c67 || view.getUint32(4,true)!==2 || view.getUint32(8,true)!==data.byteLength)throw Error('Invalid GLB');const length=view.getUint32(12,true),json=JSON.parse(new TextDecoder().decode(new Uint8Array(data,20,length)));return {bytes:data.byteLength,meshes:json.meshes.length,vertices:json.meshes.reduce((sum,m)=>sum+m.primitives.reduce((n,p)=>n+json.accessors[p.attributes.POSITION].count,0),0)};})()`);
        assert.ok(item.mesh.meshes>0 && item.mesh.vertices>0);assert.equal(item.mesh.bytes,result.meshBytes);
      }
      await click('.desktop-brand');
      const match=`row=>row.querySelector('strong')?.textContent===${JSON.stringify(result.metadata.caseName)}${route?` && row.children[2].textContent.trim()===${JSON.stringify({AP:'AP',LAT_LT:'LT',LAT_RT:'RT'}[route])}`:''}`;
      await until(()=>run(`Array.from(document.querySelectorAll('.recent-section tbody tr')).some(${match})`));
      await run(`Array.from(document.querySelectorAll('.recent-section tbody tr')).find(${match}).click()`);
      const selector=`.desktop-workspace:not([hidden]) [data-result-id="${result.id}"]`;
      await until(()=>run(`(()=>{const image=document.querySelector(${JSON.stringify(selector+' img')});return Boolean(image?.complete && image.naturalWidth>0);})()`));
      await screen(name+'-result-ui');item.overlayUi=true;
      if(analysis!=='xray'){
        await run(`Array.from(document.querySelectorAll('.desktop-workspace:not([hidden]) .result-view-actions button')).find(b=>b.textContent==='3D anatomy' && !b.disabled).click()`);
        await until(()=>run(`Boolean(document.querySelector(${JSON.stringify(selector+' canvas')})) && !document.querySelector('.desktop-workspace:not([hidden]) .scene-loading')`));
        await new Promise(r=>setTimeout(r,3000));
        const errors=await run(`Array.from(document.querySelectorAll('.desktop-workspace:not([hidden]) [role=alert]')).map(e=>e.textContent).filter(Boolean)`);assert.deepEqual(errors,[]);
        await screen(name+'-3d-ui');item.meshUi=true;
      }
      if(analysis==='mri'){
        const rawHash=await hash(publication.mask);item.variants={};
        for(const variant of ['pp500','strong']){
          const changed=await call('variant',result.id,variant);assert.equal(changed.variant,variant);
          await until(async()=>{const current=(await call('results',analysis)).find(r=>r.id===result.id);if(['failed','interrupted'].includes(current.meshState))throw Error('Variant mesh failed');return current.meshState==='ready';},300);
          const image=await call('resultPreview',result.id,{view:'axial'});assert.ok(image.image.startsWith('data:image/png;base64,'));
          assert.equal(await hash(publication.mask),rawHash,'Raw changed during postprocessing');
          encrypted(read(path.join(storage,'runs',result.id,'published.json')).mask);item.variants[variant]={overlay:true,mesh:true,rawPreserved:true};save();
        }
        await call('variant',result.id,'raw');
        await until(async()=>(await call('results',analysis)).find(r=>r.id===result.id)?.meshState==='ready',300);
      }
      assert.equal(await hash(source),item.inputSha256);item.passed=true;item.stage='complete';console.log(name+': '+(previous?'saved result':'real input -> encrypted mask')+' -> measurements/overlay'+(analysis==='xray'?'':'/3D')+' passed');
    }catch(error){item.error=String(error.stack || error);console.error(name+': '+error.message);await call('cancel',analysis).catch(()=>{});}
    save();
  }
  report.complete=true;report.passed=Object.values(report.cases).every(item=>item.passed);report.finishedAt=new Date().toISOString();save();return report;
}
module.exports={runSamples};
