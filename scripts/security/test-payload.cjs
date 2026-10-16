const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const M=require('../../desktop/security/model-package.cjs'),{verifyPayload,verifyPayloadAsync,safeName,hashFile,inventory}=require('../../desktop/security/payload.cjs'),{seal}=require('./payload.cjs');
test('signed payload binds every runtime file, all six complete model deliveries and exact index',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'exmo-payload-'));t.after(()=>{assert.ok(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 const pair=crypto.generateKeyPairSync('ed25519'),authority={key:pair.privateKey,publicKey:pair.publicKey,profile:'internal'};
 const write=(name,data)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);};
 for(const file of ['python/python.exe','verified-packages.json',...['ct','mri','ap','lat','security'].map(e=>`envs/${e}/Lib/site-packages/cryptography/__init__.py`)])write(file,'fixture');
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
