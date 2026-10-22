const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {expiredSolutions,openModelExpiry}=require('../../desktop/security/model-expiry.cjs');
const {openInstallations}=require('../../desktop/security/installations.cjs');
const {solutions}=require('../../desktop/solutions.cjs');
const {fixture,authority}=require('./selection-fixture.cjs');
test('only actual model deadlines or signed contract expiry trigger removal, including offline',()=>{
  let now=100;
  const client={receipt:{decision:'allow',exp:101,entitlements:solutions.map((s,i)=>({solutionId:s.id,validUntil:i===0?200:null}))},time:()=>now,timeUntrusted:false};
  assert.deepEqual(expiredSolutions(null),[]);assert.deepEqual(expiredSolutions(client),[]);
  now=199;assert.deepEqual(expiredSolutions(client),[],'an expired offline lease must retain models');
  now=200;assert.deepEqual(expiredSolutions(client),[solutions[0].id]);
  client.timeUntrusted=true;assert.deepEqual(expiredSolutions(client),[]);
  client.receipt={decision:'expired',exp:100,entitlements:[]};
  assert.deepEqual(expiredSolutions(client),solutions.map(s=>s.id));
  for(const decision of ['suspended','revoked']){client.receipt={decision,entitlements:[]};assert.deepEqual(expiredSolutions(client),[]);}
});
test('expiry removes only the chosen model and rollback; pinned jobs, shared runtimes and saved data survive',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'exmo-expiry-')),a=authority();
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  const one=path.join(root,'one'),two=path.join(root,'two');fixture(one,a);fixture(two,a,'test-v2');
  const options={root:path.join(root,'store'),issuer:a.publicKey,profile:a.profile};
  let store=openInstallations(options);await store.install(one,['ct','mri','xray'],async()=>{});
  const old=await store.acquire('ct');old.release();await store.install(two,['ct'],async()=>{});
  const running=await store.acquire('ct'),workerRelease=store.retain(running),reader=await store.acquire('reader');reader.release();
  const saved=path.join(root,'imaging');fs.mkdirSync(saved);
  for(const file of ['input.nii.gz','measurements.json','surface.glb'])fs.writeFileSync(path.join(saved,file),'original:'+file);
  let expired=[];
  const expiry=openModelExpiry({licensing:{expiredSolutions:()=>expired},installations:store});
  t.after(()=>expiry.close());
  await expiry.sweep();assert.ok(store.status().solutions.every(s=>s.installed));
  expired=[solutions[0].id];await expiry.sweep();
  assert.equal(store.status().solutions.find(s=>s.analysis==='ct').installed,false);
  assert.equal(store.status().solutions.find(s=>s.analysis==='ct').canRollback,false);
  await assert.rejects(store.acquire('ct'),/not installed/);await assert.rejects(store.rollback('ct',async()=>{}),/No previous/);
  assert.ok(!fs.existsSync(old.engineRoot),'expired rollback model survived');
  assert.ok(fs.existsSync(running.engineRoot),'running analysis lost its pinned model');
  running.release();await expiry.sweep();assert.ok(fs.existsSync(running.engineRoot),'worker still retains the model');
  workerRelease();await expiry.sweep();assert.ok(!fs.existsSync(running.engineRoot));
  for(const analysis of ['mri','xray']){const context=await store.acquire(analysis);context.release();}
  const common=await store.acquire('reader',reader.readerId);common.release();
  for(const file of fs.readdirSync(saved))assert.equal(fs.readFileSync(path.join(saved,file),'utf8'),'original:'+file);
  await expiry.close();store.close();store=openInstallations(options);await store.recover();
  const reopened=await store.acquire('reader',reader.readerId);reopened.release();
  await store.install(one,['ct'],async()=>{});const interrupted=await store.acquire('ct');
  await store.remove('ct');assert.ok(fs.existsSync(interrupted.engineRoot));store.close();
  store=openInstallations(options);await store.recover();assert.ok(!fs.existsSync(interrupted.engineRoot),'restart retained expired bytes from an interrupted job');store.close();
});
test('automatic cleanup serializes checks, waits for installs, retries failures and stops at shutdown',async t=>{
  let busy=true,installed=true,removed=0,collected=0,release,fail=true;
  const store={status:()=>({busy,solutions:[{analysis:'ct',solutionId:solutions[0].id,installed}]}),
    async remove(){removed++;if(fail){fail=false;throw Error('temporary lock');}installed=false;},
    async collect(){collected++;await new Promise(r=>{release=r;});}};
  const expiry=openModelExpiry({licensing:{expiredSolutions:()=>[solutions[0].id]},installations:store});
  t.after(()=>expiry.close());
  await expiry.sweep();assert.equal(removed,0);busy=false;
  await assert.rejects(expiry.sweep(),/temporary lock/);
  const first=expiry.sweep();assert.equal(first,expiry.sweep());
  await Promise.resolve();assert.equal(removed,2);assert.equal(collected,1);
  let stopped=false;const stop=expiry.close().then(()=>{stopped=true;});
  await Promise.resolve();assert.equal(stopped,false);release();await first;await stop;
  await expiry.sweep();assert.equal(collected,1);
});
test('the timer removes expired models without a user action',async t=>{
  let removed=false,done;
  const complete=new Promise(resolve=>{done=resolve;});
  const expiry=openModelExpiry({licensing:{expiredSolutions:()=>[solutions[0].id]},installations:{
    status:()=>({busy:false,solutions:[{analysis:'ct',solutionId:solutions[0].id,installed:!removed}]}),
    async remove(){removed=true;done();},async collect(){},
  }});
  t.after(()=>expiry.close());
  const timeout=setTimeout(()=>done(),5000);t.after(()=>clearTimeout(timeout));
  await complete;assert.equal(removed,true);
});
test('a pending cleanup failure cannot interrupt normal app shutdown',async()=>{
  let fail;
  const expiry=openModelExpiry({licensing:{expiredSolutions:()=>[solutions[0].id]},installations:{
    status:()=>({busy:false,solutions:[{analysis:'ct',solutionId:solutions[0].id,installed:true}]}),
    remove:()=>new Promise((_,reject)=>{fail=()=>reject(Error('disk unavailable'));}),
  }});
  const rejected=assert.rejects(expiry.sweep(),/disk unavailable/),stopped=expiry.close();
  fail();await rejected;await stopped;
});
