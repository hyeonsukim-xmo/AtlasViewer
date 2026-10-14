const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const backendPath=path.resolve(__dirname,'../desktop/imaging.cjs'),localRequire=createRequire(backendPath);
const output=path.resolve(__dirname,'../outputs/export-source-check');fs.mkdirSync(output,{recursive:true});
const store=fs.mkdtempSync(path.join(output,'storage-'));
const known={id:'known',analysis:'ct',metadata:{patientId:'000042',patientIssuer:'HOSPITAL',studyDate:'20261013'},sourceProof:{study_uid:'study-one',series_uid:'series-one'}};
const anon={id:'anonymous',analysis:'ct',metadata:{caseName:'Anonymous'},sourceProof:{study_uid:'study-two',series_uid:'series-two'}};
fs.writeFileSync(path.join(store,'library.json'),JSON.stringify([known,anon]));
const run=path.join(store,'runs','result-one');fs.mkdirSync(run,{recursive:true});fs.writeFileSync(path.join(run,'mask.nrrd'),'fixture');
fs.writeFileSync(path.join(run,'published.json'),JSON.stringify({record:anon,mask:path.join(run,'mask.nrrd'),result:run,
 summary:{id:'result-one',analysis:'ct',metadata:{caseName:'Anonymous'},rows:[]}}));
const palette=path.join(store,'palette.json');fs.writeFileSync(palette,'[]');
fs.writeFileSync(path.join(store,'source-metadata.json'),JSON.stringify({version:1,records:{known:{metadata:{patientId:'000042',studyDate:'20261013'}}}}));
const retained=path.join(store,'retained');fs.mkdirSync(retained);
fs.writeFileSync(path.join(retained,'input.nrrd'),'NRRD0005\nDICOM_PatientID:=00123\nDICOM_StudyDate:=20251012\nDICOM_SeriesDescription:=Axial\n\n');
const saved=path.join(store,'runs','saved-result');fs.mkdirSync(saved);fs.writeFileSync(path.join(saved,'mask.nrrd'),'fixture');
fs.writeFileSync(path.join(saved,'published.json'),JSON.stringify({record:{id:'cleared-input',analysis:'ct',input:path.join(retained,'validated-input.nii.gz'),metadata:{}},mask:path.join(saved,'mask.nrrd'),result:saved,
 summary:{id:'saved-result',inputId:'cleared-input',analysis:'ct',metadata:{caseName:'Anonymous'},rows:[]}}));
const handlers=new Map(),captured=[],exported=[];
const mock={exports:{}};
vm.runInNewContext(fs.readFileSync(backendPath,'utf8'),{module:mock,require:name=>
 name==='electron'?{ipcMain:{handle:(name,handler)=>handlers.set(name,handler),removeHandler:name=>handlers.delete(name)}}:
 name==='./results-export.cjs'?{exportResults:async(_window,publications,{sourceFor})=>{
  exported.push(publications.map(publication=>({summary:publication.summary,source:sourceFor(publication.record,publication)})));
  return {action:'save',count:publications.length};
 }}:name==='./image-menu.cjs'?{showImageMenu:async(_window,payload,{registry,source})=>{
  const identity=await registry.resolve(source);captured.push({source,identity});return {action:'cancel'};
 }}:localRequire(name),process,URL,setTimeout,clearTimeout,console,Buffer,AbortController});
const frame={url:'atlas://app/'};const window={webContents:{mainFrame:frame}};
const backend=mock.exports.installImaging(window,{storageRoot:store,engineRoot:store,scriptsRoot:store,palette});
const event={sender:window.webContents,senderFrame:frame};
const menu=source=>handlers.get('exmo:imaging:imageMenu')(event,{source,patientId:'UNTRUSTED'});
(async()=>{
 assert.ok((await menu({kind:'input',id:'known'})).ok);assert.equal(captured[0].identity.patientId,'000042');
 assert.equal(captured[0].source.studyUid,'study-one');
 assert.ok((await menu({kind:'input',id:'anonymous'})).ok);
 assert.ok((await menu({kind:'result',id:'result-one'})).ok);
 assert.equal(captured[1].identity.uuid,captured[2].identity.uuid);assert.equal(captured[2].source.resultId,'result-one');
 assert.equal(captured[2].identity.patientId,'');
 assert.equal((await menu({kind:'result',id:'missing'})).ok,false);
 await assert.rejects(handlers.get('exmo:imaging:imageMenu')({...event,senderFrame:{url:'https://example.com'}},{source:{kind:'input',id:'known'}}));
 const exportHandler=handlers.get('exmo:imaging:exportResults');
 assert.ok((await exportHandler(event,'ct',['result-one','result-one'],'en')).ok);
 assert.equal(exported[0].length,1);assert.equal(exported[0][0].source.studyUid,'study-two');
 assert.equal((await exportHandler(event,'ct',['result-one','missing'],'en')).ok,false);
 assert.equal((await exportHandler(event,'mri',['result-one'],'en')).ok,false);
 assert.equal((await exportHandler(event,'ct',[],'en')).ok,false);
 await assert.rejects(exportHandler({...event,senderFrame:{url:'https://example.com'}},'ct',['result-one'],'en'));
 assert.equal(exported.length,1);
 const assign=handlers.get('exmo:imaging:assignPatientStudy');
 assert.ok((await assign(event,'ct',['known'],{patientId:'000099',patientIssuer:'LOCAL'})).ok);
 assert.ok((await menu({kind:'input',id:'known'})).ok);
 assert.equal(captured.at(-1).identity.patientId,'000099');
 const listed=await handlers.get('exmo:imaging:list')(event,'ct');
 assert.equal(listed.value.find(r=>r.id==='known').metadata.patientId,'000099');
 assert.equal(listed.value.find(r=>r.id==='known').metadata.studyDate,'20261013');
 assert.equal(listed.value.find(r=>r.id==='anonymous').metadata.studyUid,'study-two');
 assert.equal((await assign(event,'mri',['known'],null)).ok,false);
 await assert.rejects(assign({...event,senderFrame:{url:'https://example.com'}},'ct',['known'],null));
 assert.ok((await menu({kind:'result',id:'saved-result'})).ok);
 assert.equal(captured.at(-1).identity.patientId,'00123');
 assert.ok((await exportHandler(event,'ct',['saved-result'],'en')).ok);
 assert.equal(exported.at(-1)[0].summary.metadata.patientId,'00123');
 assert.equal(exported.at(-1)[0].source.studyDate,'20251012');
 await backend.dispose();console.log('PASS: trusted export identity, manual override precedence, retained-header recovery for published results after library clearing, Excel propagation, unknown source and foreign frame rejection');
})().catch(error=>{console.error(error);process.exitCode=1;});
