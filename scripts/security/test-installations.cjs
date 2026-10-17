const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const S=require('../../desktop/security/selection.cjs'),E=require('../../desktop/security/execution.cjs');
const {openInstallations}=require('../../desktop/security/installations.cjs');
const {fixture,authority}=require('./selection-fixture.cjs');
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'exmo-install-')),a=authority();t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});return {root,a};}
test('all selected combinations preserve exact closures and readers, reuse shared files, and reject unlicensed rollback',async t=>{
  const {root,a}=setup(t),bundle=path.join(root,'bundle');fixture(bundle,a);
  const grants=[];
  for(const names of [['ct'],['mri'],['xray'],['ct','mri'],['ct','xray'],['mri','xray'],['ct','mri','xray']]){
    const store=openInstallations({root:path.join(root,names.join('-')),issuer:a.publicKey,profile:a.profile});
    await store.install(bundle,names,async input=>{grants.push(S.selection(input.token,a.publicKey).selection);});
    assert.deepEqual(store.status().solutions.filter(r=>r.installed).map(r=>r.analysis),names);
    const reader=await store.acquire('reader');assert.ok(!fs.existsSync(path.join(reader.engineRoot,'packages')));assert.ok(!fs.existsSync(path.join(reader.engineRoot,'envs/ct')));
    for(const name of names){const current=await store.acquire(name);const checked=S.inspectSet(current.engineRoot,a.publicKey,a.profile);
      assert.deepEqual(Object.keys(checked.policy.components),S.GRAPH[name]);
      const common=path.join(current.engineRoot,'python/python.exe');assert.equal(fs.statSync(common).ino,fs.statSync(path.join(reader.engineRoot,'python/python.exe')).ino);
      const engine=name==='xray'?'ap':name,job={analysis:name,...E.scope({analysis:name}),...(name==='xray'?{route:'AP'}:{})};
      assert.deepEqual(E.binding(job,{...current,issuer:a.publicKey},'analyze',checked.policy.models[engine]),E.fromSelection(job,checked.token,checked.records,a.publicKey,'analyze',checked.policy.models[engine]));
      current.release();
    }
    for(const name of names)await store.remove(name);
    assert.ok(store.status().solutions.every(r=>!r.installed));const remaining=await store.acquire('reader',reader.readerId);remaining.release();reader.release();await store.collect();store.close();
  }
  assert.ok(grants.includes('ct') && grants.includes('mri') && grants.includes('xray'));
});
test('updates pin running versions, archive readers, survive interruption, and keep independent solutions usable after corruption',async t=>{
  const {root,a}=setup(t),one=path.join(root,'one'),two=path.join(root,'two');fixture(one,a);fixture(two,a,'test-v2');
  let fail=false;const options={root:path.join(root,'store'),issuer:a.publicKey,profile:a.profile,checkpoint:async phase=>{if(fail && phase==='before-commit')throw Error('power interruption');}};
  let store=openInstallations(options);await store.install(one,['ct','mri'],async()=>{});
  const original=await store.acquire('ct'),reader=await store.acquire('reader');
  assert.equal(store.legacyReader(),reader.readerId);
  fail=true;await assert.rejects(store.install(two,['ct'],async()=>{}),/interruption/);
  let check=await store.acquire('ct');assert.equal(check.engineRoot,original.engineRoot);check.release();fail=false;
  await store.install(two,['ct'],async()=>{});check=await store.acquire('ct');assert.notEqual(check.engineRoot,original.engineRoot);
  assert.equal(store.legacyReader(),reader.readerId);
  assert.ok(fs.existsSync(original.engineRoot));assert.ok(fs.existsSync(reader.engineRoot));check.release();
  await assert.rejects(store.rollback('ct',async()=>{throw Error('revoked digest');}),/revoked/);
  await store.remove('ct');assert.ok(fs.existsSync(original.engineRoot),'running version was deleted');original.release();await store.collect();assert.ok(!fs.existsSync(original.engineRoot));
  reader.release();store.close();store=openInstallations(options);await store.recover();check=await store.acquire('reader',reader.readerId);check.release();
  await store.install(two,['ct'],async()=>{});const ct=await store.acquire('ct');fs.appendFileSync(path.join(ct.engineRoot,'packages/EXMO_CT/runtime.py'),'tampered');ct.release();
  await assert.rejects(store.acquire('ct'));
  const mri=await store.acquire('mri');mri.release();assert.equal(store.status().solutions.find(r=>r.analysis==='ct').state,'repair-required');store.close();
});

