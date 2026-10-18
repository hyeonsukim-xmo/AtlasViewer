const P=require('./license-protocol.cjs');
const crypto=require('node:crypto');
const ROLES=['analyst','reviewer','device-admin','data-admin'];
function url(value,loopback=false){
  P.check(typeof value==='string' && value.length<=2048,'Invalid account URL');
  const u=new URL(value);
  P.check(!u.username && !u.password && !u.hash && !u.search && (u.protocol==='https:' || (loopback && u.protocol==='http:' && u.hostname==='127.0.0.1')),'HTTPS account endpoint required');
  return u;
}
function configuration(value,loopback=false){
  P.fields(value,['issuer','clientId','apiUrl','resource']);
  url(value.issuer,loopback);url(value.apiUrl,loopback);url(value.resource,loopback);
  P.check(typeof value.clientId==='string' && /^[\x21-\x7e]{1,200}$/.test(value.clientId),'Invalid OIDC client');
  return Object.freeze({...value});
}
function text(value,max=200){P.check(typeof value==='string' && value.length>0 && value.length<=max && !/[\u0000-\u001f]/.test(value),'Invalid account text');return value;}
function challenge(value){P.fields(value,['id','nonce','orgId','workspaceId','expiresAt']);P.id(value.id);P.nonce(value.nonce);P.id(value.orgId);P.id(value.workspaceId);P.integer(value.expiresAt);return value;}
function enrollmentMessage(value,request){
  challenge(value);
  return Buffer.from('EXMO/ACCOUNT-ENROLLMENT/v1/'+JSON.stringify(value)+'/'+crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex'));
}
function me(value){
  P.fields(value,['subject','name','operator','memberships']);text(value.subject,512);text(value.name);P.check(typeof value.operator==='boolean');
  P.check(Array.isArray(value.memberships) && value.memberships.length<=200);
  for(const m of value.memberships){P.fields(m,['orgId','workspaceId','name','roles']);P.id(m.orgId);P.id(m.workspaceId);text(m.name);P.check(Array.isArray(m.roles) && m.roles.every(r=>ROLES.includes(r)) && new Set(m.roles).size===m.roles.length);}
  return value;
}
module.exports={ROLES,url,configuration,text,challenge,enrollmentMessage,me};
