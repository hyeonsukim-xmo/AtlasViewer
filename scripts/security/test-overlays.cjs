const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const PNG=require('../../desktop/publication-image.cjs'),S=require('../../desktop/publication-protocol.cjs');
const {openOverlayReview}=require('../../desktop/overlay-review.cjs'),{openSync}=require('../../desktop/sync.cjs'),{openRemote}=require('../../desktop/remote-results.cjs');
const {encryptArtifact}=require('../../desktop/publication-crypto.cjs'),{verifyPending}=require('./result-verifier.cjs');
const F=require('./publication-test-fixtures.cjs'),A=require('./account-test-fixtures.cjs');
const options={view:'axial',index:2,window:'soft',opacity:.45,classIds:null,side:'all'};
const rgb=()=>({width:100,height:80,pixels:crypto.randomBytes(100*80*3)});
const image=bytes=>({image:'data:image/png;base64,'+bytes.toString('base64'),view:'axial',index:2,count:130,sides:['A','P','R','L']});

test('opaque PNG roundtrip and irreversible redaction; CRC, dimensions, metadata and decompression overflow rejected',()=>{
  const source=rgb(),bytes=PNG.encode(source);assert.deepEqual(PNG.decode(bytes),source);
  const edited=PNG.decode(PNG.redact(source,[{x:1,y:1,width:20,height:10}]));
  for(let y=1;y<11;y++)assert.ok(edited.pixels.subarray((y*100+1)*3,(y*100+21)*3).every(v=>v===0));
  assert.deepEqual(edited.pixels.subarray(0,300),source.pixels.subarray(0,300));
  assert.notEqual(S.hash(edited.pixels),S.hash(source.pixels));assert.ok(source.pixels.some(v=>v!==0));
  assert.throws(()=>PNG.redact(source,[{x:95,y:0,width:20,height:10}]));assert.throws(()=>PNG.decode(Buffer.concat([bytes,Buffer.from('private metadata')])));
  const corrupt=Buffer.from(bytes);corrupt[35]^=1;assert.throws(()=>PNG.decode(corrupt));
  const huge=Buffer.from(bytes);huge.writeUInt32BE(999999,16);huge.writeUInt32BE(zlib.crc32(huge.subarray(12,29)),29);assert.throws(()=>PNG.decode(huge));
  const ancillary=Buffer.alloc(16);ancillary.writeUInt32BE(4);ancillary.write('tEXt',4);ancillary.write('NAME',8);ancillary.writeUInt32BE(zlib.crc32(ancillary.subarray(4,12)),12);
  assert.throws(()=>PNG.decode(Buffer.concat([bytes.subarray(0,33),ancillary,bytes.subarray(33)])));
  const bomb=zlib.deflateSync(Buffer.alloc((source.width*3+1)*source.height+1)),idat=Buffer.alloc(bomb.length+12);idat.writeUInt32BE(bomb.length);idat.write('IDAT',4);bomb.copy(idat,8);idat.writeUInt32BE(zlib.crc32(idat.subarray(4,-4)),idat.length-4);
  assert.throws(()=>PNG.decode(Buffer.concat([bytes.subarray(0,33),idat,bytes.subarray(-12)])));
});

test('privacy review is bound to final pixels, fixed revision and current account; cancelled or changed review cannot approve',async()=>{
  const source=F.source(),bytes=PNG.encode(rgb()),state={state:'signed-in',me:{subject:'manager',memberships:[{orgId:'org',workspaceId:'work',roles:['analyst']}]},workspace:{orgId:'org',workspaceId:'work'},deviceOrgId:'org',installationId:'pc'};
  let enqueued=0,release;
  const account={status:()=>state,refresh:async()=>{}},imaging={publicationSource:async()=>source,publicationPreview:async()=>image(bytes)};
  const review=openOverlayReview({account,imaging,enqueue:async(ref,s,b,o,pixels)=>{enqueued++;assert.equal(o.privacyReview.sha256,S.hash(pixels));assert.equal(b.subject,'manager');return {};}});
  try{
    const ref={id:'result',revision:source.identity.analysisRevision},d=await review.create(ref,options),e=review.redact(d.id,[{x:0,y:0,width:5,height:5}]);
    await assert.rejects(review.approve(d.id,d.sha256),/REVIEW_CHANGED/);assert.equal(enqueued,0);
    await review.approve(e.id,e.sha256);assert.equal(enqueued,1);await assert.rejects(review.approve(e.id,e.sha256),/EXPIRED/);
    const next=await review.create(ref,options);state.me.subject='other';await assert.rejects(review.approve(next.id,next.sha256),/EXPIRED/);
    state.me.subject='manager';const cancelled=await review.create(ref,options);review.discard(cancelled.id);await assert.rejects(review.approve(cancelled.id,cancelled.sha256));
    imaging.publicationPreview=async()=>{await new Promise(r=>{release=r;});return image(bytes);};const pending=review.create(ref,options);await new Promise(r=>setImmediate(r));state.workspace.workspaceId='other';release();await assert.rejects(pending);
  }finally{review.close();}
});

