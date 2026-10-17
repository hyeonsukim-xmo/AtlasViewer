// v2 stays strict and separate; v3 authorizes exact solution executions, including keyless mutations.
const crypto=require('node:crypto');
const P=require('./license-protocol.cjs');
const LIMIT=128*1024, ISSUER='exmo-license-v3', AUDIENCE='exmo-desktop-v3';
const HEADER=Buffer.from('{"alg":"EdDSA","typ":"EXMO-LICENSE"}').toString('base64url');
const CAPABILITIES=['analyze','classify','result-mutation'];
function name(value){P.check(typeof value==='string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value));}
function json(text){P.check(typeof text==='string' && Buffer.byteLength(text)<=LIMIT);const v=JSON.parse(text);P.check(JSON.stringify(v)===text);return v;}
function execution(v){
  P.fields(v,['solutionId','workflowId','capability','engine','modelDigest','recipeDigest','packageSetDigest']);
  name(v.solutionId);name(v.workflowId);P.check(CAPABILITIES.includes(v.capability));
  P.check(['ct','mri','ap','lat_lt','lat_rt','xray-classifier'].includes(v.engine));
  if(v.capability==='result-mutation')P.check(v.modelDigest===null && ['ct','mri'].includes(v.engine));else P.digest(v.modelDigest);
  P.digest(v.recipeDigest);P.digest(v.packageSetDigest);
}
function entitlements(values){
  P.check(Array.isArray(values) && values.length<=64);let count=0;const ids=new Set(),solutions=new Set();
  for(const v of values){
    P.fields(v,['entitlementId','solutionId','validFrom','validUntil','state','revision','capabilities','executions']);
    P.id(v.entitlementId);name(v.solutionId);P.integer(v.validFrom);P.integer(v.revision);P.check(v.revision>0);
    if(v.validUntil!==null){P.integer(v.validUntil);P.check(v.validUntil>v.validFrom);}
    P.check(['active','revoked','suspended'].includes(v.state) && !ids.has(v.entitlementId) && !solutions.has(v.solutionId));
    ids.add(v.entitlementId);solutions.add(v.solutionId);
    P.check(Array.isArray(v.capabilities) && v.capabilities.length>0 && v.capabilities.every(c=>CAPABILITIES.includes(c)) && new Set(v.capabilities).size===v.capabilities.length);
    P.check(Array.isArray(v.executions));const seen=new Set();
    for(const e of v.executions){execution(e);P.check(e.solutionId===v.solutionId && v.capabilities.includes(e.capability));
      const key=JSON.stringify(Object.keys(e).sort().map(k=>e[k]));P.check(!seen.has(key));seen.add(key);}
    count+=v.executions.length;P.check(count<=256);
  }
}
function validate(v,kind,binding){
  P.check(v.iss===ISSUER && v.aud===AUDIENCE && v.kind===kind && v.schema==='exmo-device-'+kind+'-v3');
  P.sameBinding(v.binding,binding);P.nonce(v.nonce);P.integer(v.iat);P.integer(v.exp);
  if(kind==='challenge'){
    P.fields(v,['iss','aud','kind','schema','binding','nonce','iat','exp','challengeId']);P.nonce(v.challengeId);P.check(v.exp===v.iat+60);
  }else{
    P.fields(v,['iss','aud','kind','schema','orgId','binding','nonce','iat','exp','renewAfter','revision','sequence','decision','entitlements']);
    P.id(v.orgId);for(const k of ['renewAfter','revision','sequence'])P.integer(v[k]);
    P.check(v.revision>0 && v.sequence>0 && ['allow','revoked','suspended','expired'].includes(v.decision));entitlements(v.entitlements);
    if(v.decision==='allow')P.check(v.iat<v.renewAfter && v.renewAfter<=v.exp && v.exp<=v.iat+7*86400);
    else P.check(v.exp===v.iat && v.renewAfter===v.iat && v.entitlements.length===0);
  }return v;
}
function signToken(v,key){const input=HEADER+'.'+Buffer.from(JSON.stringify(v)).toString('base64url');P.check(input.length+87<=LIMIT && key.asymmetricKeyType==='ed25519');return input+'.'+crypto.sign(null,Buffer.from(input),key).toString('base64url');}
function verifyToken(token,key,kind,binding){
  P.check(typeof token==='string' && token.length<=LIMIT && key.asymmetricKeyType==='ed25519');const parts=token.split('.');
  P.check(parts.length===3 && parts[0]===HEADER && /^[A-Za-z0-9_-]+$/.test(parts[1]));
  const sig=P.decode(parts[2]);P.check(sig.length===64 && crypto.verify(null,Buffer.from(parts[0]+'.'+parts[1]),key,sig),'Invalid server signature');
  const bytes=Buffer.from(parts[1],'base64url');P.check(bytes.toString('base64url')===parts[1]);return validate(json(bytes.toString('utf8')),kind,binding);
}
function allowed(lease,request,now){
  execution(request);P.check(lease.decision==='allow' && now>=lease.iat && now<lease.exp,'Device lease expired');
  const e=lease.entitlements.find(e=>e.solutionId===request.solutionId);
  P.check(e && e.state==='active' && now>=e.validFrom && (e.validUntil===null || now<e.validUntil) && e.capabilities.includes(request.capability) &&
    e.executions.some(x=>Object.keys(request).every(k=>x[k]===request[k])),'Solution execution is not authorized');
  return Math.min(lease.exp,e.validUntil??Infinity);
}
function transition(prior,next){
  P.check(prior.orgId===next.orgId,'License organization changed');
  for(const old of prior.entitlements){const current=next.entitlements.find(e=>e.entitlementId===old.entitlementId);
    if(current){P.check(current.solutionId===old.solutionId && current.revision>=old.revision,'Stale entitlement');
      if(JSON.stringify(current)!==JSON.stringify(old))P.check(next.revision>prior.revision && current.revision>old.revision,'Entitlement change requires an administrative revision');}
  }
  if(JSON.stringify(prior.entitlements)!==JSON.stringify(next.entitlements))P.check(next.revision>prior.revision,'Stale entitlement set');
}
module.exports={LIMIT,ISSUER,AUDIENCE,name,json,execution,entitlements,validate,signToken,verifyToken,allowed,transition};
