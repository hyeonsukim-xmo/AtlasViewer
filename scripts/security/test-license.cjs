const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const http=require('node:http');
const P=require('../../desktop/security/license-protocol.cjs');
const {Authority,createServer}=require('./license-server.cjs');
const {LicenseClient,localTransport}=require('../../desktop/security/license-client.cjs');
const {createFixture,fileStore}=require('./license-demo.cjs');

function fixture(t,profile='customer') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'exmo-license-'));
  const directory=path.join(root,'fixture');
  const f=createFixture(directory,profile);
  let now=Math.floor(Date.now()/1000),wall=now,mono=0,saved=null,online=true,removed=false;
  const clock={wall:()=>wall,mono:()=>mono};
  const authority=new Authority(f.server,()=>now);
  const privateKeys=JSON.parse(fs.readFileSync(path.join(directory,'SIMULATED-device-private.json')));
  const proofs=[];
  const sign=async(role,message)=>{
    if(removed && role==='dongle')throw Error('No dongle');
    proofs.push({role,message:message.toString()});
    return crypto.sign('sha256',message,privateKeys[role]);
  };
  const store={read:()=>structuredClone(saved),write:value=>{saved=structuredClone(value);}};
  const post=async(route,body)=>{if(!online)throw Error('offline');return route==='/v1/challenge'?authority.challenge(body):authority.lease(body);};
  const make=(overrides={})=>new LicenseClient({profile,config:f.config,store,sign,post,clock,...overrides});
  const client=make();
  const admit=(engine='ct',target=client,signal)=>target.authorize({runId:crypto.randomUUID(),engine,signal});
  t.after(()=>{
    client.close();authority.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
    fs.rmSync(root,{recursive:true,force:true});
  });
  return {...f,directory,authority,client,store,sign,post,clock,proofs,privateKeys,make,admit,
    now:()=>now,saved:()=>saved,setSaved:value=>{saved=value;},offline:()=>{online=false;},online:()=>{online=true;},remove:()=>{removed=true;},insert:()=>{removed=false;},
    advance:seconds=>{now+=seconds;wall+=seconds;mono+=seconds;},setWall:value=>{wall=value;},setMono:value=>{mono=value;}};
}
function request(f) {return {binding:f.config.binding,nonce:crypto.randomBytes(32).toString('base64url')};}
async function proof(f,token) {
  return {installationSignature:(await f.sign('installation',P.proofMessage('installation',token))).toString('base64url'),
    dongleSignature:(await f.sign('dongle',P.proofMessage('dongle',token))).toString('base64url')};
}

test('online activation, permitted engines, and fresh device proofs for every cached-model run',async t=>{
  const f=fixture(t);assert.equal(f.client.state(),'UNACTIVATED');
  assert.equal(await f.client.refresh(),'VALID');
  assert.equal(f.client.receipt.exp,f.now()+7*86400);
  for(const engine of P.ENGINES)assert.equal((await f.admit(engine)).engine,engine);
  const local=f.proofs.filter(p=>p.role==='dongle'&&p.message.includes('"runId"'));
  assert.equal(local.length,4);assert.equal(new Set(local.map(p=>p.message)).size,4);
  assert.equal(f.authority.db.prepare('SELECT sequence FROM licenses').get().sequence,1);
  f.remove();await assert.rejects(f.admit(),/동글/);
  f.insert();await f.admit();
});

test('unactivated offline client and unapproved/rebound devices cannot acquire a lease',async t=>{
  const f=fixture(t);f.offline();
  await assert.rejects(f.admit(),/UNACTIVATED/);assert.equal(f.saved(),null);
  assert.throws(()=>f.authority.challenge({...request(f),binding:{...f.config.binding,installationId:'another'}}));
  assert.throws(()=>f.authority.approve({...f.approval,binding:{...f.approval.binding,licenseId:'duplicate'}}));
  assert.throws(()=>f.authority.challenge({...request(f),patientId:'must-not-be-sent'}));
  const bad=f.make({sign:async()=>Buffer.alloc(70)});assert.equal(await bad.refresh(),'UNACTIVATED');bad.close();
});

