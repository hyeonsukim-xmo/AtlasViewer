const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {protectedStore,read,atomicWrite}=require('./storage.cjs');
const P=require('./license-protocol.cjs');
const M=require('./model-package.cjs');
function recoveryKey(pem) {
  P.check(typeof pem==='string' && pem.length<4096 && !pem.includes('PRIVATE'));
  const key=crypto.createPublicKey(pem);P.check(key.asymmetricKeyType==='rsa' && key.asymmetricKeyDetails.modulusLength>=3072);return key;
}
function openResultStorage(directory,safeStorage) {
  fs.mkdirSync(directory,{recursive:true});
  const cache=protectedStore(path.join(directory,'results-key.bin'),safeStorage);
  const marker=path.join(directory,'results-key-id.json');
  let value;
  try {value=cache.read();}catch {P.check(fs.existsSync(marker),'결과 키 파일을 읽을 수 없습니다. 복구 식별 파일을 확인하세요.');value=null;}
  if(!value){
    if(!fs.existsSync(marker)) {
      value={id:crypto.randomUUID(),key:crypto.randomBytes(32).toString('base64url')};
      cache.write(value);atomicWrite(marker,JSON.stringify({id:value.id}));
    }
  }
  if(value){
    P.fields(value,['id','key',...(value.recoveryDigest?['recoveryDigest']:[])]);P.id(value.id);P.check(P.decode(value.key).length===32);
    if(fs.existsSync(marker))P.check(JSON.parse(read(marker)).id===value.id,'Result key identity mismatch');
    else atomicWrite(marker,JSON.stringify({id:value.id}));
  }
  return {
    bootstrap(root){return value?{root,key:value.key}:undefined;},
    ready(){return Boolean(value);},
    id(){const id=JSON.parse(read(marker)).id;P.id(id);return id;},
    hasRecovery(){try{return Boolean(value?.recoveryDigest) && M.hash(read(path.join(directory,'result-recovery.json')))===value.recoveryDigest;}catch{return false;}},
    async restore(token,issuer,identity,unwrap){
      P.check(!value,'이미 열리는 결과 키는 복구 파일로 덮어쓰지 않습니다.');
      const restore=M.verify(token,issuer,'exmo-result-restore-v1');
      P.fields(restore,['schema','id','installationId','recipient','wrappedKey']);P.id(restore.id);
      P.check(restore.id===JSON.parse(read(marker)).id && restore.installationId===identity.installationId && restore.recipient===P.fingerprint(M.rsa(identity.modelKeyPublicKey)),'Result recovery belongs to another store or PC');
      const key=await unwrap(P.decode(restore.wrappedKey));
      try {P.check(key.length===32);const restored={id:restore.id,key:key.toString('base64url')};cache.write(restored);value=restored;}finally{key.fill(0);}
    },
    recovery(token,issuer,binding){
      P.check(value,'Result recovery must be completed first');
      const policy=M.verify(token,issuer,'exmo-result-recovery-v1');
      P.fields(policy,['schema','binding','recoveryPublicKey']);P.sameBinding(policy.binding,binding);
      const publicKey=recoveryKey(policy.recoveryPublicKey),key=P.decode(value.key);
      try {
        const wrapped=crypto.publicEncrypt({key:publicKey,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},key);
        const document=JSON.stringify({schema:'exmo-result-recovery-v1',id:value.id,
          recipient:P.fingerprint(publicKey),wrappedKey:wrapped.toString('base64url'),policy:token});
        atomicWrite(path.join(directory,'result-recovery.json'),document);
        const next={...value,recoveryDigest:M.hash(Buffer.from(document))};cache.write(next);value=next;
      } finally {key.fill(0);}
    },
  };
}
module.exports={openResultStorage,recoveryKey};
