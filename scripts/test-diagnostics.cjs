const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {diagnose,workerError,userError,catalog}=require('../desktop/diagnostics.cjs');
const {resultModelResponse}=require('../desktop/result-model-response.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'exmo-diagnostics-'));
(async()=>{
  const english=require('../desktop/ui/locales/en.json');
  for(const entry of Object.values(catalog)){assert.ok(english[entry.message]);assert.ok(english[entry.action]);}
  for(const [osCode,expected] of Object.entries({ENOENT:'FILE_MISSING',ENOSPC:'DISK_FULL',EACCES:'ACCESS_DENIED',EPERM:'ACCESS_DENIED',EBUSY:'FILE_BUSY',ENAMETOOLONG:'PATH_TOO_LONG',ENOMEM:'MEMORY'})){
    const issue=diagnose(Object.assign(Error('private patient path'),{code:osCode}),{stage:'finalize',caseId:'case-a',logRoot:root});
    assert.equal(issue.code,expected);assert.ok(!JSON.stringify(issue).includes('private patient path'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'diagnostics-private.jsonl'),'utf8').trim().split('\n').at(-1)).reference,issue.reference);
  }
  const stageIssue=diagnose(workerError({errorCode:'INFERENCE',error:'secret traceback'}),{stage:'native restore',code:'RESTORE'});
  assert.equal(stageIssue.code,'RESTORE');assert.ok(!JSON.stringify(stageIssue).includes('secret'));
  assert.equal(diagnose(userError('Known input rule')).message,'Known input rule');
  assert.equal(diagnose(workerError({errorCode:'ENGINE_STOPPED'}),{code:'CANCELLED'}).code,'CANCELLED');
  assert.equal(diagnose(Error('unknown secret'),{code:'RESULT_PROCESS'}).code,'RESULT_PROCESS');
  const deep=path.join(root,...Array(5).fill('long-result-folder-012345678901234567890123456789'));
  fs.mkdirSync(deep,{recursive:true});const file=path.join(deep,'model.glb');assert.ok(file.length>260);
  const bytes=Buffer.from('stream bytes');fs.writeFileSync(file,bytes);
  const response=resultModelResponse(file,root,'case-a');assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  const missing=resultModelResponse(path.join(root,'missing.glb'),root,'case-b');assert.equal(missing.status,404);
  assert.equal((await missing.json()).diagnostic.code,'FILE_MISSING');
  const invalid=resultModelResponse(root,root,'case-c');await assert.rejects(invalid.arrayBuffer());
  assert.ok(fs.readFileSync(path.join(root,'diagnostics-private.jsonl'),'utf8').includes(invalid.headers.get('X-EXMO-Reference')));
  console.log('PASS: resource causes, public/private separation, stage preservation, translated catalog, long-path streaming, missing/mid-stream failure references');
})().finally(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}).catch(error=>{console.error(error);process.exitCode=1;});
