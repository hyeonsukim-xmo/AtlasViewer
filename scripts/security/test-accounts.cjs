const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const P=require('../../desktop/security/license-protocol.cjs'),M=require('../../desktop/security/model-package.cjs');
const {openAccount}=require('../../desktop/security/account.cjs');
const {validateBuild}=require('../../desktop/security/runtime.cjs');
const {Accounts}=require('./account-server.cjs');
const {Authority,main}=require('./license-server.cjs');
const {cleanup,temporary,safeStorage,setup,device,prepare}=require('./account-test-fixtures.cjs');

test('real OIDC/PKCE, PC proof, EXMO-only approval, signed activation and logout preserve device license',async t=>{
  const f=await setup(t),licensing=await device(t,f),safe=safeStorage(),directory=path.join(f.root,'account');
  let account=openAccount({config:f.config,directory,safeStorage:safe,openExternal:f.idp.browser,licensing,allowLoopback:true});cleanup(t,()=>account.close());
  const logged=await account.login();assert.equal(logged.me.subject,'manager');assert.equal(logged.me.operator,false);assert.equal(logged.me.memberships.length,2);
  const file=path.join(directory,'session.bin');assert.ok(!fs.readFileSync(file).includes(f.idp.settings.issued[0]));
  assert.ok(!JSON.stringify(account.status()).includes('Token'));await account.workspace('hospital-a','research');
  const row=await account.enroll();assert.equal(row.state,'pending');
  assert.equal((await account.enroll()).id,row.id,'Same PC registration is idempotent');
  const proof=await licensing.enrollmentProof(f.accounts.challenge({sub:'manager'},{orgId:'hospital-a',workspaceId:'research'}));
  f.accounts.enroll({sub:'manager'},proof);assert.throws(()=>f.accounts.enroll({sub:'manager'},proof),/already used/);
  await assert.rejects(account.decide(row.id,row.revision,'internal-exempt','approve'),/operator/);
  prepare(f,await licensing.enrollment(),row);
  const operator={sub:'operator',amr:['mfa'],auth_time:Math.floor(Date.now()/1000)},ready=f.accounts.row(row.id);
  assert.throws(()=>f.accounts.decide({...operator,amr:[]},row.id,{revision:ready.revision,keyPolicy:'internal-exempt',decision:'approve'}),/MFA/);
  assert.throws(()=>f.accounts.decide(operator,row.id,{revision:ready.revision,keyPolicy:'required',decision:'approve'}),/matching installation/);
  f.accounts.decide(operator,row.id,{revision:ready.revision,keyPolicy:'internal-exempt',decision:'approve'});
  assert.throws(()=>f.accounts.decide(operator,row.id,{revision:ready.revision,keyPolicy:'internal-exempt',decision:'approve'}),/changed/);
  await account.activate(row.id);assert.equal(licensing.status().state,'VALID');assert.equal(licensing.status().orgId,'hospital-a');
  await assert.rejects(account.workspace('hospital-b','research'),/another organization/);
  assert.equal(f.accounts.me(operator).memberships.length,0,'Operator gains no clinical workspace rights');assert.throws(()=>f.accounts.activation(operator,row.id),/membership/);
  const lease=fs.readFileSync(path.join(f.root,'device/lease.bin'));
  account.close();account=openAccount({config:f.config,directory,safeStorage:safe,openExternal:f.idp.browser,licensing,allowLoopback:true});
  assert.equal(account.status().state,'restorable');await Promise.all([account.refresh(),account.refresh()]);assert.equal(f.idp.settings.refreshes,1,'Concurrent API calls rotate once');
  account.logout();assert.equal(fs.existsSync(file),false);assert.equal(licensing.status().state,'VALID');assert.deepEqual(fs.readFileSync(path.join(f.root,'device/lease.bin')),lease);
  assert.ok(f.authority.db.prepare("SELECT 1 FROM account_audit WHERE actor='operator' AND event='enrollment-approve'").get());
});

