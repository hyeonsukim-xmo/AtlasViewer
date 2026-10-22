// Loopback-only licensing PoC. No Internet listener or remote administration endpoint.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {DatabaseSync} = require('node:sqlite');
const P = require('../../desktop/security/license-protocol.cjs');
const V3 = require('../../desktop/security/license-v3.cjs');

class Authority {
  constructor(directory, clock = ()=>Math.floor(Date.now()/1000)) {
    this.directory=path.resolve(directory);
    this.clock = clock;
    const settings=JSON.parse(fs.readFileSync(path.join(directory,'authority.json'),'utf8'));
    P.fields(settings,['profile']); P.check(['internal','customer'].includes(settings.profile));
    this.profile=settings.profile;
    this.key = crypto.createPrivateKey(fs.readFileSync(path.join(directory,'issuer-private.pem')));
    P.check(this.key.asymmetricKeyType === 'ed25519');
    this.publicKey = crypto.createPublicKey(this.key);
    this.db = new DatabaseSync(path.join(directory,'authority.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS authority (fingerprint TEXT NOT NULL, profile TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS licenses (
        id TEXT PRIMARY KEY, installation TEXT NOT NULL UNIQUE, dongle TEXT NOT NULL UNIQUE,
        config TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (at INTEGER NOT NULL, license TEXT NOT NULL, event TEXT NOT NULL, revision INTEGER NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS models (digest TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_grants (license TEXT NOT NULL, engine TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(license,engine));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS solution_assignments (license TEXT PRIMARY KEY, document TEXT NOT NULL, ready_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lease_expiries (license TEXT PRIMARY KEY, expires INTEGER NOT NULL);`);
    try {
      this.transaction(()=>{
        const row = this.db.prepare('SELECT fingerprint,profile FROM authority').get();
        if (row) P.check(row.fingerprint === P.fingerprint(this.publicKey) && row.profile===this.profile,'Issuer key or profile does not match database');
        else this.db.prepare('INSERT INTO authority VALUES (?,?)').run(P.fingerprint(this.publicKey),this.profile);
      });
    } catch(error) {this.db.close();throw error;}
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  approve(config) {
    P.fields(config,['binding','installationPublicKey',...(this.profile==='customer'?['donglePublicKey']:[]),'engines','contractEnd','graceSeconds','renewSeconds']);
    P.binding(config.binding);
    P.check(config.binding.profile===this.profile,'Authority cannot approve another profile');
    P.check(P.fingerprint(P.p256(config.installationPublicKey)) === config.binding.installationKey);
    if(this.profile==='customer')P.check(P.fingerprint(P.p256(config.donglePublicKey)) === config.binding.dongleKey);
    P.check(Array.isArray(config.engines) && config.engines.length > 0 && config.engines.length <= 4 &&
      config.engines.every(x=>P.ENGINES.includes(x)) && new Set(config.engines).size === config.engines.length);
    P.integer(config.graceSeconds); P.integer(config.renewSeconds);
    P.check(config.graceSeconds > 0 && config.graceSeconds <= 7*86400 && config.renewSeconds > 0 && config.renewSeconds <= config.graceSeconds);
    P.check(this.profile==='internal' || config.contractEnd!==null,'Perpetual approval is internal-only');
    if (config.contractEnd !== null) {P.integer(config.contractEnd); P.check(config.contractEnd > this.clock());}
    this.transaction(()=>{
      this.db.prepare('INSERT INTO licenses VALUES (?,?,?,?,?,1,0)').run(config.binding.licenseId,
        config.binding.installationId,config.binding.dongleKey ?? config.binding.installationKey,JSON.stringify(config),'active');
      this.db.prepare('INSERT INTO audit VALUES (?,?,?,1)').run(this.clock(),config.binding.licenseId,'approved');
    });
  }
  status(licenseId, status) {
    P.id(licenseId); P.check(['active','revoked','suspended'].includes(status));
    return this.transaction(()=>{
      const row = this.db.prepare('UPDATE licenses SET status=?, revision=revision+1 WHERE id=? RETURNING revision').get(status,licenseId);
      P.check(row,'Unknown license');
      this.db.prepare('INSERT INTO audit VALUES (?,?,?,?)').run(this.clock(),licenseId,status,row.revision);
      return row.revision;
    });
  }
  extend(licenseId, contractEnd) {
    P.id(licenseId);P.integer(contractEnd);
    P.check(contractEnd>this.clock(),'A future approval expiry is required');
    return this.transaction(()=>{
      const row=this.db.prepare('SELECT config,revision FROM licenses WHERE id=?').get(licenseId);P.check(row,'Unknown license');
      const config=JSON.parse(row.config);P.check(config.contractEnd!==null && contractEnd>config.contractEnd,'New expiry must extend the existing approval');
      config.contractEnd=contractEnd;
      this.db.prepare('UPDATE licenses SET config=?,revision=revision+1 WHERE id=?').run(JSON.stringify(config),licenseId);
      this.db.prepare('INSERT INTO audit VALUES (?,?,?,?)').run(this.clock(),licenseId,'extended',row.revision+1);
      return row.revision+1;
    });
  }
  modelStatus(digest,status) {
    P.digest(digest);P.check(['active','revoked'].includes(status));
    return this.transaction(()=>{
      P.check(this.db.prepare('UPDATE models SET status=? WHERE digest=? RETURNING digest').get(status,digest),'Unknown model');
      this.db.prepare('UPDATE licenses SET revision=revision+1 WHERE id IN (SELECT license FROM model_grants WHERE digest=?)').run(digest);
      if(status==='revoked')for(const row of this.db.prepare('SELECT * FROM solution_assignments').all()){
        const doc=JSON.parse(row.document);let changed=false;
        for(const e of doc.entitlements)if(e.executions.some(x=>x.modelDigest===digest)){
          e.executions=e.executions.filter(x=>x.modelDigest!==digest);e.revision++;changed=true;
        }
        if(changed){this.db.prepare('UPDATE solution_assignments SET document=? WHERE license=?').run(JSON.stringify(doc),row.license);
          this.db.prepare('UPDATE licenses SET revision=revision+1 WHERE id=?').run(row.license);}
      }
      this.db.prepare('INSERT INTO audit VALUES (?,?,?,?)').run(this.clock(),'models',status+':'+digest,0);
    });
  }
  solutions(licenseId,document,{dryRun=false,inTransaction=false}={}) {
    P.id(licenseId);P.fields(document,['orgId','entitlements']);P.id(document.orgId);V3.entitlements(document.entitlements);
    const action=()=>{
      const row=this.db.prepare('SELECT * FROM licenses WHERE id=?').get(licenseId);P.check(row,'Unknown license');
      const old=this.db.prepare('SELECT * FROM solution_assignments WHERE license=?').get(licenseId);
      // Reject unissuable assignments before replacing a working lease policy, including in dry-run.
      const max=Number.MAX_SAFE_INTEGER;
      V3.signToken({iss:V3.ISSUER,aud:V3.AUDIENCE,kind:'lease',schema:'exmo-device-lease-v3',
        ...document,binding:JSON.parse(row.config).binding,nonce:'A'.repeat(43),iat:max,exp:max,
        renewAfter:max,revision:max,sequence:max,decision:'allow'},this.key);
      if(old){const prior=JSON.parse(old.document);V3.transition({...prior,revision:row.revision},{...document,revision:row.revision+1});}
      // Existing v2 offline leases must drain before per-product revocation becomes authoritative.
      const readyAt=old?.ready_at??Math.max(this.clock(),this.db.prepare('SELECT expires FROM lease_expiries WHERE license=?').get(licenseId)?.expires ?? (row.sequence?this.clock()+JSON.parse(row.config).graceSeconds:0));
      const report={licenseId,readyAt,revision:row.revision+1,solutionIds:document.entitlements.map(e=>e.solutionId),dryRun};
      for(const e of document.entitlements)for(const x of e.executions)if(x.modelDigest!==null)
        P.check(this.db.prepare("SELECT 1 FROM model_grants g JOIN models m ON m.digest=g.digest WHERE g.license=? AND g.engine=? AND g.digest=? AND m.status='active'").get(licenseId,x.engine,x.modelDigest),'Execution has no active model grant');
      if(dryRun)return report;
      this.db.prepare('INSERT INTO solution_assignments VALUES (?,?,?) ON CONFLICT(license) DO UPDATE SET document=excluded.document').run(licenseId,JSON.stringify(document),readyAt);
      this.db.prepare('UPDATE licenses SET revision=revision+1 WHERE id=?').run(licenseId);
      this.db.prepare('INSERT INTO audit VALUES (?,?,?,?)').run(this.clock(),licenseId,'solutions-v3',report.revision);
      return report;
    };
    return inTransaction?action():this.transaction(action);
  }
  challenge(request,version=2) {
    P.fields(request,['binding','nonce']); P.binding(request.binding); P.nonce(request.nonce);
    P.check(request.binding.profile===this.profile,'Wrong authority profile');
    return this.transaction(()=>{
      const row = this.db.prepare('SELECT config FROM licenses WHERE id=?').get(request.binding.licenseId);
      P.check(row,'Unapproved installation');
      P.sameBinding(request.binding,JSON.parse(row.config).binding);
      if(version===3){const assignment=this.db.prepare('SELECT ready_at FROM solution_assignments WHERE license=?').get(request.binding.licenseId);
        P.check(assignment && this.clock()>=assignment.ready_at,'Existing v2 leases must expire before v3 activation');}
      const now = this.clock();
      this.db.prepare('DELETE FROM challenges WHERE expires<=?').run(now);
      P.check(this.db.prepare('SELECT count(*) AS count FROM challenges').get().count < 1024,'Challenge capacity exceeded');
      const protocol=version===3?V3:P;
      const value = {iss:protocol.ISSUER,aud:protocol.AUDIENCE,kind:'challenge',...(version===3?{schema:'exmo-device-challenge-v3'}:{}),binding:request.binding,nonce:request.nonce,
        iat:now,exp:now+60,challengeId:crypto.randomBytes(32).toString('base64url')};
      const token = protocol.signToken(value,this.key);
      this.db.prepare('INSERT INTO challenges VALUES (?,?,?)').run(value.challengeId,token,value.exp);
      return {token};
    });
  }
  lease(request,version=2) {
    P.fields(request,['challengeId','installationSignature',...(this.profile==='customer'?['dongleSignature']:[])]); P.nonce(request.challengeId);
    const result = this.transaction(()=>{
      const challenge = this.db.prepare('DELETE FROM challenges WHERE id=? RETURNING token,expires').get(request.challengeId);
      if (!challenge || challenge.expires <= this.clock()) return {error:'Challenge expired or already used'};
      const value = P.json(P.decode(challenge.token.split('.')[1]).toString('utf8'));
      const row = this.db.prepare('SELECT * FROM licenses WHERE id=?').get(value.binding.licenseId);
      const config = JSON.parse(row.config);
      try {
        P.check(value.iss===(version===3?V3.ISSUER:P.ISSUER),'Challenge protocol mismatch');
        P.check(this.clock() >= value.iat,'Server clock moved backwards');
        P.sameBinding(value.binding,config.binding);
        P.verifyProof(P.p256(config.installationPublicKey),'installation',challenge.token,request.installationSignature);
        if(this.profile==='customer')P.verifyProof(P.p256(config.donglePublicKey),'dongle',challenge.token,request.dongleSignature);
      } catch { return {error:'Device proof rejected'}; }
      const now = this.clock();
      const assignment=this.db.prepare('SELECT * FROM solution_assignments WHERE license=?').get(row.id);
      if(version===3 && !assignment)return {error:'No v3 assignment'};
      const decision = assignment && version===2 ? 'revoked' : version===3 && now<assignment.ready_at ? 'suspended' : row.status !== 'active' ? row.status : config.contractEnd !== null && now >= config.contractEnd ? 'expired' : 'allow';
      const exp = decision === 'allow' ? Math.min(now+config.graceSeconds,config.contractEnd ?? Number.MAX_SAFE_INTEGER) : now;
      let claims = {iss:P.ISSUER,aud:P.AUDIENCE,kind:'lease',binding:config.binding,nonce:value.nonce,iat:now,exp,
        renewAfter:Math.min(now+config.renewSeconds,exp),revision:row.revision,sequence:row.sequence+1,
        decision,engines:decision === 'allow' ? config.engines : [],modelDigests:decision==='allow'?
          this.db.prepare("SELECT g.digest FROM model_grants g JOIN models m ON g.digest=m.digest WHERE g.license=? AND m.status='active' ORDER BY g.engine").all(row.id).map(v=>v.digest):[]};
      if(version===3){const document=JSON.parse(assignment.document);
        const {engines,modelDigests,...base}=claims;
        claims={...base,iss:V3.ISSUER,aud:V3.AUDIENCE,schema:'exmo-device-lease-v3',orgId:document.orgId,entitlements:decision==='allow'?document.entitlements:[]};
        V3.validate(claims,'lease',config.binding);
      }
      const token = (version===3?V3:P).signToken(claims,this.key);
      if(version===2 && decision==='allow')this.db.prepare('INSERT INTO lease_expiries VALUES (?,?) ON CONFLICT(license) DO UPDATE SET expires=max(expires,excluded.expires)').run(row.id,exp);
      this.db.prepare('UPDATE licenses SET sequence=? WHERE id=?').run(claims.sequence,row.id);
      this.db.prepare('INSERT INTO audit VALUES (?,?,?,?)').run(now,row.id,decision,row.revision);
      return {token};
    });
    P.check(!result.error,result.error);
    return result;
  }
  close() { this.db.close(); }
}

function createServer(authority) {
  const server = http.createServer(async (req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Type','application/json');
    res.setHeader('Connection','close');
    try {
      P.check(req.socket.remoteAddress === '127.0.0.1');
      P.check(req.headers.host === `127.0.0.1:${server.address().port}` && !req.headers.origin && !req.headers['sec-fetch-site']);
      P.check(req.method === 'POST' && ['/v1/challenge','/v1/lease','/v3/challenges','/v3/leases'].includes(req.url));
      const version=req.url.startsWith('/v3/')?3:2,protocol=version===3?V3:P;
      P.check(req.headers['content-type'] === 'application/json' && !req.headers['transfer-encoding']);
      const size = Number(req.headers['content-length']); P.check(Number.isInteger(size) && size > 0 && size <= protocol.LIMIT);
      const chunks = []; let received = 0;
      for await (const chunk of req) {received+=chunk.length; P.check(received<=size); chunks.push(chunk);}
      P.check(received === size);
      const body = protocol.json(Buffer.concat(chunks).toString('utf8'));
      const reply = req.url.includes('challenge') ? authority.challenge(body,version) : authority.lease(body,version);
      res.end(JSON.stringify(reply));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({error:'Licensing request rejected; no authorization issued'}));
    }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  server.setTimeout(5000,socket=>socket.destroy());
  return server;
}

function main(argv) {
  const [command,directory,...args] = argv;
  P.check(directory && ['init','approve','status','serve'].includes(command),
    'Usage: node scripts/security/license-server.cjs init|approve|status|serve DIRECTORY [arguments]');
  if (command === 'init') {
    P.check(args.length === 1 && ['internal','customer'].includes(args[0]),'init requires internal or customer profile');
    fs.mkdirSync(directory,{recursive:false,mode:0o700});
    fs.writeFileSync(path.join(directory,'authority.json'),JSON.stringify({profile:args[0]}),{flag:'wx'});
    const pair = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(path.join(directory,'issuer-private.pem'),pair.privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});
    fs.writeFileSync(path.join(directory,'issuer-public.pem'),pair.publicKey.export({type:'spki',format:'pem'}),{flag:'wx'});
    const authority = new Authority(directory); authority.close();
    console.log('Initialized local PoC authority; private key must stay on the server.'); return;
  }
  const authority = new Authority(directory);
  if (command === 'serve') {
    const port = args.length ? Number(args[0]) : 43127;
    P.check(args.length <= 1 && Number.isInteger(port) && port >= 0 && port <= 65535);
    const server = createServer(authority);
    server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({status:'local_poc_only',port:server.address().port})));
    server.on('error',()=>{authority.close(); process.exitCode=1;});
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>server.close(()=>authority.close()));
  } else {
    try {
      if (command === 'approve') {
        P.check(args.length === 1 && fs.statSync(args[0]).size <= P.LIMIT);
        authority.approve(JSON.parse(fs.readFileSync(args[0],'utf8')));
      } else {P.check(args.length === 2); authority.status(args[0],args[1]);}
      console.log('Local PoC authority updated.');
    } finally {authority.close();}
  }
}
if (require.main === module) {
  try {main(process.argv.slice(2));} catch {console.error('Licensing command failed. Check arguments, existing files and approved public configuration.');process.exitCode=1;}
}
module.exports = {Authority,createServer,main};
