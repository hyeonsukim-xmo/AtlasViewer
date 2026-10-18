// Server only. The desktop receives account DTOs and installation-bound approvals, never issuer keys.
const fs=require('node:fs');
const http=require('node:http');
const crypto=require('node:crypto');
const P=require('../../desktop/security/license-protocol.cjs');
const M=require('../../desktop/security/model-package.cjs');
const A=require('../../desktop/security/account-protocol.cjs');
const {Authority}=require('./license-server.cjs');
const {read}=require('../../desktop/security/storage.cjs');
function fail(condition,status,message){if(!condition)throw Object.assign(Error(message),{status});}

class Accounts{
  constructor(authority){
    this.authority=authority;this.db=authority.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS account_issuer(issuer TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS account_operators(subject TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS account_workspaces(org TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(org,id));
      CREATE TABLE IF NOT EXISTS account_members(subject TEXT NOT NULL,org TEXT NOT NULL,workspace TEXT NOT NULL,roles TEXT NOT NULL,PRIMARY KEY(subject,org,workspace));
      CREATE TABLE IF NOT EXISTS account_challenges(id TEXT PRIMARY KEY,subject TEXT NOT NULL,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_enrollments(id TEXT PRIMARY KEY,subject TEXT NOT NULL,org TEXT NOT NULL,workspace TEXT NOT NULL,
        installation TEXT NOT NULL UNIQUE,request TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,policy TEXT,activation TEXT);
      CREATE TABLE IF NOT EXISTS account_audit(at INTEGER NOT NULL,actor TEXT NOT NULL,event TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL);`);
  }
  pinIssuer(issuer){
    this.authority.transaction(()=>{const row=this.db.prepare('SELECT issuer FROM account_issuer').get();
      P.check(!row || row.issuer===issuer,'Account issuer migration requires explicit review');
      if(!row)this.db.prepare('INSERT INTO account_issuer VALUES(?)').run(issuer);});
  }
  audit(actor,event,target,detail){this.db.prepare('INSERT INTO account_audit VALUES(?,?,?,?,?)').run(this.authority.clock(),actor,event,target,JSON.stringify(detail));}
  operator(subject,enabled){A.text(subject,512);this.authority.transaction(()=>{if(enabled)this.db.prepare('INSERT OR IGNORE INTO account_operators VALUES(?)').run(subject);else this.db.prepare('DELETE FROM account_operators WHERE subject=?').run(subject);this.audit('server-console','operator',subject,{enabled});});}
  membership(subject,org,workspace,name,roles){
    A.text(subject,512);P.id(org);P.id(workspace);A.text(name);P.check(Array.isArray(roles) && roles.every(r=>A.ROLES.includes(r)) && new Set(roles).size===roles.length);
    this.authority.transaction(()=>{
      this.db.prepare('INSERT INTO account_workspaces VALUES(?,?,?) ON CONFLICT(org,id) DO UPDATE SET name=excluded.name').run(org,workspace,name);
      if(roles.length)this.db.prepare('INSERT INTO account_members VALUES(?,?,?,?) ON CONFLICT(subject,org,workspace) DO UPDATE SET roles=excluded.roles').run(subject,org,workspace,JSON.stringify(roles));
      else this.db.prepare('DELETE FROM account_members WHERE subject=? AND org=? AND workspace=?').run(subject,org,workspace);
      this.audit('server-console','membership',subject,{org,workspace,roles});
    });
  }
  isOperator(actor){return !!this.db.prepare('SELECT 1 FROM account_operators WHERE subject=?').get(actor.sub);}
  member(actor,org,workspace,role){
    const row=this.db.prepare('SELECT roles FROM account_members WHERE subject=? AND org=? AND workspace=?').get(actor.sub,org,workspace);
    return row && (!role || JSON.parse(row.roles).includes(role));
  }
  requireOperator(actor){
    fail(this.isOperator(actor),403,'EXMO operator permission required');
    fail(Array.isArray(actor.amr) && actor.amr.includes('mfa') && Number.isInteger(actor.auth_time) && actor.auth_time<=this.authority.clock()+30 && this.authority.clock()-actor.auth_time<=600,403,'Recent EXMO operator MFA sign-in required');
  }
  me(actor){
    return A.me({subject:actor.sub,name:typeof actor.name==='string'?A.text(actor.name):actor.sub,operator:this.isOperator(actor),
      memberships:this.db.prepare('SELECT m.org,m.workspace,w.name,m.roles FROM account_members m JOIN account_workspaces w ON w.org=m.org AND w.id=m.workspace WHERE m.subject=? ORDER BY m.org,m.workspace LIMIT 200').all(actor.sub)
        .map(r=>({orgId:r.org,workspaceId:r.workspace,name:r.name,roles:JSON.parse(r.roles)}))});
  }
  challenge(actor,body){
    P.fields(body,['orgId','workspaceId']);P.id(body.orgId);P.id(body.workspaceId);
    fail(this.member(actor,body.orgId,body.workspaceId,'device-admin'),403,'Device administrator membership required');
    return this.authority.transaction(()=>{
      this.db.prepare('DELETE FROM account_challenges WHERE subject=?').run(actor.sub);
      const challenge={id:crypto.randomUUID(),nonce:crypto.randomBytes(32).toString('base64url'),...body,expiresAt:this.authority.clock()+120};
      this.db.prepare('INSERT INTO account_challenges VALUES(?,?,?)').run(challenge.id,actor.sub,JSON.stringify(challenge));return challenge;
    });
  }
  enroll(actor,body){
    P.fields(body,['challenge','request','signature',...(body.request?.profile==='customer'?['dongleSignature']:[])]);
    const {challenge,request}=body;A.challenge(challenge);M.validateEnrollment(request);
    fail(request.profile===this.authority.profile,409,'Install the build matching this authority');
    fail(this.member(actor,challenge.orgId,challenge.workspaceId,'device-admin'),403,'Device administrator membership required');
    const message=A.enrollmentMessage(challenge,request);
    fail(crypto.verify('sha256',message,P.p256(request.installationPublicKey),P.decode(body.signature)),403,'Installation proof rejected');
    if(request.profile==='customer')fail(crypto.verify('sha256',message,M.hardwareKeys(request.hardware)['9e'],P.decode(body.dongleSignature)),403,'Hardware proof rejected');
    return this.authority.transaction(()=>{
      fail(this.member(actor,challenge.orgId,challenge.workspaceId,'device-admin'),403,'Device administrator membership required');
      const c=this.db.prepare('SELECT * FROM account_challenges WHERE id=? AND subject=?').get(challenge.id,actor.sub);
      fail(c && c.document===JSON.stringify(challenge) && challenge.expiresAt>this.authority.clock(),409,'Enrollment challenge expired or already used');
      this.db.prepare('DELETE FROM account_challenges WHERE id=?').run(challenge.id);
      const existing=this.db.prepare('SELECT * FROM account_enrollments WHERE installation=?').get(request.installationId);
      if(existing){fail(existing.org===challenge.orgId && existing.workspace===challenge.workspaceId && M.enrollmentMessage(JSON.parse(existing.request)).equals(M.enrollmentMessage(request)),409,'Installation is already registered; operator transfer required');
        if(existing.state==='rejected'){
          this.db.prepare("UPDATE account_enrollments SET state='pending',policy=NULL,revision=revision+1 WHERE id=?").run(existing.id);
          this.audit(actor.sub,'enrollment-resubmitted',existing.id,{orgId:existing.org});
        }
        return this.dto(this.row(existing.id));}
      const license=this.db.prepare('SELECT id FROM licenses WHERE installation=?').get(request.installationId);
      if(license){const assignment=this.db.prepare('SELECT document FROM solution_assignments WHERE license=?').get(license.id);
        fail(assignment && JSON.parse(assignment.document).orgId===challenge.orgId,409,'Device belongs to another organization or requires an explicit v3 assignment');}
      const id=crypto.randomUUID();
      this.db.prepare("INSERT INTO account_enrollments VALUES(?,?,?,?,?,?,'pending',1,NULL,NULL)").run(id,actor.sub,challenge.orgId,challenge.workspaceId,request.installationId,JSON.stringify(request));
      this.audit(actor.sub,'enrollment-requested',id,{orgId:challenge.orgId,workspaceId:challenge.workspaceId,profile:request.profile});return this.dto(this.row(id));
    });
  }
  row(id){P.id(id);const row=this.db.prepare('SELECT * FROM account_enrollments WHERE id=?').get(id);fail(row,404,'Enrollment not found');return row;}
  dto(row){
    const licenseId=row.activation?JSON.parse(row.activation).binding.licenseId:null;
    const license=licenseId?this.db.prepare('SELECT revision FROM licenses WHERE id=?').get(licenseId):null;
    const assignment=licenseId?this.db.prepare('SELECT document FROM solution_assignments WHERE license=?').get(licenseId):null;
    return {id:row.id,orgId:row.org,workspaceId:row.workspace,installationId:row.installation,profile:JSON.parse(row.request).profile,state:row.state,revision:row.revision,keyPolicy:row.policy,prepared:!!row.activation,
      licenseRevision:license?.revision??null,solutions:assignment?JSON.parse(assignment.document).entitlements.map(e=>({solutionId:e.solutionId,state:e.state,expiresAt:e.validUntil})):[]};
  }
  list(actor){
    const rows=this.isOperator(actor)?this.db.prepare('SELECT * FROM account_enrollments ORDER BY rowid DESC LIMIT 200').all():
      this.db.prepare("SELECT e.* FROM account_enrollments e JOIN account_members m ON m.org=e.org AND m.workspace=e.workspace WHERE m.subject=? ORDER BY e.rowid DESC LIMIT 200").all(actor.sub).filter(r=>this.member(actor,r.org,r.workspace,'device-admin'));
    return rows.map(r=>this.dto(r));
  }
  validateActivation(row,activation){
    const request=JSON.parse(row.request),customer=request.profile==='customer';
    P.fields(activation,['binding','installationPublicKey','models',...(customer?['hardware']:[]),...(activation.recovery?['recovery']:[])]);
    P.check(!customer || activation.recovery,'Customer result recovery approval required');
    const hardware=customer?M.hardwareKeys(request.hardware):null;
    P.sameBinding(activation.binding,{profile:request.profile,licenseId:activation.binding.licenseId,installationId:request.installationId,installationKey:request.installationKey,
      ...(customer?{dongleKey:P.fingerprint(hardware['9e']),agreementKey:P.fingerprint(hardware['9d'])}:{})});
    P.check(activation.installationPublicKey===request.installationPublicKey && (!customer || JSON.stringify(activation.hardware)===JSON.stringify(request.hardware)),'Approval does not match enrollment');
    const license=this.db.prepare('SELECT config,status FROM licenses WHERE id=?').get(activation.binding.licenseId);
    P.check(license && ['active','suspended'].includes(license.status),'License unavailable');P.sameBinding(JSON.parse(license.config).binding,activation.binding);
    const expiry=JSON.parse(license.config).contractEnd;P.check(expiry===null || expiry>this.authority.clock(),'License expired');
    const assignment=this.db.prepare('SELECT document FROM solution_assignments WHERE license=?').get(activation.binding.licenseId);
    P.check(assignment && JSON.parse(assignment.document).orgId===row.org,'License organization differs');
    P.check(activation.models && Object.keys(activation.models).length>0,'Prepare model permissions before approval');
    for(const [engine,token] of Object.entries(activation.models)){
      P.check(M.ENGINES.includes(engine));const access=M.envelope(token,this.authority.publicKey,activation.binding,request.modelKeyPublicKey);
      P.check(this.db.prepare("SELECT 1 FROM model_grants g JOIN models m ON g.digest=m.digest WHERE g.license=? AND g.engine=? AND g.digest=? AND m.status='active'").get(activation.binding.licenseId,engine,access.modelDigest),'Model grant differs');
    }
  }
  prepare(id,activation){
    return this.authority.transaction(()=>{
      const row=this.row(id);P.check(['pending','approved'].includes(row.state),'Enrollment must be pending or approved');
      if(row.activation){const old=this.currentActivation(row);P.sameBinding(old.binding,activation.binding);activation={...old,...activation,models:{...old.models,...activation.models}};}
      this.validateActivation(row,activation);
      if(row.state==='pending'){
        const license=this.db.prepare("UPDATE licenses SET status='suspended',revision=revision+1 WHERE id=? RETURNING revision").get(activation.binding.licenseId);
        this.db.prepare('INSERT INTO audit VALUES(?,?,?,?)').run(this.authority.clock(),activation.binding.licenseId,'suspended',license.revision);
      }
      this.db.prepare('UPDATE account_enrollments SET activation=?,revision=revision+1 WHERE id=?').run(JSON.stringify(activation),id);this.audit('server-console','approval-prepared',id,{licenseId:activation.binding.licenseId});
    });
  }
  enableEngines(id,engines){
    P.check(Array.isArray(engines) && engines.length>0 && engines.every(e=>P.ENGINES.includes(e)),'Unknown model engine');
    this.authority.transaction(()=>{
      const enrollment=this.row(id);P.check(enrollment.activation && ['pending','approved'].includes(enrollment.state),'Prepare the device approval first');
      const licenseId=JSON.parse(enrollment.activation).binding.licenseId;
      const row=this.db.prepare('SELECT * FROM licenses WHERE id=?').get(licenseId),config=JSON.parse(row.config);
      P.check(['active','suspended'].includes(row.status) && this.db.prepare('SELECT 1 FROM solution_assignments WHERE license=?').get(licenseId),'A non-revoked v3 device is required');
      config.engines=[...new Set([...config.engines,...engines])];
      this.db.prepare('UPDATE licenses SET config=?,revision=revision+1 WHERE id=?').run(JSON.stringify(config),licenseId);
      this.audit('server-console','model-engines-prepared',id,{engines});
    });
  }
  solution(actor,id,body){
    P.fields(body,['revision','solutionId','state']);P.integer(body.revision);
    require('../../desktop/security/license-v3.cjs').name(body.solutionId);P.check(['active','suspended'].includes(body.state));
    return this.authority.transaction(()=>{
      this.requireOperator(actor);
      const row=this.row(id);fail(row.state==='approved',409,'EXMO operator approval required');
      const activation=this.currentActivation(row),licenseId=activation.binding.licenseId;this.validateActivation(row,activation);
      const license=this.db.prepare('SELECT revision,status FROM licenses WHERE id=?').get(licenseId);
      fail(license.revision===body.revision && license.status==='active',409,'License changed; refresh before updating solutions');
      const document=JSON.parse(this.db.prepare('SELECT document FROM solution_assignments WHERE license=?').get(licenseId).document);
      const entry=document.entitlements.find(e=>e.solutionId===body.solutionId);
      fail(entry && entry.state!=='revoked' && (entry.validUntil===null || entry.validUntil>this.authority.clock()),409,'A current, prepared solution entitlement is required');
      if(body.state==='active')fail(entry.executions.length>0 && entry.executions.filter(e=>e.modelDigest!==null).every(e=>activation.models[e.engine] && M.envelope(activation.models[e.engine],this.authority.publicKey,activation.binding,JSON.parse(row.request).modelKeyPublicKey).modelDigest===e.modelDigest),409,'Prepare the selected solution model approval first');
      entry.state=body.state;entry.revision++;
      this.authority.solutions(licenseId,document,{inTransaction:true});this.audit(actor.sub,'solution-status',id,{solutionId:entry.solutionId,state:body.state});return this.dto(this.row(id));
    });
  }
  currentActivation(row){
    const activation=JSON.parse(row.activation),request=JSON.parse(row.request);
    activation.models=Object.fromEntries(Object.entries(activation.models).filter(([engine,token])=>{
      const access=M.envelope(token,this.authority.publicKey,activation.binding,request.modelKeyPublicKey);
      return this.db.prepare("SELECT 1 FROM model_grants g JOIN models m ON g.digest=m.digest WHERE g.license=? AND g.engine=? AND g.digest=? AND m.status='active'").get(activation.binding.licenseId,engine,access.modelDigest);
    }));return activation;
  }
  decide(actor,id,body){
    P.fields(body,['revision','keyPolicy','decision']);P.integer(body.revision);
    P.check(['required','internal-exempt'].includes(body.keyPolicy) && ['approve','reject'].includes(body.decision));
    return this.authority.transaction(()=>{
      this.requireOperator(actor);
      const row=this.row(id);fail(row.state==='pending' && row.revision===body.revision,409,'Enrollment changed; refresh before approval');
      const expected=JSON.parse(row.request).profile==='customer'?'required':'internal-exempt';
      fail(body.keyPolicy===expected,409,'Key policy requires the matching installation and encrypted model package; it cannot be switched in this build');
      if(body.decision==='approve'){
        fail(row.activation,409,'Operator must prepare the signed device and model approvals first');
        const activation=JSON.parse(row.activation);this.validateActivation(row,activation);
        const license=this.db.prepare("UPDATE licenses SET status='active',revision=revision+1 WHERE id=? RETURNING revision").get(activation.binding.licenseId);
        this.db.prepare('INSERT INTO audit VALUES (?,?,?,?)').run(this.authority.clock(),activation.binding.licenseId,'account-approved',license.revision);
      }
      this.db.prepare('UPDATE account_enrollments SET state=?,policy=?,revision=revision+1 WHERE id=?').run(body.decision==='approve'?'approved':'rejected',body.keyPolicy,id);
      this.audit(actor.sub,'enrollment-'+body.decision,id,{orgId:row.org,workspaceId:row.workspace,keyPolicy:body.keyPolicy});return this.dto(this.row(id));
    });
  }
  activation(actor,id){
    const row=this.row(id);fail(this.member(actor,row.org,row.workspace,'device-admin'),403,'Device administrator membership required');
    fail(row.state==='approved',409,'EXMO operator approval required');
    const activation=this.currentActivation(row);this.validateActivation(row,activation);
    fail(this.db.prepare('SELECT status FROM licenses WHERE id=?').get(activation.binding.licenseId).status==='active',403,'License is not active');
    this.audit(actor.sub,'activation-retrieved',id,{orgId:row.org});return {orgId:row.org,activation};
  }
}

async function verifier(config,allowLoopback=false){
  P.fields(config,['issuer','audience','clientId','jwksUrl']);A.url(config.issuer,allowLoopback);A.url(config.audience,allowLoopback);A.url(config.jwksUrl,allowLoopback);A.text(config.clientId);
  const jose=await import('jose'),keys=jose.createRemoteJWKSet(new URL(config.jwksUrl),{timeoutDuration:5000});
  return async token=>{
    const {payload}=await jose.jwtVerify(token,keys,{issuer:config.issuer,audience:config.audience,algorithms:['RS256','ES256','EdDSA'],requiredClaims:['sub','iat','exp'],clockTolerance:5});
    A.text(payload.sub,512);
    fail((payload.azp??payload.client_id)===config.clientId && typeof payload.scope==='string' && payload.scope.split(' ').includes('exmo.account'),401,'Account token audience or scope rejected');
    return payload;
  };
}
function createServer(accounts,verify){
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');res.setHeader('X-Content-Type-Options','nosniff');
    try{
      fail(req.socket.remoteAddress==='127.0.0.1' && !req.headers.origin && !req.headers['sec-fetch-site'],403,'Desktop account API only');
      fail(['GET','POST'].includes(req.method) && /^Bearer [A-Za-z0-9._~-]{1,32768}$/.test(req.headers.authorization??''),401,'Account sign-in required');
      let actor;try{actor=await verify(req.headers.authorization.slice(7));}catch{throw Object.assign(Error('Account token rejected'),{status:401});}
      let body;
      if(req.method==='POST'){
        fail(req.headers['content-type']==='application/json' && !req.headers['transfer-encoding'],400,'JSON request required');
        const size=Number(req.headers['content-length']);fail(Number.isInteger(size) && size>0 && size<=256*1024,413,'Account request too large');
        const chunks=[];let bytes=0;for await(const part of req){bytes+=part.length;fail(bytes<=size,413,'Account request too large');chunks.push(part);}
        fail(bytes===size,400,'Incomplete account request');body=JSON.parse(Buffer.concat(chunks).toString());
      }
      const match=/^\/v1\/enrollments\/([A-Za-z0-9_-]{1,80})\/(decision|activation|solution)$/.exec(req.url);
      let result;
      if(req.method==='GET' && req.url==='/v1/me')result=accounts.me(actor);
      else if(req.method==='GET' && req.url==='/v1/enrollments')result=accounts.list(actor);
      else if(req.method==='POST' && req.url==='/v1/enrollments/challenge')result=accounts.challenge(actor,body);
      else if(req.method==='POST' && req.url==='/v1/enrollments')result=accounts.enroll(actor,body);
      else if(match && req.method==='POST' && match[2]==='decision')result=accounts.decide(actor,match[1],body);
      else if(match && req.method==='GET' && match[2]==='activation')result=accounts.activation(actor,match[1]);
      else if(match && req.method==='POST' && match[2]==='solution')result=accounts.solution(actor,match[1],body);
      else throw Object.assign(Error('Unknown account endpoint'),{status:404});
      res.end(JSON.stringify(result));
    }catch(error){res.statusCode=error.status??400;res.end(JSON.stringify({error:error.status?error.message:'Account request rejected; verify the enrollment and server configuration'}));}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;server.setTimeout(10000,s=>s.destroy());return server;
}
async function main([command,directory,...args]){
  P.check(['operator','member','export-request','prepare','enable-engines','serve'].includes(command),'account-server.cjs operator DIR SUBJECT on|off | member DIR SUBJECT ORG WORKSPACE NAME ROLES | export-request DIR ID OUTPUT | prepare DIR ID ACTIVATION | enable-engines DIR ID ct,mri,ap,lat | serve DIR OIDC_CONFIG PORT');
  const authority=new Authority(directory),accounts=new Accounts(authority);
  try{
    if(command==='operator'){P.check(args.length===2 && ['on','off'].includes(args[1]));accounts.operator(args[0],args[1]==='on');}
    else if(command==='member'){P.check(args.length===5);accounts.membership(...args.slice(0,4),args[4]==='none'?[]:args[4].split(','));}
    else if(command==='export-request'){P.check(args.length===2);fs.writeFileSync(args[1],accounts.row(args[0]).request,{flag:'wx',mode:0o600});}
    else if(command==='prepare'){P.check(args.length===2);accounts.prepare(args[0],JSON.parse(read(args[1],256*1024)));}
    else if(command==='enable-engines'){P.check(args.length===2);accounts.enableEngines(args[0],args[1].split(','));}
    else {
      P.check(args.length===2);const port=Number(args[1]);P.check(Number.isInteger(port) && port>=1024 && port<=65535);
      const config=JSON.parse(read(args[0]));
      const verify=await verifier(config);accounts.pinIssuer(config.issuer);
      const server=createServer(accounts,verify);
      server.listen(port,'127.0.0.1',()=>console.log('Account API listening on loopback; use an authenticated HTTPS deployment boundary.'));
      server.on('error',()=>{authority.close();process.exitCode=1;});
      for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>authority.close()));return;
    }
  }catch(error){authority.close();throw error;}
  authority.close();
}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={Accounts,verifier,createServer,main};