test('OIDC nonce/signature rejection, login cancellation, timeout and unavailable server do not grant cloud rights',async t=>{
  const f=await setup(t),directory=path.join(f.root,'account'),safe=safeStorage();
  const account=openAccount({config:f.config,directory,safeStorage:safe,openExternal:f.idp.browser,allowLoopback:true,loginTimeoutMs:200});cleanup(t,()=>account.close());
  f.idp.settings.badNonce=true;await assert.rejects(account.login());assert.equal(account.status().me,null);
  f.idp.settings.badNonce=false;f.idp.settings.badSignature=true;await assert.rejects(account.login());assert.equal(fs.existsSync(path.join(directory,'session.bin')),false);
  f.idp.settings.badSignature=false;f.idp.settings.stall=true;
  await assert.rejects(account.login(),/timed out/);
  const pending=account.login();await new Promise(r=>setTimeout(r,40));account.logout();await assert.rejects(pending,/cancelled/);assert.equal(account.status().state,'signed-out');
  f.idp.settings.stall=false;await account.login();
  f.accounts.membership('manager','hospital-a','research','Research',[]);await assert.rejects(account.workspace('hospital-a','research'),/membership/);
  const other=openAccount({config:{...f.config,apiUrl:'http://127.0.0.1:1'},directory:path.join(f.root,'other'),safeStorage:safe,openExternal:f.idp.browser,allowLoopback:true});
  await assert.rejects(other.login());assert.equal(other.status().me,null);other.close();
});

test('API rejects wrong audience/scope/client, expired tokens, hostile browser origins and hospital-admin policy changes',async t=>{
  const f=await setup(t),now=Math.floor(Date.now()/1000);
  const good={sub:'operator',aud:f.idp.base+'/api',azp:'desktop',scope:'exmo.account',amr:['mfa'],auth_time:now};
  for(const bad of [{aud:'desktop'},{scope:'openid'},{azp:'web'}])await assert.rejects(f.verify(await f.idp.sign({...good,...bad})));
  await assert.rejects(f.verify(await f.idp.sign(good,now-60)));
  const token=await f.idp.sign(good);
  assert.equal((await fetch(f.apiUrl+'/v1/me',{headers:{Authorization:'Bearer '+token,Origin:'https://attacker.invalid'}})).status,403);
  assert.equal((await fetch(f.apiUrl+'/v1/me',{headers:{Authorization:'Bearer invalid'}})).status,401);
  assert.equal((await fetch(f.apiUrl+'/v1/me',{headers:{Authorization:'Bearer '+token}})).status,200);
  assert.throws(()=>f.accounts.decide({sub:'manager',amr:['mfa'],auth_time:now},'x',{revision:1,keyPolicy:'internal-exempt',decision:'approve'}),/operator/);
  assert.throws(()=>f.accounts.challenge({sub:'analyst'},{orgId:'hospital-a',workspaceId:'research'}),/administrator/);
  f.accounts.operator('operator',false);assert.equal(f.accounts.me(good).operator,false);
  f.accounts.pinIssuer(f.idp.base);assert.throws(()=>f.accounts.pinIssuer('https://other.invalid'),/migration/);
});