test('offline grace never slides on failure, retry or restart and stops at the original expiry',async t=>{
  const f=fixture(t);await f.client.refresh();const expiry=f.client.receipt.exp;
  f.advance(301);f.offline();assert.equal(await f.client.refresh(),'GRACE');
  await f.admit();const saved=f.saved();
  const restarted=f.make();assert.equal(restarted.state(),'GRACE');
  f.advance(100);await f.admit('mri',restarted);
  assert.equal(restarted.receipt.exp,expiry);assert.equal(restarted.receipt.iat,saved.serverNow-301);
  f.advance(expiry-f.now());await assert.rejects(f.admit('ct',restarted),/EXPIRED/);
  assert.equal(restarted.receipt.exp,expiry);restarted.close();
});

test('challenge is single-use, invalid proof consumes it, and expiry is enforced',async t=>{
  const f=fixture(t);
  const challenge=f.authority.challenge(request(f)).token;
  const data=P.verifyToken(challenge,f.authority.publicKey,'challenge',f.config.binding);
  const body={challengeId:data.challengeId,...await proof(f,challenge)};
  f.authority.lease(body);assert.throws(()=>f.authority.lease(body),/already used/);
  const next=f.authority.challenge(request(f)).token;
  const nextData=P.verifyToken(next,f.authority.publicKey,'challenge',f.config.binding);
  const valid={challengeId:nextData.challengeId,...await proof(f,next)};
  assert.throws(()=>f.authority.lease({...valid,dongleSignature:body.dongleSignature}),/proof rejected/);
  assert.throws(()=>f.authority.lease(valid),/already used/);
  const expired=f.authority.challenge(request(f)).token;
  const claims=P.verifyToken(expired,f.authority.publicKey,'challenge',f.config.binding);
  const expiredProof=await proof(f,expired);
  f.advance(60);assert.throws(()=>f.authority.lease({challengeId:claims.challengeId,...expiredProof}),/expired/);
});

test('revocation between challenge and issue wins; persistent denial requires a newer admin approval',async t=>{
  const f=fixture(t);await f.client.refresh();
  const slow=f.authority.challenge(request(f)).token;
  const data=P.verifyToken(slow,f.authority.publicKey,'challenge',f.config.binding);
  f.authority.status('development-only','revoked');
  const denied=f.authority.lease({challengeId:data.challengeId,...await proof(f,slow)});
  assert.equal(P.verifyToken(denied.token,f.authority.publicKey,'lease',f.config.binding).decision,'revoked');
  assert.equal(await f.client.refresh(),'REVOKED');f.offline();
  const restarted=f.make();await assert.rejects(f.admit('ct',restarted),/REVOKED/);
  f.online();f.authority.status('development-only','active');
  assert.equal(await restarted.refresh(),'VALID');await f.admit('ct',restarted);restarted.close();
});

test('a stale or same-revision signed allow cannot clear a received denial',async t=>{
  const f=fixture(t);await f.client.refresh();const original=f.client.receipt;
  f.authority.status('development-only','revoked');await f.client.refresh();
  for(const revision of [original.revision,f.client.receipt.revision]) {
    let nonce;
    const client=f.make({post:async(route,body)=>{
      if(route==='/v1/challenge'){nonce=body.nonce;return f.authority.challenge(body);}
      return {token:P.signToken({...original,nonce,revision,sequence:f.client.receipt.sequence+10},f.authority.key)};
    }});
    assert.equal(await client.refresh(),'REVOKED');client.close();
  }
});

test('contract expiry caps grace, and feature permissions are checked locally',async t=>{
  const f=fixture(t);
  const config={...f.approval,contractEnd:f.now()+20,engines:['mri']};
  f.authority.db.prepare('UPDATE licenses SET config=?').run(JSON.stringify(config));
  await f.client.refresh();assert.equal(f.client.receipt.exp,f.now()+20);
  await assert.rejects(f.admit('ct'),/권한/);await f.admit('mri');
  f.advance(20);assert.equal(await f.client.refresh(),'EXPIRED');
  await assert.rejects(f.admit('mri'),/EXPIRED/);
});

