const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Authority,main:init}=require('./license-server.cjs');
const M=require('../../desktop/security/model-package.cjs'),P=require('../../desktop/security/license-protocol.cjs');
const {openResultStorage}=require('../../desktop/security/result-storage.cjs');
const E=require('../../desktop/security/model-envelope.cjs');
const ops=require('./server-ops.cjs');
function folder(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'exmo-ops-'));t.after(()=>{assert.ok(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});});return root;}
const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
test('result recovery survives a lost PC key, binds destination, and never overwrites a readable store',async t=>{
 const root=folder(t),issuer=crypto.generateKeyPairSync('ed25519'),institution=crypto.generateKeyPairSync('rsa',{modulusLength:3072}),pc=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
 const binding={profile:'internal',licenseId:'recovery',installationId:'old',installationKey:'a'.repeat(64)};
 const store=openResultStorage(root,safeStorage),secret=store.bootstrap('unused').key;
 assert.equal(store.hasRecovery(),false);
 store.recovery(M.sign({schema:'exmo-result-recovery-v1',binding,recoveryPublicKey:institution.publicKey.export({type:'spki',format:'pem'})},issuer.privateKey),issuer.publicKey,binding);
 assert.equal(store.hasRecovery(),true);
 const envelope=JSON.parse(fs.readFileSync(path.join(root,'result-recovery.json')));
 const plain=crypto.privateDecrypt({key:institution.privateKey,oaepHash:'sha256'},P.decode(envelope.wrappedKey));assert.equal(plain.toString('base64url'),secret);
 const identity={installationId:'new',modelKeyPublicKey:pc.publicKey.export({type:'spki',format:'pem'})};
 const claims={schema:'exmo-result-restore-v1',id:envelope.id,installationId:identity.installationId,recipient:P.fingerprint(pc.publicKey),wrappedKey:crypto.publicEncrypt({key:pc.publicKey,oaepHash:'sha256'},plain).toString('base64url')};plain.fill(0);
 const token=M.sign(claims,issuer.privateKey),unwrap=b=>crypto.privateDecrypt({key:pc.privateKey,oaepHash:'sha256'},b);
 await assert.rejects(store.restore(token,issuer.publicKey,identity,unwrap));
 fs.writeFileSync(path.join(root,'results-key.bin'),'broken');
 const restored=openResultStorage(root,safeStorage);assert.equal(restored.ready(),false);
 await assert.rejects(restored.restore(token,issuer.publicKey,{...identity,installationId:'wrong'},unwrap));
 await restored.restore(token,issuer.publicKey,identity,unwrap);assert.equal(restored.bootstrap('unused').key,secret);
 assert.equal(openResultStorage(root,safeStorage).bootstrap('unused').key,secret);assert.equal(restored.hasRecovery(),false);
});
test('RSA outer JWE binds context, rejects tampering, and uses the platform unwrap callback',async()=>{
 const pair=crypto.generateKeyPairSync('rsa',{modulusLength:3072}),context='a'.repeat(64),inner='protected.inner.jwe';
 const token=E.wrap(inner,pair.publicKey,context),unwrap=b=>crypto.privateDecrypt({key:pair.privateKey,oaepHash:'sha256'},b);
 assert.equal(await E.unwrap(token,unwrap,context),inner);
 await assert.rejects(E.unwrap(token,unwrap,'b'.repeat(64)));
 for(let i=0;i<5;i++){const parts=token.split('.'),raw=Buffer.from(parts[i],'base64url');raw[raw.length-1]^=1;parts[i]=raw.toString('base64url');await assert.rejects(E.unwrap(parts.join('.'),unwrap,context));}
});
test('signed authority backup restores exact revision, rejects corrupt DB or missing keys, and generates bounded TLS proxy',t=>{
 const root=folder(t),source=path.join(root,'authority'),copy=path.join(root,'backup'),restored=path.join(root,'restored');init(['init',source,'internal']);
 const a=new Authority(source),pc=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),binding={profile:'internal',licenseId:'test',installationId:'pc',installationKey:P.fingerprint(pc.publicKey)};
 a.approve({binding,installationPublicKey:pc.publicKey.export({type:'spki',format:'pem'}),engines:['ct'],contractEnd:Math.floor(Date.now()/1000)+3600,graceSeconds:300,renewSeconds:60});a.status('test','revoked');
 const digest='1'.repeat(64);a.db.prepare('INSERT INTO model_grants VALUES (?,?,?)').run('test','ct',digest);a.close();
 fs.mkdirSync(path.join(source,'model-keys'));fs.writeFileSync(path.join(source,'model-keys',digest+'.key'),crypto.randomBytes(32));
 ops.backup(source,copy);const pem=path.join(source,'issuer-public.pem'),pub=crypto.createPublicKey(fs.readFileSync(pem));ops.verify(copy,pub);
 ops.main(['restore',copy,pem,restored]);const b=new Authority(restored);assert.equal(b.db.prepare('SELECT status,revision FROM licenses').get().status,'revoked');assert.equal(b.db.prepare('SELECT revision FROM licenses').get().revision,2);b.close();
 fs.appendFileSync(path.join(copy,'authority.sqlite'),'tampered');assert.throws(()=>ops.verify(copy,pub));
 const deployment=path.join(root,'deploy');ops.main(['deploy-files','license.example.invalid',deployment]);
 const config=fs.readFileSync(path.join(deployment,'exmo-license.conf'),'utf8');assert.match(config,/TLSv1.2 TLSv1.3/);assert.match(config,/client_max_body_size 16k/);assert.match(config,/127.0.0.1:43127/);
 assert.throws(()=>ops.main(['deploy-files','bad;host',path.join(root,'bad')]));
});