test('approved image resumes encrypted upload, survives mesh and restart, reads with ACL, and is removed with result tombstone',async t=>{
  const f=await F.fixture(t),bytes=PNG.encode(rgb());await f.rpc('approve-origin',{originStoreId:f.source.identity.originStoreId});
  const safeStorage=A.safeStorage(),directory=path.join(f.root,'overlay-outbox');let offline=false,mesh=null;
  const account={status:()=>f.account.status(),refresh:()=>f.account.refresh(),publicationRequest:async(route,body,binding)=>{
    if(offline)throw TypeError('offline');const value=await f.account.publicationRequest(route,body,binding);if(route.endsWith('/complete'))await verifyPending(f.root,f.keys);return value;
  }};
  const imaging={publicationSource:async()=>f.source,publicationPreview:async()=>image(bytes),exportPublication:(_,opts)=>F.pythonExport(f.root,opts),publicationMesh:async()=>mesh};
  let sync=openSync({directory,safeStorage,account,imaging,intervalMs:1e8});
  const ref={id:'case',revision:f.source.identity.analysisRevision},draft=await sync.review.create(ref,options),edited=sync.review.redact(draft.id,[{x:0,y:0,width:20,height:10}]);
  offline=true;await sync.review.approve(edited.id,edited.sha256);await sync.tick();const job=sync.status().jobs[0];assert.equal(job.state,'waiting_network');
  assert.ok(!fs.readFileSync(path.join(directory,job.id+'.overlay')).includes(Buffer.from(edited.image.slice(22))));await sync.close();
  sync=openSync({directory,safeStorage,account,imaging,intervalMs:1e8});t.after(()=>sync.close());offline=false;sync.retry(job.id);
  for(let i=0;i<8;i++)await sync.tick();
  assert.equal(sync.status().jobs[0].overlayState,'ready');assert.equal(sync.status().jobs[0].meshState,'pending');assert.equal(fs.existsSync(path.join(directory,job.id+'.overlay')),false);
  let saved=(await f.rpc('list'))[0];assert.equal(saved.overlayState,'ready');const read=await f.rpc('read',{resultId:saved.resultId});assert.equal(read.overlay.privacyReview.sha256,edited.sha256);assert.ok(!JSON.stringify(read).includes('PRIVATE PATIENT'));
  const remote=openRemote({account:f.account});t.after(()=>remote.close());let [detail]=await remote.read([saved.resultId]);const key=detail.overlay.url.split('/').at(-1).slice(0,-4);
  const response=await remote.model(key,'overlay');assert.equal(response.headers.get('content-type'),'image/png');assert.equal(S.hash(Buffer.from(await response.arrayBuffer())),edited.sha256);
  await assert.rejects(remote.model(key,'mesh'));await assert.rejects(f.rpc('overlay-part',{resultId:saved.resultId,revision:saved.attachmentRevision,sha256:'a'.repeat(64),index:0}));
  mesh=F.meshFile(f.root);for(let i=0;i<4;i++)await sync.tick();saved=(await f.rpc('list'))[0];assert.equal(saved.meshState,'ready');assert.equal(saved.overlayState,'ready');
  f.service.db.prepare('UPDATE attempts SET expires=0').run();f.service.sweep();assert.equal((await f.rpc('read',{resultId:saved.resultId})).overlay.sha256,edited.sha256);
  const a=await F.attempt(f),attemptId=crypto.randomUUID(),dir=path.join(f.root,attemptId);fs.mkdirSync(dir);
  const artifact=await encryptArtifact([bytes],'overlay',dir,f.scope,a.manifest.content.identity,attemptId,f.config.meshPublicKey);
  const m={...a.manifest,attemptId,artifact,overlay:{...read.overlay},attachmentRevision:saved.attachmentRevision};delete m.overlay.sha256;delete m.overlay.bytes;
  await assert.rejects(f.rpc('begin',m),/INVALID/,'changed pixels require a new review');
  m.overlay.privacyReview.sha256=artifact.sha256;m.overlay.privacyReview.subject='forged';await assert.rejects(f.rpc('begin',m),/INVALID/);
  m.overlay.privacyReview.subject=f.scope.subject;m.overlay.privacyReview.policy='obsolete';await assert.rejects(f.rpc('begin',m),/INVALID/);
  m.overlay.privacyReview.policy='exmo-no-identifiers-v1';m.attachmentRevision=0;await assert.rejects(f.rpc('begin',m),/ATTACHMENT_CONFLICT/);
  m.attachmentRevision=saved.attachmentRevision;m.overlay.width++;await F.upload(f,{dir,manifest:m});await f.rpc('complete',{attemptId});await verifyPending(f.root,f.keys);
  await assert.rejects(f.rpc('complete',{attemptId}),/ARTIFACT_INVALID/,'authenticated PNG still requires matching dimensions');
  assert.equal((await f.rpc('read',{resultId:saved.resultId})).overlay.sha256,edited.sha256,'failed replacement preserves published image');
  f.accounts.membership('manager','hospital-a','research','Research',[]);await assert.rejects(remote.model(key,'overlay').then(r=>r.arrayBuffer()));
  f.accounts.membership('manager','hospital-a','research','Research',['analyst','data-admin']);await f.rpc('delete',{resultId:saved.resultId,revision:saved.attachmentRevision});f.service.sweep();
  assert.equal(f.service.db.prepare('SELECT * FROM publication_overlays').all().length,0);await assert.rejects(f.rpc('read',{resultId:saved.resultId}));
});

