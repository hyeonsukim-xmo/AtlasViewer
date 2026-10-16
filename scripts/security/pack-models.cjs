// Operator-side packaging only. No sample, result, training cache export or private key in the delivery.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const P=require('../../desktop/security/license-protocol.cjs');
const M=require('../../desktop/security/model-package.cjs');
const ASSETS={
  ct:['model/trial_230704_4_best.pth'],
  ap:['models/AP/model.pth'],
  lat_lt:Array.from({length:5},(_,i)=>`models/LAT_LT/fold_${i}/checkpoint_final.pth`),
  lat_rt:Array.from({length:5},(_,i)=>`models/LAT_RT/fold_${i}/checkpoint_final.pth`),
  'xray-classifier':['classification/models/dicom/training_features_4class_dicom_260711_corrected.npz',
    'classification/models/nrrd/training_features_4class_nrrd_260711.npz'],
};
function packageFile(engine){return engine==='ct'?'model-package.json':`model-package-${engine}.json`;}
function walk(root,relative,visit) {
  const absolute=path.join(root,relative),stat=fs.lstatSync(absolute);P.check(!stat.isSymbolicLink());
  if(stat.isDirectory())for(const name of fs.readdirSync(absolute).sort()) {
    if(name!=='__pycache__')walk(root,path.join(relative,name),visit);
  }
  else {P.check(stat.isFile());visit(relative.replaceAll(path.sep,'/'),stat);}
}
function encrypt(source,target,name,key,engine) {
  const stat=fs.lstatSync(source);P.check(stat.isFile() && !stat.isSymbolicLink() && stat.size>0 && stat.size<=M.MAX_WEIGHTS);
  const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from('EXMO/MODEL/v2/'+engine+'/'+name));
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const input=fs.openSync(source,'r'),output=fs.openSync(target,'wx'),buffer=Buffer.alloc(4*1024**2);
  const plain=crypto.createHash('sha256'),encrypted=crypto.createHash('sha256');let size=0;
  const write=data=>{encrypted.update(data);let offset=0;while(offset<data.length)offset+=fs.writeSync(output,data,offset,data.length-offset);};
  try {
    let count;
    while((count=fs.readSync(input,buffer,0,buffer.length,null))>0){size+=count;P.check(size<=M.MAX_WEIGHTS);const chunk=buffer.subarray(0,count);plain.update(chunk);write(cipher.update(chunk));}
    write(cipher.final());write(cipher.getAuthTag());fs.fsyncSync(output);
    P.check(size===stat.size && fs.fstatSync(input).mtimeMs===stat.mtimeMs,'Model changed while packaging');
    return {path:name,size,sha256:plain.digest('hex'),nonce:nonce.toString('base64url'),cipherSha256:encrypted.digest('hex')};
  } finally {buffer.fill(0);fs.closeSync(input);fs.closeSync(output);}
}
function packModels(authority,directory,source,output,version,family) {
  P.id(version);P.check(['ct','xray'].includes(family));source=path.resolve(source);output=path.resolve(output);
  P.check(!fs.existsSync(output) && output!==source && !output.startsWith(source+path.sep),'Use a new delivery directory');
  const engines=family==='ct'?['ct']:['ap','lat_lt','lat_rt','xray-classifier'];
  const files=[];
  const collect=name=>walk(source,name,(relative,stat)=>{
    if(!/\.(py|json)$/.test(relative))return;
    P.check(stat.size<=16*1024**2);files.push({path:relative,size:stat.size,sha256:M.hash(fs.readFileSync(path.join(source,relative)))});
  });
  for(const name of family==='ct'?['src','configs','provenance/source_inventory.json','run.py']:['code','classification','inference_config.json','label_mapping.json','models'])collect(name);
  // Evaluation reports can contain identifiers; only classifier inference dependencies are needed.
  const runtime=files.filter(f=>!f.path.startsWith('classification/models/') || /\/evaluation_manifest\.json$/.test(f.path));
  if(family==='ct')runtime.push({path:'samples/manifest.json',size:12,sha256:M.hash(Buffer.from('{"cases":[]}'))});
  else runtime.push({path:'sample_manifest.json',size:2,sha256:M.hash(Buffer.from('[]'))});
  fs.mkdirSync(output,{recursive:false});
  for(const record of runtime){
    const content=record.path==='samples/manifest.json'?Buffer.from('{"cases":[]}'):record.path==='sample_manifest.json'?Buffer.from('[]'):fs.readFileSync(path.join(source,record.path));
    P.check(M.hash(content)===record.sha256,'Runtime changed while packaging');
    const target=path.join(output,record.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content,{flag:'wx'});
  }
  const result={};
  for(const engine of engines){
    const key=crypto.randomBytes(32);
    try {
      const assets=ASSETS[engine].map(name=>encrypt(path.join(source,name),path.join(output,name+'.enc'),name,key,engine));
      const token=M.sign({schema:'exmo-model-package-v2',engine,version,loader:engine+'-memory-v1',assets,files:runtime},authority.key);
      M.manifest(token,authority.publicKey);const digest=M.hash(Buffer.from(token));
      const keys=path.join(directory,'model-keys');fs.mkdirSync(keys,{recursive:true,mode:0o700});
      fs.writeFileSync(path.join(keys,digest+'.key'),key,{flag:'wx',mode:0o600});
      fs.writeFileSync(path.join(output,packageFile(engine)),JSON.stringify({token}),{flag:'wx'});result[engine]=digest;
    }finally{key.fill(0);}
  }
  return result;
}
module.exports={ASSETS,packageFile,packModels,encrypt};