test('suspension persists and transport errors do not grant, revoke or extend rights',async t=>{
  const f=fixture(t);await f.client.refresh();const expiry=f.client.receipt.exp;
  f.advance(301);
  for(const message of ['HTTP 401','HTTP 403','HTTP 429','HTTP 500','DNS','TLS']) {
    const client=f.make({post:async()=>{throw Error(message);}});
    assert.equal(await client.refresh(),'GRACE');assert.equal(client.receipt.exp,expiry);client.close();
  }
  f.authority.status('development-only','suspended');assert.equal(await f.client.refresh(),'SUSPENDED');
  f.offline();assert.equal(await f.client.refresh(),'SUSPENDED');await assert.rejects(f.admit(),/SUSPENDED/);
});

test('clock rollback, monotonic reset, sleep and corrupt cached state fail closed until online recovery',async t=>{
  const f=fixture(t);await f.client.refresh();f.offline();
  f.setWall(f.now()-30);assert.equal(f.client.state(),'TIME_UNTRUSTED');await assert.rejects(f.admit(),/TIME_UNTRUSTED/);
  f.online();assert.equal(await f.client.refresh(),'VALID');
  f.setMono(-1);assert.equal(f.client.state(),'TIME_UNTRUSTED');
  f.setMono(0);assert.equal(await f.client.refresh(),'VALID');
  f.offline();f.setWall(f.clock.wall()+7*86400);assert.equal(f.client.state(),'EXPIRED');
  const corrupt=f.make({store:{read:()=>({token:'bad'}),write(){}}});
  assert.equal(corrupt.state(),'TIME_UNTRUSTED');await assert.rejects(f.admit('ct',corrupt));corrupt.close();
});

test('failed persistence blocks a new run; cancellation and expiry during dongle signing cannot admit it',async t=>{
  const f=fixture(t);
  const broken=f.make({store:{read:()=>null,write:()=>{throw Error('disk full');}}});
  assert.equal(await broken.refresh(),'STORAGE_ERROR');await assert.rejects(f.admit('ct',broken),/STORAGE_ERROR/);broken.close();
  await f.client.refresh();
  const controller=new AbortController();
  const cancelled=f.make({sign:async(role,message)=>{controller.abort();return f.sign(role,message);}});
  await assert.rejects(f.admit('ct',cancelled,controller.signal),/cancelled/);cancelled.close();
  const delayed=f.make({sign:async(role,message)=>{
    if(message.toString().includes('"runId"'))f.advance(7*86400);
    return f.sign(role,message);
  }});
  await assert.rejects(f.admit('ct',delayed),/EXPIRED/);delayed.close();
});

test('tokens bind issuer, audience, type, algorithm, nonce, installation and bounded claims',async t=>{
  const f=fixture(t);await f.client.refresh();const good=f.client.receipt;
  for(const changes of [{iss:'other'},{aud:'other'},{kind:'challenge'},{exp:good.iat+8*86400},
    {engines:['ct','unknown']},{revision:0},{nonce:'short'},{binding:{...good.binding,installationId:'other'}}]) {
    assert.throws(()=>P.verifyToken(P.signToken({...good,...changes},f.authority.key),f.authority.publicKey,'lease',f.config.binding));
  }
  const [header,body,sig]=f.client.token.split('.');
  assert.throws(()=>P.verifyToken(`${Buffer.from('{"alg":"none"}').toString('base64url')}.${body}.${sig}`,f.authority.publicKey,'lease',f.config.binding));
  assert.throws(()=>P.verifyToken(`${header}.${body}.${sig.slice(0,-3)}AAA`,f.authority.publicKey,'lease',f.config.binding));
  assert.throws(()=>P.json('{"nonce":"a","nonce":"b"}'));
  assert.throws(()=>P.decode('YQ=='));
  assert.throws(()=>localTransport('http://example.com:80/'));
  let challengeNonce;
  const badNonce=f.make({post:async(route,body)=>{
    if(route==='/v1/challenge'){challengeNonce=body.nonce;return f.authority.challenge(body);}
    return {token:P.signToken({...good,nonce:crypto.randomBytes(32).toString('base64url'),sequence:100},f.authority.key)};
  }});
  await badNonce.refresh();assert.equal(badNonce.receipt.sequence,good.sequence);assert.ok(challengeNonce);badNonce.close();
});