test('customer enrollment needs both fresh PC and hardware signatures and never accepts internal exemption',async t=>{
  const root=temporary(t),directory=path.join(root,'authority');main(['init',directory,'customer']);
  const authority=new Authority(directory);cleanup(t,()=>authority.close());const accounts=new Accounts(authority);
  accounts.membership('manager','hospital-a','research','Research',['device-admin']);accounts.operator('operator',true);
  const python=path.resolve('work/security-poc/env/Scripts/python.exe');
  const result=require('node:child_process').spawnSync(python,['-B',path.join(__dirname,'customer-fixture.py')],{input:JSON.stringify({operation:'fixture'})+'\n',encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);const fixture=JSON.parse(result.stdout);
  const pc=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),rsa=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
  const request={profile:'customer',installationId:crypto.randomUUID(),installationKey:P.fingerprint(pc.publicKey),installationPublicKey:pc.publicKey.export({format:'pem',type:'spki'}),modelKeyPublicKey:rsa.publicKey.export({format:'pem',type:'spki'}),hardware:fixture.hardware};
  request.modelKeySignature=crypto.sign('sha256',M.enrollmentMessage(request),pc.privateKey).toString('base64url');
  const actor={sub:'manager'},challenge=accounts.challenge(actor,{orgId:'hospital-a',workspaceId:'research'}),message=require('../../desktop/security/account-protocol.cjs').enrollmentMessage(challenge,request);
  const proof={challenge,request,signature:crypto.sign('sha256',message,pc.privateKey).toString('base64url'),dongleSignature:crypto.sign('sha256',message,fixture.keys['9e']).toString('base64url')};
  assert.throws(()=>accounts.enroll(actor,{...proof,dongleSignature:proof.signature}),/Hardware/);
  assert.throws(()=>accounts.enroll(actor,{...proof,signature:proof.dongleSignature}),/Installation/);
  const row=accounts.enroll(actor,proof);
  request.modelKeySignature=crypto.sign('sha256',M.enrollmentMessage(request),pc.privateKey).toString('base64url');
  const secondChallenge=accounts.challenge(actor,{orgId:'hospital-a',workspaceId:'research'}),secondMessage=require('../../desktop/security/account-protocol.cjs').enrollmentMessage(secondChallenge,request);
  assert.equal(accounts.enroll(actor,{challenge:secondChallenge,request,signature:crypto.sign('sha256',secondMessage,pc.privateKey).toString('base64url'),dongleSignature:crypto.sign('sha256',secondMessage,fixture.keys['9e']).toString('base64url')}).id,row.id,'A fresh enrollment signature does not create another customer/device');
  assert.throws(()=>accounts.decide({sub:'operator',amr:['mfa'],auth_time:authority.clock()},row.id,{revision:row.revision,keyPolicy:'internal-exempt',decision:'approve'}),/matching installation/);
  assert.equal(authority.db.prepare('SELECT count(*) n FROM licenses').get().n,0,'Enrollment alone never issues a device license');
});

