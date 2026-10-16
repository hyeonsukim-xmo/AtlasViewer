// Operator-only: encrypted delivery goes to OUTPUT; data keys stay in AUTHORITY/model-keys.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const P=require('../../desktop/security/license-protocol.cjs');
const M=require('../../desktop/security/model-package.cjs');
const {Authority}=require('./license-server.cjs');
const {read}=require('../../desktop/security/storage.cjs');
function bytes(file,limit) {
  P.check(fs.lstatSync(file).isFile() && fs.statSync(file).size<=limit,'Invalid model source size/type');
  const value=fs.readFileSync(file);P.check(value.length<=limit);return value;
}
function pack(authority,directory,source,output,version) {
  P.id(version);
  source=path.resolve(source);output=path.resolve(output);
  P.check(!output.startsWith(source+path.sep) && output!==source && !fs.existsSync(output),'Use a new output directory outside the source bundle');
  const names=[];
  function collect(relative) {
    const file=path.join(source,relative),stat=fs.lstatSync(file);P.check(!stat.isSymbolicLink());
    if(stat.isDirectory())for(const entry of fs.readdirSync(file).sort()) {if(entry!=='__pycache__')collect(relative+'/'+entry);}
    else {P.check(stat.isFile());names.push(relative);}
  }
  for(const name of ['configs','scripts','src','run_inference.py','model_identity.json','runtime_hashes.json','weights/final.safetensors.manifest.json'])collect(name);
  const payload=bytes(path.join(source,'weights/final.safetensors'),M.MAX_WEIGHTS);
  const frozen=JSON.parse(bytes(path.join(source,'runtime_hashes.json'),M.LIMIT));
  for(const [name,expected] of Object.entries(frozen)) {
    P.check(name==='weights/final.safetensors' || names.includes(name),'Uncovered vendor runtime dependency');
    P.check(M.hash(name==='weights/final.safetensors'?payload:bytes(path.join(source,name),16*1024**2))===expected,'Vendor bundle changed');
  }
  const key=crypto.randomBytes(32),nonce=crypto.randomBytes(12),sha256=M.hash(payload);
  try {
    const cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);
    cipher.setAAD(Buffer.from('EXMO/MRI/v1/'+sha256));
    const encrypted=Buffer.concat([cipher.update(payload),cipher.final(),cipher.getAuthTag()]);
    const files=names.sort().map(name=>{const b=bytes(path.join(source,name),16*1024**2);return {path:name,size:b.length,sha256:M.hash(b)};});
    // Import still reads the sample catalog; a protected delivery contains no patient samples.
    files.push({path:'samples/manifest.json',size:2,sha256:M.hash(Buffer.from('[]'))});
    const token=M.sign({schema:'exmo-mri-package-v1',engine:'mri',version,loader:'mri-safetensors-full6-v1',
      size:payload.length,sha256,nonce:nonce.toString('base64url'),cipherSha256:M.hash(encrypted),files},authority.key);
    M.manifest(token,authority.publicKey);const digest=M.hash(Buffer.from(token));
    fs.mkdirSync(output,{recursive:false});
    for(const record of files) {
      const b=record.path==='samples/manifest.json'?Buffer.from('[]'):bytes(path.join(source,record.path),16*1024**2);P.check(M.hash(b)===record.sha256,'Source changed during packaging');
      const target=path.join(output,record.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,b,{flag:'wx'});
    }
    fs.writeFileSync(path.join(output,'weights/final.safetensors.enc'),encrypted,{flag:'wx'});
    const keys=path.join(directory,'model-keys');fs.mkdirSync(keys,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(keys,digest+'.key'),key,{flag:'wx',mode:0o600});
    // Publish last; incomplete output never looks like an approved protected bundle.
    fs.writeFileSync(path.join(output,'model-package.json'),JSON.stringify({token}),{flag:'wx'});
    return digest;
  } finally {key.fill(0);payload.fill(0);}
}
function grant(authority,directory,licenseId,request,packageDirectory,engine='mri') {
  M.validateEnrollment(request);P.id(licenseId);P.check(authority.profile===request.profile);
  P.check(M.ENGINES.includes(engine));
  const packageFile=path.join(packageDirectory,engine==='mri'?'model-package.json':require('./pack-models.cjs').packageFile(engine));
  const value=JSON.parse(bytes(packageFile,M.LIMIT));P.fields(value,['token']);const manifest=M.manifest(value.token,authority.publicKey);P.check(manifest.engine===engine);
  const modelDigest=M.hash(Buffer.from(value.token));
  return authority.transaction(()=>{
    const row=authority.db.prepare('SELECT * FROM licenses WHERE id=?').get(licenseId);P.check(row,'Unknown approval');
    const config=JSON.parse(row.config);
    const entitled=engine==='xray-classifier'?config.engines.some(v=>v==='ap'||v==='lat'):config.engines.includes(M.entitlement(engine));
    P.check(row.status==='active' && (config.contractEnd===null || config.contractEnd>authority.clock()) && entitled,'No active model entitlement');
    const hardware=request.profile==='customer'?M.hardwareKeys(request.hardware):null;
    P.sameBinding(config.binding,{profile:request.profile,licenseId,installationId:request.installationId,installationKey:request.installationKey,
      ...(hardware?{dongleKey:P.fingerprint(hardware['9e']),agreementKey:P.fingerprint(hardware['9d'])}:{})});
    const key=bytes(path.join(directory,'model-keys',modelDigest+'.key'),32);P.check(key.length===32);
    try {
      const recipient=M.rsa(request.modelKeyPublicKey);
      let envelope;
      if(hardware) {
        const E=require('../../desktop/security/model-envelope.cjs'),context=E.context(config.binding,modelDigest);
        const inner=require('./customer-admin.cjs').issuerCrypto({operation:'wrap',hardware:request.hardware,key:key.toString('base64url'),context});
        envelope={schema:'exmo-model-access-v2',jwe:E.wrap(inner,recipient,context)};
      } else envelope={schema:'exmo-model-access-v1',wrappedKey:crypto.publicEncrypt({key:recipient,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key).toString('base64url')};
      const access=M.sign({...envelope,binding:config.binding,modelDigest,recipient:P.fingerprint(recipient)},authority.key);
      authority.db.prepare("INSERT INTO models VALUES (?,'active') ON CONFLICT(digest) DO NOTHING").run(modelDigest);
      P.check(authority.db.prepare('SELECT status FROM models WHERE digest=?').get(modelDigest).status==='active','Model version is revoked');
      authority.db.prepare('INSERT INTO model_grants VALUES (?,?,?) ON CONFLICT(license,engine) DO UPDATE SET digest=excluded.digest').run(licenseId,engine,modelDigest);
      authority.db.prepare('UPDATE licenses SET revision=revision+1 WHERE id=?').run(licenseId);
      authority.db.prepare('INSERT INTO audit VALUES (?,?,?,?)').run(authority.clock(),licenseId,'model-granted:'+modelDigest,row.revision);
      return {binding:config.binding,installationPublicKey:config.installationPublicKey,models:{[engine]:access},...(hardware?{hardware:request.hardware}:{})};
    } finally {key.fill(0);}
  });
}
function main([command,directory,...args]) {
  P.check(['pack-mri','pack-ct','pack-xray','grant-mri','grant-model'].includes(command),'Usage: model-package.cjs pack-mri|pack-ct|pack-xray AUTHORITY SOURCE OUTPUT VERSION | grant-model AUTHORITY ENGINE LICENSE REQUEST PACKAGE OUTPUT_ACTIVATION');
  const authority=new Authority(directory);
  try {
    if(command==='pack-mri') {P.check(args.length===3);console.log('Encrypted MRI package: '+pack(authority,directory,...args));}
    else if(command.startsWith('pack-')){P.check(args.length===3);console.log(JSON.stringify(require('./pack-models.cjs').packModels(authority,directory,...args,command.slice(5))));}
    else {
      const engine=command==='grant-model'?args.shift():'mri';
      P.check(args.length===4);const [licenseId,request,packaged,output]=args;
      P.check(!fs.existsSync(output),'Activation output exists');
      fs.writeFileSync(output,JSON.stringify(grant(authority,directory,licenseId,JSON.parse(read(request)),packaged,engine),null,2),{flag:'wx'});
      console.log('Issued installation-bound MRI access. Fresh online activation is still required.');
    }
  } finally {authority.close();}
}
if(require.main===module){try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={pack,grant,main};