test('partially uploaded Overlay resumes only missing parts without republishing core; cancelled replacement keeps prior image',async t=>{
  const f=await F.fixture(t);await f.rpc('approve-origin',{originStoreId:f.source.identity.originStoreId});
  const directory=path.join(f.root,'partial-overlay'),safeStorage=A.safeStorage();let interrupted=true,parts=[],imageAttempt=null;
  const bytes=PNG.encode({width:1000,height:800,pixels:crypto.randomBytes(1000*800*3)});
  const account={status:()=>f.account.status(),refresh:()=>f.account.refresh(),publicationRequest:async(route,body,binding)=>{
    if(route.endsWith('/begin')&&body.artifact.kind==='overlay')imageAttempt=body.attemptId;
    if(route.endsWith('/part')&&body.attemptId===imageAttempt){if(interrupted&&body.index===1)throw TypeError('network lost');parts.push(body.index);}
    const value=await f.account.publicationRequest(route,body,binding);if(route.endsWith('/complete'))await verifyPending(f.root,f.keys);return value;
  }};
  const imaging={publicationSource:async()=>f.source,publicationPreview:async()=>image(bytes),exportPublication:(_,opts)=>F.pythonExport(f.root,opts),publicationMesh:async()=>null};
  let sync=openSync({directory,safeStorage,account,imaging,intervalMs:1e8});const ref={id:'result',revision:f.source.identity.analysisRevision};
  let d=await sync.review.create(ref,options);await sync.review.approve(d.id,d.sha256);
  for(let i=0;i<5;i++)await sync.tick();assert.equal(sync.status().jobs[0].state,'waiting_network');assert.deepEqual(parts,[0]);
  assert.equal((await f.rpc('list')).length,1);assert.equal((await f.rpc('list'))[0].overlayState,'empty');
  const jobId=sync.status().jobs[0].id;await sync.close();sync=openSync({directory,safeStorage,account,imaging,intervalMs:1e8});t.after(()=>sync.close());
  interrupted=false;parts=[];sync.retry(jobId);for(let i=0;i<5;i++)await sync.tick();assert.deepEqual(parts,[1,2]);assert.equal(sync.status().jobs[0].overlayState,'ready');
  const saved=(await f.rpc('list'))[0];assert.equal((await f.rpc('read',{resultId:saved.resultId})).overlay.sha256,d.sha256);
  d=await sync.review.create(ref,options);const changed=sync.review.redact(d.id,[{x:0,y:0,width:10,height:10}]);interrupted=true;
  await sync.review.approve(changed.id,changed.sha256);for(let i=0;i<3;i++)await sync.tick();assert.equal(sync.status().jobs[0].state,'waiting_network');
  sync.cancel(jobId);await sync.tick();assert.equal(sync.status().jobs[0].state,'cancelled');assert.equal(sync.status().jobs[0].overlayState,null);assert.equal((await f.rpc('read',{resultId:saved.resultId})).overlay.sha256,d.sha256);
  assert.equal(fs.existsSync(path.join(directory,jobId+'.overlay')),false);
});
