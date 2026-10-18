const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const F=require('./publication-test-fixtures.cjs'),A=require('./account-test-fixtures.cjs');
const ops=require('./results-ops.cjs'),{generate}=require('./viewer-deploy.cjs');
test('signed results backup restores encrypted artifacts, ACL context and deletion tombstones; tampering fails closed',async t=>{
  const f=await F.fixture(t);await f.rpc('approve-origin',{originStoreId:f.source.identity.originStoreId});
  const first=await F.commit(f,await F.attempt(f));
  const context=Object.fromEntries(['caseId','studyId','acquisitionId'].map(k=>[k,require('node:crypto').randomUUID()]));
  await f.rpc('context',{resultId:first.resultId,context});
  const source=F.source();source.identity.originStoreId=f.source.identity.originStoreId;
  const second=await F.commit(f,await F.attempt(f,source));await f.rpc('delete',{resultId:second.resultId,revision:0});
  const root=A.temporary(t),backup=path.join(root,'backup'),restored=path.join(root,'restored');
  const config=path.join(path.dirname(f.root),'public.json'),key=path.join(path.dirname(f.root),'private-result-keys','receipt.pem');
  ops.backup(f.root,config,key,backup);const verified=ops.verify(backup,f.config.receiptPublicKey);
  assert.ok(!verified.files.some(r=>/pem|private/.test(r.path)));ops.restore(backup,f.config.receiptPublicKey,restored);
  const {Results}=require('./results-server.cjs'),service=new Results(restored,f.authority.db,f.config);
  try{assert.equal(service.list({sub:'manager'},f.scope).length,1);assert.equal(service.read({sub:'manager'},f.scope,first.resultId).context.caseId,context.caseId);
    assert.equal(service.db.prepare('SELECT deleted FROM publications WHERE id=?').get(second.resultId).deleted,1);
    assert.equal(service.db.prepare('SELECT count(*) AS n FROM result_audit').get().n>0,true);
  }finally{service.close();}
  assert.throws(()=>ops.restore(backup,f.config.receiptPublicKey,restored));
  assert.throws(()=>ops.backup(f.root,config,key,path.join(f.root,'nested')));
  fs.writeFileSync(path.join(backup,'unexpected.pem'),'not allowed');assert.throws(()=>ops.verify(backup,f.config.receiptPublicKey));fs.unlinkSync(path.join(backup,'unexpected.pem'));
  const artifact=verified.files.find(r=>r.path.endsWith('.part'));fs.appendFileSync(path.join(backup,artifact.path),'corrupt');assert.throws(()=>ops.verify(backup,f.config.receiptPublicKey),/integrity/);
});
test('deployment templates keep Viewer, Desktop API and private verifier boundaries separate',t=>{
  const root=A.temporary(t),output=path.join(root,'deploy');generate('viewer.example.invalid',output);
  const viewer=fs.readFileSync(path.join(output,'exmo-viewer.service'),'utf8'),verifier=fs.readFileSync(path.join(output,'exmo-verifier.service'),'utf8'),nginx=fs.readFileSync(path.join(output,'exmo-viewer.conf'),'utf8');
  assert.match(viewer,/InaccessiblePaths=.*verifier-keys/);assert.match(viewer,/EnvironmentFile=/);assert.match(verifier,/User=exmo-verifier/);assert.match(verifier,/UMask=0007/);
  assert.match(nginx,/proxy_buffering off/);assert.match(nginx,/location \/health\/ \{ return 404/);assert.match(nginx,/access_log off/);assert.match(nginx,/TLSv1.2 TLSv1.3/);assert.ok(!nginx.includes('root '));
  assert.throws(()=>generate('bad;host',path.join(root,'invalid')));assert.throws(()=>generate('viewer.example.invalid',output));
});
