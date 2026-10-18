const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const S=require('./publication-protocol.cjs');
const {atomicWrite}=require('./security/storage.cjs');
function publicKey(pem){S.check(typeof pem==='string' && pem.length<4096 && !pem.includes('PRIVATE'));const key=crypto.createPublicKey(pem);S.check(key.asymmetricKeyType==='rsa' && key.asymmetricKeyDetails.modulusLength===3072);return key;}
async function encryptMesh(file,directory,target,id,attempt,pem){
  return encryptArtifact(fs.createReadStream(file,{highWaterMark:S.CHUNK}),'mesh',directory,target,id,attempt,pem);
}
async function encryptArtifact(blocks,kind,directory,target,id,attempt,pem){
  const key=crypto.randomBytes(32),parts=[],digest=crypto.createHash('sha256');let bytes=0;
  try{
    S.check(['mesh','overlay'].includes(kind));
    for await(const block of blocks){
      bytes+=block.length;S.check(block.length<=S.CHUNK && bytes<=(kind==='mesh'?128:16)*1024*1024);digest.update(block);
      const nonce=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,nonce);c.setAAD(S.aad(target,id,attempt,kind,parts.length));
      const encrypted=Buffer.concat([nonce,c.update(block),c.final(),c.getAuthTag()]);
      atomicWrite(path.join(directory,parts.length+'.part'),encrypted);parts.push({sha256:S.hash(encrypted),bytes:encrypted.length});
    }
    return S.artifact({kind,sha256:digest.digest('hex'),bytes,wrappedKey:crypto.publicEncrypt({key:publicKey(pem),oaepHash:'sha256'},key).toString('base64url'),parts});
  }finally{key.fill(0);}
}
async function* decryptParts(directory,manifest,privateKey){
  S.manifest(manifest);const a=manifest.artifact;
  const key=crypto.privateDecrypt({key:privateKey,oaepHash:'sha256'},Buffer.from(a.wrappedKey,'base64url'));
  const hash=crypto.createHash('sha256');let bytes=0;
  try{
    S.check(key.length===32);
    for(let i=0;i<a.parts.length;i++){
      const part=a.parts[i],file=path.join(directory,i+'.part');S.check(fs.statSync(file).size===part.bytes);
      const data=await fs.promises.readFile(file);S.check(S.hash(data)===part.sha256);
      const c=crypto.createDecipheriv('aes-256-gcm',key,data.subarray(0,12));c.setAAD(S.aad(manifest.scope,manifest.content.identity,manifest.attemptId,a.kind,i));c.setAuthTag(data.subarray(-16));
      const block=Buffer.concat([c.update(data.subarray(12,-16)),c.final()]);hash.update(block);bytes+=block.length;
      try{yield block;}finally{block.fill(0);}
    }
    S.check(bytes===a.bytes && hash.digest('hex')===a.sha256);
  }finally{key.fill(0);}
}
module.exports={publicKey,encryptMesh,encryptArtifact,decryptParts};