test('one device license adds MRI alongside CT; operator changes only the chosen solution and model revocation stays scoped',async t=>{
  const f=await setup(t),licensing=await device(t,f),manager={sub:'manager'},operator={sub:'operator',amr:['mfa'],auth_time:f.authority.clock()};
  const row=f.accounts.enroll(manager,await licensing.enrollmentProof(f.accounts.challenge(manager,{orgId:'hospital-a',workspaceId:'research'})));
  const request=await licensing.enrollment(),first=prepare(f,request,row);
  f.accounts.decide(operator,row.id,{revision:f.accounts.row(row.id).revision,keyPolicy:'internal-exempt',decision:'approve'});
  const licenseId=first.binding.licenseId,before=JSON.stringify(first.binding),digest='d'.repeat(64);
  f.accounts.enableEngines(row.id,['mri']);
  assert.deepEqual(JSON.parse(f.authority.db.prepare('SELECT config FROM licenses WHERE id=?').get(licenseId).config).engines,['ct','mri']);
  f.authority.db.prepare("INSERT INTO models VALUES(?,'active')").run(digest);f.authority.db.prepare('INSERT INTO model_grants VALUES(?,?,?)').run(licenseId,'mri',digest);
  const assignment=JSON.parse(f.authority.db.prepare('SELECT document FROM solution_assignments WHERE license=?').get(licenseId).document);
  assignment.entitlements.push({...assignment.entitlements[0],entitlementId:'mri',solutionId:'exmo.thigh.mri',state:'suspended',executions:[{...assignment.entitlements[0].executions[0],solutionId:'exmo.thigh.mri',engine:'mri',modelDigest:digest,workflowId:'thigh-mri-water-v1'}]});
  f.authority.solutions(licenseId,assignment);
  const envelope=M.sign({schema:'exmo-model-access-v1',binding:first.binding,modelDigest:digest,recipient:P.fingerprint(M.rsa(request.modelKeyPublicKey)),wrappedKey:crypto.randomBytes(384).toString('base64url')},f.authority.key);
  f.accounts.prepare(row.id,{...first,models:{mri:envelope}});
  let view=f.accounts.dto(f.accounts.row(row.id));assert.equal(view.solutions.length,2);
  assert.throws(()=>f.accounts.solution(manager,row.id,{revision:view.licenseRevision,solutionId:'exmo.thigh.mri',state:'active'}),/operator/);
  const oldRevision=view.licenseRevision;view=f.accounts.solution(operator,row.id,{revision:oldRevision,solutionId:'exmo.thigh.mri',state:'active'});
  assert.deepEqual(view.solutions.map(s=>s.state),['active','active']);
  assert.throws(()=>f.accounts.solution(operator,row.id,{revision:oldRevision,solutionId:'exmo.thigh.ct',state:'suspended'}),/changed/);
  const updated=f.accounts.activation(manager,row.id).activation;assert.equal(JSON.stringify(updated.binding),before);assert.deepEqual(Object.keys(updated.models).sort(),['ct','mri']);
  assert.equal(f.authority.db.prepare('SELECT count(*) n FROM licenses').get().n,1);
  f.authority.modelStatus(digest,'revoked');assert.deepEqual(Object.keys(f.accounts.activation(manager,row.id).activation.models),['ct']);
  view=f.accounts.dto(f.accounts.row(row.id));view=f.accounts.solution(operator,row.id,{revision:view.licenseRevision,solutionId:'exmo.thigh.ct',state:'suspended'});assert.equal(view.solutions.find(s=>s.solutionId==='exmo.thigh.ct').state,'suspended');
  assert.throws(()=>f.accounts.solution(operator,row.id,{revision:view.licenseRevision,solutionId:'exmo.thigh.mri',state:'active'}),/model approval/);
});

test('unconfigured account is nonblocking; production config cannot enable loopback, secrets or renderer-selected issuers',t=>{
  assert.deepEqual(openAccount({}).status(),{state:'unconfigured',me:null,workspace:null});
  const publicKey=crypto.generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
  const base={profile:'customer',issuerPublicKey:publicKey,serverUrl:'https://license.example.invalid',allowLoopback:false,licenseVersion:3};
  const account={issuer:'https://identity.example.invalid',clientId:'desktop',apiUrl:'https://accounts.example.invalid',resource:'https://accounts.example.invalid'};
  assert.ok(validateBuild({...base,account}));assert.throws(()=>validateBuild({...base,account:{...account,clientSecret:'secret'}}));
  const locked=path.join(temporary(t),'not-a-directory');fs.writeFileSync(locked,'fixture');
  assert.equal(openAccount({config:account,directory:locked}).status().state,'storage-unavailable');
  assert.throws(()=>validateBuild({...base,account:{...account,issuer:'http://127.0.0.1'}}));
  const handlers=new Map(),ipcMain={handle:(name,fn)=>handlers.set(name,fn),removeHandler:name=>handlers.delete(name)},frame={url:'atlas://app/'};
  const events=[],window={webContents:{mainFrame:frame,isDestroyed:()=>false,send:(...args)=>events.push(args)}},fake={status:()=>({state:'unconfigured'}),close(){}};
  const cleanup=require('../../desktop/security/account-ui.cjs').installAccountUi({ipcMain,window,account:fake});
  return (async()=>{await assert.rejects(handlers.get('exmo:account:status')({sender:{},senderFrame:frame}));assert.equal((await handlers.get('exmo:account:status')({sender:window.webContents,senderFrame:frame})).ok,true);assert.deepEqual(events,[['exmo:account:changed',{state:'unconfigured'}]]);cleanup();assert.equal(handlers.size,0);})();
});