test('disk/access failures and authorization loss at commit preserve the previous active selection',async t=>{
  const {root,a}=setup(t),one=path.join(root,'one'),two=path.join(root,'two');fixture(one,a);fixture(two,a,'test-v2');
  const store=openInstallations({root:path.join(root,'store'),issuer:a.publicKey,profile:a.profile});
  await store.install(one,['ct'],async()=>{});const before=await store.acquire('ct');
  for(const code of ['ENOSPC','EACCES','EBUSY']){
    const copy=t.mock.method(fs.promises,'copyFile',async()=>{throw Object.assign(Error(code),{code});});
    await assert.rejects(store.install(two,['ct'],async()=>{}),error=>error.code===code);copy.mock.restore();
    const current=await store.acquire('ct');assert.equal(current.engineRoot,before.engineRoot);current.release();
  }
  let checks=0;await assert.rejects(store.install(two,['ct'],async()=>{if(++checks===2)throw Error('authorization revoked during staging');}),/revoked/);
  const current=await store.acquire('ct');assert.equal(current.engineRoot,before.engineRoot);current.release();before.release();
  await store.recover();store.close();
});
test('wrong profile, altered index, extra executable and junction are rejected before activation',async t=>{
  const {root,a}=setup(t),bundle=path.join(root,'bundle');fixture(bundle,a);
  assert.throws(()=>S.catalog(bundle,a.publicKey,'customer'));
  const store=openInstallations({root:path.join(root,'store'),issuer:a.publicKey,profile:a.profile});
  const common=path.join(bundle,'components/common/content'),extra=path.join(common,'adapters/extra.py');fs.writeFileSync(extra,'bad');
  await assert.rejects(store.install(bundle,['ct'],async()=>{}));assert.ok(!store.status().solutions.some(r=>r.installed));fs.unlinkSync(extra);
  const junction=path.join(common,'linked');fs.symlinkSync(path.join(common,'python'),junction,'junction');
  await assert.rejects(store.install(bundle,['ct'],async()=>{}));fs.unlinkSync(junction);
  const index=path.join(bundle,'components/ct/files.json');fs.appendFileSync(index,' ');await assert.rejects(store.install(bundle,['ct'],async()=>{}),/signature/);
  assert.ok(!store.status().solutions.some(r=>r.installed));store.close();
});

test('separate installs share the GPU and independent updates retain each product rollback',async t=>{
  const {root,a}=setup(t),one=path.join(root,'one'),two=path.join(root,'two');fixture(one,a);fixture(two,a,'test-v2');
  const store=openInstallations({root:path.join(root,'store'),issuer:a.publicKey,profile:a.profile,checkpoint:async phase=>{if(phase==='before-commit')await store.collect();}});
  await store.install(one,['ct'],async()=>{});const ct=await store.acquire('ct');
  await store.install(one,['xray'],async()=>{});const xray=await store.acquire('xray');
  const shared='envs/ap/Lib/site-packages/cryptography/__init__.py';assert.equal(fs.statSync(path.join(ct.engineRoot,shared)).ino,fs.statSync(path.join(xray.engineRoot,shared)).ino);
  await store.install(two,['ct'],async()=>{});await store.install(two,['xray'],async()=>{});
  await store.rollback('ct',async()=>{});let restored=await store.acquire('ct');assert.equal(restored.engineRoot,ct.engineRoot);restored.release();
  await store.rollback('xray',async()=>{});restored=await store.acquire('xray');assert.equal(restored.engineRoot,xray.engineRoot);restored.release();
  ct.release();xray.release();store.close();
});

test('reinstall repairs a corrupted common reader rather than trusting matching metadata',async t=>{
  const {root,a}=setup(t),bundle=path.join(root,'bundle');fixture(bundle,a);
  const store=openInstallations({root:path.join(root,'store'),issuer:a.publicKey,profile:a.profile});
  await store.install(bundle,['ct'],async()=>{});const prior=await store.acquire('reader');
  fs.appendFileSync(path.join(prior.engineRoot,'adapters/imaging-worker.py'),'corrupted');prior.release();
  await assert.rejects(store.acquire('reader'));await store.install(bundle,[],null,{commonOnly:true});
  const repaired=await store.acquire('reader');assert.notEqual(repaired.engineRoot,prior.engineRoot);repaired.release();
  await assert.rejects(store.acquire('ct'));await store.install(bundle,['ct'],async()=>{});
  const ct=await store.acquire('ct');assert.equal(ct.readerId,repaired.readerId);ct.release();
  const archived=await store.acquire('reader',prior.readerId);assert.equal(archived.readerId,repaired.readerId);archived.release();store.close();
});
