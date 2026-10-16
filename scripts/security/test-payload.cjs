const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const M=require('../../desktop/security/model-package.cjs'),{verifyPayload,verifyPayloadAsync,safeName,hashFile,inventory}=require('../../desktop/security/payload.cjs'),{seal,slim,compactLayout}=require('./payload.cjs');
test('signed payload binds every runtime file, all six complete model deliveries and exact index',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'exmo-payload-'));t.after(()=>{assert.ok(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 const pair=crypto.generateKeyPairSync('ed25519'),authority={key:pair.privateKey,publicKey:pair.publicKey,profile:'internal'};
 const write=(name,data)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);};
 for(const file of ['python/python.exe','verified-packages.json',...['ct','mri','ap','lat','security'].map(e=>`envs/${e}/Lib/site-packages/cryptography/__init__.py`)])write(file,'fixture');
 for(const env of ['ap','lat'])for(const file of ['__init__.py','include/test.h','lib/development.lib','lib/runtime.dll','testing/__init__.py'])write(`envs/${env}/Lib/site-packages/torch/${file}`,'fixture');
 for(const file of ['python/Lib/test/test_math.py','envs/ct/Lib/site-packages/numpy/core/tests/test_data.py','envs/ct/Lib/site-packages/numpy/testing/__init__.py','envs/ap/Lib/site-packages/torch-2.7.dist-info/LICENSE'])write(file,'fixture');
 for(const engine of M.ENGINES){
  const family=engine==='mri'?'EXMO_MRI':engine==='ct'?'EXMO_CT':'EXMO_XRAY',prefix='packages/'+family+'/',data=Buffer.from('fixture'),asset=Buffer.alloc(data.length+16,7);
  const files=[{path:'runtime.py',size:data.length,sha256:M.hash(data)}];write(prefix+'runtime.py',data);
  if(engine==='mri')for(const name of ['run_inference.py','model_identity.json','runtime_hashes.json','weights/final.safetensors.manifest.json']){files.push({path:name,size:data.length,sha256:M.hash(data)});write(prefix+name,data);}
  const value=engine==='mri'?{schema:'exmo-mri-package-v1',engine,version:'test',loader:'mri-safetensors-full6-v1',files,size:data.length,sha256:M.hash(data),cipherSha256:M.hash(asset),nonce:Buffer.alloc(12).toString('base64url')}:
    {schema:'exmo-model-package-v2',engine,version:'test',loader:engine+'-memory-v1',files,assets:[{path:engine+'.pth',size:data.length,sha256:M.hash(data),cipherSha256:M.hash(asset),nonce:Buffer.alloc(12).toString('base64url')}]};
  write(prefix+(engine==='mri'?'weights/final.safetensors.enc':engine+'.pth.enc'),asset);
  write(prefix+(engine==='mri'||engine==='ct'?'model-package.json':`model-package-${engine}.json`),JSON.stringify({token:M.sign(value,authority.key)}));
 }
 const result=seal(authority,root,'test');assert.ok(result.files>10);assert.equal(verifyPayload(root,authority.publicKey).version,'test');
 const compact=root+'-compact';t.after(()=>{assert.ok(compact.startsWith(os.tmpdir()+path.sep));fs.rmSync(compact,{recursive:true,force:true});fs.rmSync(compact+'.report.json',{force:true});});
 const report=slim(authority,root,compact,'compact-test');assert.ok(report.after.files<result.files);assert.ok(report.after.bytes<result.bytes);
 assert.equal(verifyPayload(compact,authority.publicKey).version,'compact-test');
 assert.equal(verifyPayload(compact,authority.publicKey).layout,'xray-shared-v1');
 const compactManifest=path.join(compact,'payload.json'),originalManifest=fs.readFileSync(compactManifest);
 const compactPolicy=verifyPayload(compact,authority.publicKey);
 fs.writeFileSync(compactManifest,JSON.stringify({token:M.sign({...compactPolicy,layout:'unknown'},authority.key)}));
 assert.throws(()=>verifyPayload(compact,authority.publicKey),/layout/);fs.writeFileSync(compactManifest,originalManifest);
 assert.ok(fs.existsSync(path.join(compact,'envs/xray-common/Lib/site-packages/torch/lib/runtime.dll')));
 assert.ok(fs.existsSync(path.join(compact,'envs/ct/Lib/site-packages/numpy/testing/__init__.py')));
 assert.ok(fs.existsSync(path.join(compact,'envs/ap/Lib/site-packages/torch-2.7.dist-info/LICENSE')));
 assert.ok(!fs.existsSync(path.join(compact,'envs/lat/Lib/site-packages/torch')));
 assert.ok(!fs.existsSync(path.join(compact,'envs/xray-common/Lib/site-packages/torch/include')));
 assert.equal(verifyPayload(root,authority.publicKey).version,'test');
 assert.throws(()=>slim(authority,root,compact,'duplicate'));
 assert.throws(()=>slim(authority,root,path.join(root,'nested'),'nested'));
 assert.throws(()=>slim({...authority,profile:'customer'},root,root+'-wrong-profile','wrong-profile'),/profile mismatch/);
 assert.ok(!fs.existsSync(root+'-wrong-profile'));
 const records=JSON.parse(fs.readFileSync(path.join(root,'files.json')));
 const changed=records.map(r=>r.path==='envs/lat/Lib/site-packages/torch/__init__.py'?{...r,size:r.size+1}:r);
 assert.throws(()=>compactLayout(changed),/packages differ/);
 assert.throws(()=>compactLayout(records.filter(r=>r.path!=='envs/lat/Lib/site-packages/torch/__init__.py')),/packages differ/);
 const progress=[],timings={};
 assert.equal((await verifyPayloadAsync(root,authority.publicKey,(done,total)=>progress.push([done,total]),timings)).version,'test');
 assert.deepEqual(progress.at(-1),[result.files,result.files]);
 assert.ok(progress.every(([done,total],i)=>done<=total && (!i || done>=progress[i-1][0])));
 assert.equal(timings.files,result.files);assert.equal(timings.bytes,result.bytes);
 for(const name of ['indexMs','inventoryMs','bindingMs','hashMs','totalMs'])assert.ok(Number.isFinite(timings[name]) && timings[name]>=0);
 write('unexpected.py','x');assert.throws(()=>verifyPayload(root,authority.publicKey));fs.unlinkSync(path.join(root,'unexpected.py'));
 write('python/python.exe','changed');assert.throws(()=>verifyPayload(root,authority.publicKey));await assert.rejects(verifyPayloadAsync(root,authority.publicKey));write('python/python.exe','fixture');
 const file=path.join(root,'python/python.exe'),stamp=fs.statSync(file);
 write('python/python.exe','FIXTURE');fs.utimesSync(file,stamp.atime,stamp.mtime);
 await assert.rejects(verifyPayloadAsync(root,authority.publicKey));
 write('python/python.exe','fixture');
 const link=path.join(root,'linked');fs.symlinkSync(path.join(root,'python'),link,'junction');
 assert.throws(()=>inventory(root),/reparse/);await assert.rejects(verifyPayloadAsync(root,authority.publicKey));
 assert.throws(()=>inventory(link),/real directory/);fs.unlinkSync(link);
 const index=fs.readFileSync(path.join(root,'files.json'));write('files.json',Buffer.concat([index,Buffer.from(' ')]));assert.throws(()=>verifyPayload(root,authority.publicKey));write('files.json',index);
 assert.throws(()=>verifyPayload(root,crypto.generateKeyPairSync('ed25519').publicKey));
 for(const name of ['../escape','/absolute','x\\y','x:y','x/./y','x./y'])assert.throws(()=>safeName(name));
});

test('hashing handles empty, small and multi-block files without skipping bytes',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'exmo-hash-'));t.after(()=>{assert.ok(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 for(const size of [5*1024**2+13,0,17,4*1024**2,1]){
  const data=crypto.randomBytes(size),file=path.join(root,'data');fs.writeFileSync(file,data);
  assert.deepEqual(hashFile(file),{size,sha256:M.hash(data)});
 }
});
