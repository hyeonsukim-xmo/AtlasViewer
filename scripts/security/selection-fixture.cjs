const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const M=require('../../desktop/security/model-package.cjs'),S=require('../../desktop/security/selection.cjs');
const {sealCatalog}=require('./selection-payload.cjs');
function fixture(root,authority,version='test-v1'){
  const write=(id,name,data)=>{const file=path.join(root,'components',id,'content',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);};
  const common=['python/python.exe','envs/reader/Lib/site-packages/numpy/__init__.py','envs/security/Lib/site-packages/cryptography/__init__.py','adapters/imaging-worker.py','adapters/model-runner.py','adapters/model_security.py','adapters/runtime_bootstrap.py','adapters/imaging-palette.json','verified-packages.json'];
  for(const name of common)write('common',name,'fixture:'+name+version);
  write('common','adapters/model-policy.json',JSON.stringify({profile:authority.profile,issuerPublicKey:authority.publicKey.export({type:'spki',format:'pem'}),licenseVersion:3}));
  for(const [id,env] of [['gpu','ap'],['ct','ct'],['mri','mri'],['xray','lat']])write(id,`envs/${env}/Lib/site-packages/cryptography/__init__.py`,'fixture:'+env+version);
  const models={};
  for(const engine of M.ENGINES){
    const id=['ct','mri'].includes(engine)?engine:'xray',family={ct:'EXMO_CT',mri:'EXMO_MRI',xray:'EXMO_XRAY'}[id],prefix='packages/'+family+'/';
    const data=Buffer.from('fixture:'+engine+version),asset=Buffer.alloc(data.length+16,7);
    const files=[{path:'runtime.py',size:data.length,sha256:M.hash(data)}];
    // Shared X-ray manifests must describe the same vendor source bytes.
    const shared=Buffer.from('fixture:'+id+version);files[0]={path:'runtime.py',size:shared.length,sha256:M.hash(shared)};write(id,prefix+'runtime.py',shared);
    if(engine==='mri')for(const name of ['run_inference.py','model_identity.json','runtime_hashes.json','weights/final.safetensors.manifest.json']){files.push({path:name,size:data.length,sha256:M.hash(data)});write(id,prefix+name,data);}
    const value=engine==='mri'?{schema:'exmo-mri-package-v1',engine,version,loader:'mri-safetensors-full6-v1',files,size:data.length,sha256:M.hash(data),cipherSha256:M.hash(asset),nonce:Buffer.alloc(12).toString('base64url')}:
      {schema:'exmo-model-package-v2',engine,version,loader:engine+'-memory-v1',files,assets:[{path:engine+'.pth',size:data.length,sha256:M.hash(data),cipherSha256:M.hash(asset),nonce:Buffer.alloc(12).toString('base64url')}]};
    write(id,prefix+(engine==='mri'?'weights/final.safetensors.enc':engine+'.pth.enc'),asset);
    const token=M.sign(value,authority.key);models[engine]=M.hash(Buffer.from(token));write(id,prefix+(['ct','mri'].includes(engine)?'model-package.json':`model-package-${engine}.json`),JSON.stringify({token}));
  }
  sealCatalog(authority,root,version,models);return S.catalog(root,authority.publicKey,authority.profile);
}
function authority(profile='internal'){const pair=crypto.generateKeyPairSync('ed25519');return {key:pair.privateKey,publicKey:pair.publicKey,profile};}
module.exports={fixture,authority};
