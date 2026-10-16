const crypto=require('node:crypto');
const P=require('./license-protocol.cjs');
const LIMIT=512*1024, MAX_WEIGHTS=1024**3;
const HEADER=Buffer.from('{"alg":"EdDSA","typ":"EXMO-MODEL"}').toString('base64url');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const ENGINES=['mri','ct','ap','lat_lt','lat_rt','xray-classifier'];
const entitlement=engine=>engine.startsWith('lat_')?'lat':engine;
function modelId(job) {
  const id=job.analysis==='xray'?(job.route==='AP'?'ap':job.route==='LAT_LT'?'lat_lt':job.route==='LAT_RT'?'lat_rt':null):job.analysis;
  P.check(ENGINES.includes(id),'Unsupported protected model');return id;
}
function sign(value,key) {
  const body=HEADER+'.'+Buffer.from(JSON.stringify(value)).toString('base64url');
  P.check(body.length<LIMIT && key.asymmetricKeyType==='ed25519');
  return body+'.'+crypto.sign(null,Buffer.from(body),key).toString('base64url');
}
function verify(token,key,schema) {
  P.check(typeof token==='string' && token.length<=LIMIT && key.asymmetricKeyType==='ed25519');
  const parts=token.split('.');P.check(parts.length===3 && parts[0]===HEADER);
  const decode=text=>{P.check(/^[A-Za-z0-9_-]+$/.test(text));const b=Buffer.from(text,'base64url');P.check(b.toString('base64url')===text);return b;};
  const signature=decode(parts[2]);P.check(signature.length===64 && crypto.verify(null,Buffer.from(parts[0]+'.'+parts[1]),key,signature),'Model signature rejected');
  const text=decode(parts[1]).toString(),value=JSON.parse(text);
  P.check(JSON.stringify(value)===text && (Array.isArray(schema)?schema.includes(value.schema):value.schema===schema),'Model schema rejected');return value;
}
function rsa(pem) {
  P.check(typeof pem==='string' && pem.length<2048 && !pem.includes('PRIVATE'));
  const key=crypto.createPublicKey(pem);
  P.check(key.asymmetricKeyType==='rsa' && key.asymmetricKeyDetails.modulusLength===3072 && key.asymmetricKeyDetails.publicExponent===65537n);
  return key;
}
function enrollmentMessage(request) {
  return Buffer.from('EXMO/MODEL-KEY/v1/'+JSON.stringify({installationId:request.installationId,
    installationKey:request.installationKey,modelKeyPublicKey:request.modelKeyPublicKey,...(request.profile==='customer'?{hardware:request.hardware}:{})}));
}
function hardwareKeys(hardware) {
  P.fields(hardware,['serial','firmware','factoryCertificate','attestations']);
  P.integer(hardware.serial);P.check(hardware.serial>0 && hardware.serial<2**32);
  P.fields(hardware.attestations,['9e','9d']);
  const keys={};
  for(const [name,certificate] of Object.entries(hardware.attestations)) {
    P.check(typeof certificate==='string' && certificate.length<8192);
    const key=new crypto.X509Certificate(certificate).publicKey;
    keys[name]=P.p256(key.export({type:'spki',format:'pem'}));
  }
  P.check(P.fingerprint(keys['9e'])!==P.fingerprint(keys['9d']));return keys;
}
function validateEnrollment(request) {
  P.fields(request,['profile','installationId','installationKey','installationPublicKey','modelKeyPublicKey','modelKeySignature',...(request.profile==='customer'?['hardware']:[])]);
  P.check(['internal','customer'].includes(request.profile));P.id(request.installationId);P.digest(request.installationKey);
  if(request.profile==='customer')hardwareKeys(request.hardware);
  const publicKey=P.p256(request.installationPublicKey);rsa(request.modelKeyPublicKey);
  P.check(P.fingerprint(publicKey)===request.installationKey);
  const signature=P.decode(request.modelKeySignature);
  P.check(crypto.verify('sha256',enrollmentMessage(request),publicKey,signature),'Model decryption key enrollment rejected');
}
function manifest(token,key) {
  const v=verify(token,key,['exmo-mri-package-v1','exmo-model-package-v2']);
  if(v.schema==='exmo-model-package-v2')return multiManifest(token,key);
  P.fields(v,['schema','engine','version','loader','size','sha256','nonce','cipherSha256','files']);
  P.check(v.engine==='mri' && v.loader==='mri-safetensors-full6-v1');P.id(v.version);
  P.integer(v.size);P.check(v.size>0 && v.size<=MAX_WEIGHTS);P.digest(v.sha256);P.digest(v.cipherSha256);
  P.check(P.decode(v.nonce).length===12 && Array.isArray(v.files) && v.files.length>0 && v.files.length<=2000);
  const names=new Set();
  for(const f of v.files) {
    P.fields(f,['path','size','sha256']);
    P.check(typeof f.path==='string' && /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(f.path) && !f.path.split('/').some(p=>p==='.'||p==='..') && !names.has(f.path.toLowerCase()));
    P.integer(f.size);P.check(f.size<=16*1024**2);P.digest(f.sha256);names.add(f.path.toLowerCase());
  }
  for(const name of ['run_inference.py','model_identity.json','runtime_hashes.json','weights/final.safetensors.manifest.json'])P.check(names.has(name));
  return v;
}
function fileRecord(f,limit) {
  P.check(typeof f.path==='string' && /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(f.path) && !f.path.split('/').some(p=>p==='.'||p==='..'));
  P.integer(f.size);P.check(f.size<=limit);P.digest(f.sha256);
}
function multiManifest(token,key) {
  const v=verify(token,key,'exmo-model-package-v2');
  P.fields(v,['schema','engine','version','loader','assets','files']);P.id(v.version);
  P.check(ENGINES.includes(v.engine) && v.engine!=='mri' && v.loader===v.engine+'-memory-v1');
  P.check(Array.isArray(v.assets) && v.assets.length>0 && v.assets.length<=10 && Array.isArray(v.files) && v.files.length>0 && v.files.length<=2000);
  const names=new Set();let total=0;
  for(const f of [...v.files,...v.assets]) {
    const asset=v.assets.includes(f);
    P.fields(f,asset?['path','size','sha256','nonce','cipherSha256']:['path','size','sha256']);
    fileRecord(f,asset?MAX_WEIGHTS:16*1024**2);
    P.check(!names.has(f.path.toLowerCase()));names.add(f.path.toLowerCase());
    if(asset){P.check(f.size>0 && P.decode(f.nonce).length===12);P.digest(f.cipherSha256);}
    else {total+=f.size;P.check(total<=64*1024**2);}
  }
  return v;
}
function envelope(token,key,binding,modelKeyPublicKey) {
  const customer=binding.profile==='customer';
  const v=verify(token,key,customer?'exmo-model-access-v2':'exmo-model-access-v1');
  P.fields(v,['schema','binding','modelDigest','recipient',customer?'jwe':'wrappedKey']);P.sameBinding(v.binding,binding);P.digest(v.modelDigest);
  P.check(v.recipient===P.fingerprint(rsa(modelKeyPublicKey)),'Model key belongs to another installation');
  if(customer)P.check(typeof v.jwe==='string' && v.jwe.length<8192 && v.jwe.split('.').length===5);
  else P.check(P.decode(v.wrappedKey).length===384);
  return v;
}
module.exports={LIMIT,MAX_WEIGHTS,ENGINES,entitlement,modelId,hash,sign,verify,rsa,hardwareKeys,enrollmentMessage,validateEnrollment,manifest,envelope};