test('two authority handles persist issue order and re-read status after a challenge',async t=>{
  const f=fixture(t);const other=new Authority(f.server,()=>f.now());
  try {
    const first=f.authority.challenge(request(f)).token;
    const second=other.challenge(request(f)).token;
    const a=P.verifyToken(first,f.authority.publicKey,'challenge',f.config.binding);
    const b=P.verifyToken(second,f.authority.publicKey,'challenge',f.config.binding);
    const one=f.authority.lease({challengeId:a.challengeId,...await proof(f,first)});
    other.status('development-only','revoked');
    const two=other.lease({challengeId:b.challengeId,...await proof(f,second)});
    const claims=P.verifyToken(two.token,f.authority.publicKey,'lease',f.config.binding);
    assert.equal(claims.sequence,P.verifyToken(one.token,f.authority.publicKey,'lease',f.config.binding).sequence+1);
    assert.equal(claims.decision,'revoked');
  } finally {other.close();}
  const keyFile=path.join(f.server,'issuer-private.pem'),original=fs.readFileSync(keyFile);
  try {
    fs.writeFileSync(keyFile,crypto.generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}));
    assert.throws(()=>new Authority(f.server),/does not match/);
  } finally {fs.writeFileSync(keyFile,original);}
});

test('real loopback HTTP activation and restart with an atomic disk cache; browser/unknown fields rejected',async t=>{
  const f=fixture(t);const server=createServer(f.authority);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=`http://127.0.0.1:${server.address().port}`;
  const post=localTransport(address),store=fileStore(path.join(f.directory,'http-state.json'));
  const client=f.make({post,store});
  try {
    assert.equal(await client.refresh(),'VALID');await f.admit('lat',client);
    const restarted=f.make({post:async()=>{throw Error('offline');},store});
    assert.equal(restarted.state(),'GRACE');await f.admit('ap',restarted);restarted.close();
    await assert.rejects(post('/v1/challenge',{...request(f),patient:'forbidden'},new AbortController().signal));
    const body=JSON.stringify(request(f));
    const status=await new Promise((resolve,reject)=>{
      const req=http.request(`${address}/v1/challenge`,{method:'POST',headers:{Origin:'https://untrusted.invalid',
        'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{res.resume();resolve(res.statusCode);});
      req.on('error',reject);req.end(body);
    });
    assert.equal(status,400);
    assert.ok(!fs.readdirSync(f.directory).some(name=>name.endsWith('.tmp')));
  } finally {client.close();await new Promise(resolve=>server.close(resolve));}
});

test('network deadline fails closed without turning an unactivated client into grace',async t=>{
  const f=fixture(t);const hung=f.make({post:()=>new Promise(()=>{})});
  const started=performance.now();assert.equal(await hung.refresh(),'UNACTIVATED');
  assert.ok(performance.now()-started<12000);hung.close();
});

test('background renewal starts once, observes revocation, and stops on close',async t=>{
  const f=fixture(t);
  t.mock.timers.enable({apis:['setInterval']});
  f.client.start();f.client.start();await f.client.queue;
  assert.equal(f.client.state(),'VALID');
  assert.equal(f.authority.db.prepare('SELECT sequence FROM licenses').get().sequence,1);
  f.authority.status('development-only','revoked');f.advance(301);
  t.mock.timers.tick(30000);await f.client.queue;
  assert.equal(f.client.state(),'REVOKED');
  f.client.close();f.authority.status('development-only','active');
  t.mock.timers.tick(60000);await f.client.queue;
  assert.equal(f.client.state(),'REVOKED');
  assert.throws(()=>f.client.start(),/closed/);
});

test('a batch in grace does not repeat a failed network renewal for every case',async t=>{
  const f=fixture(t);await f.client.refresh();f.advance(301);
  let calls=0;
  const client=f.make({post:async()=>{calls++;throw Error('offline');}});
  for(const engine of ['ct','mri','ap'])assert.equal((await f.admit(engine,client)).state,'GRACE');
  assert.equal(calls,1);
  f.advance(30);await f.admit('lat',client);assert.equal(calls,2);client.close();
});

test('cancelling an admission interrupts a pending network or dongle operation promptly',async t=>{
  const f=fixture(t);
  for(const phase of ['network','dongle']) {
    let started;
    const waiting=new Promise(resolve=>{started=resolve;});
    const pending=()=>{started();return new Promise(()=>{});};
    if(phase==='dongle')await f.client.refresh();
    const client=f.make(phase==='network'?{post:pending}:{sign:pending});
    if(phase==='dongle')client.offline=false;
    const controller=new AbortController();
    const operation=f.admit('ct',client,controller.signal);
    await waiting;const before=performance.now();controller.abort();
    await assert.rejects(operation,/cancelled/);
    assert.ok(performance.now()-before<1000);client.close();
  }
});

test('approved internal installations require only fresh PC proofs, with expiry and revocation intact',async t=>{
  const f=fixture(t,'internal');f.remove();f.offline();
  await assert.rejects(f.admit(),/UNACTIVATED/);
  f.online();assert.equal(await f.client.refresh(),'VALID');
  for(const engine of [...P.ENGINES,'xray-classifier'])await f.admit(engine);
  assert.ok(f.proofs.length>0 && f.proofs.every(item=>item.role==='installation'));
  const fresh=f.proofs.filter(item=>item.message.includes('"runId"'));
  assert.equal(new Set(fresh.map(item=>item.message)).size,5);
  const bad=f.make({sign:async()=>Buffer.alloc(70)});await assert.rejects(f.admit('mri',bad),/개발 PC/);bad.close();
  f.advance(301);f.offline();await f.admit();assert.equal(f.client.state(),'GRACE');
  f.online();f.authority.status('development-only','revoked');assert.equal(await f.client.refresh(),'REVOKED');
  f.offline();await assert.rejects(f.admit(),/REVOKED/);
});

test('internal rights cannot be accepted by a customer build or customer authority, even with a trusted signing key',async t=>{
  const internal=fixture(t,'internal'),customer=fixture(t);
  await internal.client.refresh();
  assert.throws(()=>internal.make({profile:'customer'}),/profile/);
  assert.throws(()=>customer.make({profile:'internal'}),/profile/);
  assert.throws(()=>customer.authority.approve(internal.approval));
  assert.throws(()=>customer.authority.challenge(request(internal)));
  assert.throws(()=>P.verifyToken(internal.client.token,internal.authority.publicKey,'lease',customer.config.binding));
  assert.throws(()=>internal.authority.approve({...internal.approval,contractEnd:null}),/expiry/);
  assert.throws(()=>P.binding({...customer.config.binding,profile:'internal'}));
  assert.throws(()=>internal.authority.approve({...internal.approval,admin:true}));
  const forged=P.signToken({...internal.client.receipt,binding:{...internal.config.binding,profile:'customer'}},internal.authority.key);
  assert.throws(()=>P.verifyToken(forged,internal.authority.publicKey,'lease',customer.config.binding));
});

test('X-ray classification requires an AP or LAT grant and never gives permission to another segmentation engine',async t=>{
  const f=fixture(t,'internal');
  const config={...f.approval,engines:['lat']};f.authority.db.prepare('UPDATE licenses SET config=?').run(JSON.stringify(config));
  await f.client.refresh();await f.admit('xray-classifier');await f.admit('lat');await assert.rejects(f.admit('ap'),/권한/);
  config.engines=['ct'];f.authority.db.prepare('UPDATE licenses SET config=?').run(JSON.stringify(config));
  await f.client.refresh();await assert.rejects(f.admit('xray-classifier'),/권한/);
});

test('only EXMO can extend an internal approval; extending never clears a revocation',async t=>{
  const f=fixture(t,'internal');await f.client.refresh();
  f.advance(30*86400+1);assert.equal(await f.client.refresh(),'EXPIRED');
  f.authority.extend('development-only',f.now()+86400);assert.equal(await f.client.refresh(),'VALID');
  f.authority.status('development-only','revoked');await f.client.refresh();
  f.authority.extend('development-only',f.now()+2*86400);assert.equal(await f.client.refresh(),'REVOKED');
  assert.throws(()=>f.authority.extend('development-only',f.now()-1));
  assert.throws(()=>f.authority.extend('development-only',f.now()+86400));
});
