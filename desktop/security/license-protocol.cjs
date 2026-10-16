// Separate build-pinned authorities and signed profiles prevent internal grants authorizing customers.
const crypto = require('node:crypto');
const ISSUER = 'exmo-license-v2';
const AUDIENCE = 'exmo-desktop-v2';
const LIMIT = 16384;
const HEADER = Buffer.from(JSON.stringify({alg:'EdDSA',typ:'EXMO-LICENSE'})).toString('base64url');
const ENGINES = ['ct','mri','ap','lat'];
function check(ok, message = 'Invalid licensing message') { if (!ok) throw Error(message); }
function fields(value, names) {
  check(value && typeof value === 'object' && !Array.isArray(value));
  check(Object.keys(value).sort().join(',') === [...names].sort().join(','));
}
function integer(value) { check(Number.isSafeInteger(value) && value >= 0); }
function id(value) { check(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)); }
function nonce(value) { check(typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)); decode(value); }
function digest(value) { check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)); }
function decode(value) {
  check(typeof value === 'string' && value.length <= LIMIT && /^[A-Za-z0-9_-]+$/.test(value));
  const bytes = Buffer.from(value,'base64url');
  check(bytes.toString('base64url') === value);
  return bytes;
}
function json(text) {
  check(typeof text === 'string' && Buffer.byteLength(text) <= LIMIT);
  const value = JSON.parse(text);
  // A single serialization rejects duplicate keys and parser-dependent signed representations.
  check(JSON.stringify(value) === text);
  return value;
}
function fingerprint(key) {
  return crypto.createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex');
}
function p256(pem) {
  check(typeof pem === 'string' && pem.length < 2048 && !pem.includes('PRIVATE'));
  const key = crypto.createPublicKey(pem);
  check(key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails.namedCurve === 'prime256v1');
  return key;
}
function binding(value) {
  check(['internal','customer'].includes(value?.profile),'Unknown license profile');
  fields(value,['profile','licenseId','installationId','installationKey',...(value.profile==='customer'?['dongleKey','agreementKey']:[])]);
  id(value.licenseId); id(value.installationId);
  const names=value.profile==='customer'?['installationKey','dongleKey','agreementKey']:['installationKey'];
  for (const name of names) digest(value[name]);
  check(new Set(names.map(name=>value[name])).size === names.length);
}
function sameBinding(actual, expected) {
  binding(actual); binding(expected);
  check(Object.keys(expected).every(name => actual[name] === expected[name]), 'License belongs to another installation or dongle');
}
function signToken(value, key) {
  const input = `${HEADER}.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  check(input.length < LIMIT && key.asymmetricKeyType === 'ed25519');
  return `${input}.${crypto.sign(null,Buffer.from(input),key).toString('base64url')}`;
}
function verifyToken(token, key, kind, expected) {
  check(typeof token === 'string' && token.length <= LIMIT);
  const parts = token.split('.');
  check(parts.length === 3 && parts[0] === HEADER && key.asymmetricKeyType === 'ed25519');
  const sig = decode(parts[2]); check(sig.length === 64);
  check(crypto.verify(null,Buffer.from(`${parts[0]}.${parts[1]}`),key,sig),'Invalid server signature');
  const value = json(decode(parts[1]).toString('utf8'));
  check(value.iss === ISSUER && value.aud === AUDIENCE && value.kind === kind);
  sameBinding(value.binding,expected); nonce(value.nonce); integer(value.iat);
  if (kind === 'challenge') {
    fields(value,['iss','aud','kind','binding','nonce','iat','exp','challengeId']);
    nonce(value.challengeId); integer(value.exp); check(value.exp === value.iat + 60);
  } else {
    fields(value,['iss','aud','kind','binding','nonce','iat','exp','renewAfter','revision','sequence','decision','engines','modelDigests']);
    check(Array.isArray(value.modelDigests) && value.modelDigests.length<=6 && new Set(value.modelDigests).size===value.modelDigests.length);
    value.modelDigests.forEach(digest);
    for (const name of ['exp','renewAfter','revision','sequence']) integer(value[name]);
    check(value.revision > 0 && value.sequence > 0);
    check(['allow','revoked','suspended','expired'].includes(value.decision));
    check(Array.isArray(value.engines) && value.engines.length <= ENGINES.length &&
      value.engines.every(x=>ENGINES.includes(x)) && new Set(value.engines).size === value.engines.length);
    if (value.decision === 'allow') check(value.exp > value.iat && value.exp <= value.iat+7*86400 &&
      value.renewAfter > value.iat && value.renewAfter <= value.exp && value.engines.length > 0);
    else check(value.exp === value.iat && value.renewAfter === value.iat && value.engines.length === 0 && value.modelDigests.length===0);
  }
  return value;
}
function proofMessage(role, message) {
  check(['installation','dongle'].includes(role));
  return Buffer.from(`EXMO/LICENSE/v2/${role}/${message}`,'utf8');
}
function verifyProof(key, role, message, signature) {
  const bytes = decode(signature); check(bytes.length >= 64 && bytes.length <= 80);
  check(crypto.verify('sha256',proofMessage(role,message),key,bytes),'Device proof rejected');
}
module.exports = {ISSUER,AUDIENCE,LIMIT,ENGINES,check,fields,integer,id,nonce,digest,decode,json,
  fingerprint,p256,binding,sameBinding,signToken,verifyToken,proofMessage,verifyProof};
