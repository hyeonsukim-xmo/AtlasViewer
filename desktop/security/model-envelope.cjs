const crypto=require('node:crypto');
const P=require('./license-protocol.cjs');
const M=require('./model-package.cjs');
const context=(binding,modelDigest)=>M.hash(Buffer.from(JSON.stringify({binding,modelDigest})));
function wrap(inner,recipient,kid) {
  const header=Buffer.from(JSON.stringify({alg:'RSA-OAEP-256',enc:'A256GCM',typ:'EXMO-INNER-JWE',kid})).toString('base64url');
  const key=crypto.randomBytes(32),nonce=crypto.randomBytes(12);
  try {
    const cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(header));
    const data=Buffer.concat([cipher.update(inner,'utf8'),cipher.final()]);
    const wrapped=crypto.publicEncrypt({key:recipient,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},key);
    return [header,wrapped.toString('base64url'),nonce.toString('base64url'),data.toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');
  }finally{key.fill(0);}
}
async function unwrap(token,unwrapKey,kid) {
  P.check(typeof token==='string' && token.length<8192);
  const parts=token.split('.');P.check(parts.length===5);
  const header=P.json(P.decode(parts[0]).toString());P.fields(header,['alg','enc','typ','kid']);
  P.check(header.alg==='RSA-OAEP-256' && header.enc==='A256GCM' && header.typ==='EXMO-INNER-JWE' && header.kid===kid);
  const wrapped=P.decode(parts[1]),nonce=P.decode(parts[2]),tag=P.decode(parts[4]);P.check(wrapped.length===384 && nonce.length===12 && tag.length===16);
  const key=await unwrapKey(wrapped);
  try {P.check(key.length===32);const cipher=crypto.createDecipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(parts[0]));cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(P.decode(parts[3])),cipher.final()]).toString('utf8');
  }finally{key.fill(0);}
}
module.exports={context,wrap,unwrap};
