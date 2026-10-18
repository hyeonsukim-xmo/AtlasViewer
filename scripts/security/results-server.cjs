// Result service has read-only account access and no license issuer or private mask key.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const {DatabaseSync}=require('node:sqlite');
const P=require('../../desktop/security/license-protocol.cjs');
const S=require('../../desktop/publication-protocol.cjs');
const {atomicWrite,read}=require('../../desktop/security/storage.cjs');
const {verifier}=require('./account-server.cjs');
function fail(ok,status,code){if(!ok)throw Object.assign(Error(code),{status,code});}
function directory(root,id){P.id(id);const target=path.join(root,id);for(let p=target;fs.existsSync(p);p=path.dirname(p)){fail(!fs.lstatSync(p).isSymbolicLink(),400,'UNSAFE_STORAGE');if(p===path.dirname(p))break;}return target;}
// shortcut: Single-node storage and recent 200 results; add pagination/object storage before multi-node deployment.
class Results{
  constructor(root,accounts,config){
    this.root=path.resolve(root);this.accounts=accounts;this.config=config;
    P.fields(config,['maskPublicKey','meshPublicKey','receiptPublicKey','quotaBytes',...(config.oidc?['oidc']:[])]);
    for(const key of ['maskPublicKey','meshPublicKey'])require('../../desktop/publication-crypto.cjs').publicKey(config[key]);
    S.check(typeof config.receiptPublicKey==='string' && !config.receiptPublicKey.includes('PRIVATE') && crypto.createPublicKey(config.receiptPublicKey).asymmetricKeyType==='ed25519');P.integer(config.quotaBytes);S.check(config.quotaBytes>0);
    fs.mkdirSync(path.join(root,'objects'),{recursive:true});
    this.db=new DatabaseSync(path.join(root,'results.sqlite'));this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS origins(store TEXT PRIMARY KEY,org TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS origin_devices(store TEXT NOT NULL,installation TEXT NOT NULL,PRIMARY KEY(store,installation));
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,identity TEXT NOT NULL,org TEXT NOT NULL,workspace TEXT NOT NULL,subject TEXT NOT NULL,
        document TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,expires INTEGER NOT NULL,receipt TEXT);
      CREATE TABLE IF NOT EXISTS publications(identity TEXT PRIMARY KEY,id TEXT UNIQUE NOT NULL,org TEXT NOT NULL,workspace TEXT NOT NULL,
        digest TEXT NOT NULL,content TEXT NOT NULL,mask_attempt TEXT NOT NULL,mesh_attempt TEXT,revision INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,publisher TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS result_audit(at INTEGER NOT NULL,actor TEXT NOT NULL,event TEXT NOT NULL,target TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proof_nonces(nonce TEXT PRIMARY KEY,expires INTEGER NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS publication_contexts(result TEXT PRIMARY KEY REFERENCES publications(id),document TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS publication_overlays(result TEXT PRIMARY KEY REFERENCES publications(id),attempt TEXT NOT NULL)');
  }
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  audit(actor,event,target){this.db.prepare('INSERT INTO result_audit VALUES(?,?,?,?)').run(Math.floor(Date.now()/1000),actor.sub,event,target);}
  roles(actor,scope){const row=this.accounts.prepare('SELECT roles FROM account_members WHERE subject=? AND org=? AND workspace=?').get(actor.sub,scope.orgId,scope.workspaceId);return row?JSON.parse(row.roles):[];}
  access(actor,scope,role='analyst'){
    S.scope(scope);fail(actor.sub===scope.subject,403,'PUBLICATION_ACCOUNT_MISMATCH');
    const roles=this.roles(actor,scope);fail(role==='read'?roles.some(r=>['analyst','reviewer','data-admin'].includes(r)):roles.includes(role),403,'PUBLICATION_PERMISSION');
    const device=this.accounts.prepare('SELECT * FROM account_enrollments WHERE installation=?').get(scope.installationId);
    fail(device?.state==='approved' && device.org===scope.orgId,403,'PUBLICATION_DEVICE');
    const license=this.accounts.prepare('SELECT * FROM licenses WHERE installation=?').get(scope.installationId);
    // Analysis contract expiry does not remove rights to an already saved result; security suspension does.
    fail(license?.status==='active',403,'PUBLICATION_DEVICE');return JSON.parse(device.request);
  }
  authenticate(actor,route,body,encoded){
    fail(typeof encoded==='string' && encoded.length<8192,403,'PUBLICATION_PROOF');
    const {claims,signature}=JSON.parse(Buffer.from(encoded,'base64url').toString());
    P.fields(claims,['orgId','workspaceId','subject','installationId','route','bodyDigest','nonce','at']);P.nonce(claims.nonce);P.integer(claims.at);
    fail(claims.route===route && claims.bodyDigest===S.digest(body) && Math.abs(Date.now()/1000-claims.at)<120,403,'PUBLICATION_PROOF');
    const scope=S.pick(claims,['orgId','workspaceId','subject','installationId']);
    const role=route.endsWith('/approve-origin')||route.endsWith('/delete')?'data-admin':['/list','/read','/mesh-part','/overlay-part'].some(p=>route.endsWith(p))?'read':'analyst';
    const request=this.access(actor,scope,role);
    fail(crypto.verify('sha256',S.proofMessage(claims),P.p256(request.installationPublicKey),P.decode(signature)),403,'PUBLICATION_PROOF');
    this.transaction(()=>{this.db.prepare('DELETE FROM proof_nonces WHERE expires<?').run(Date.now()/1000);fail(!this.db.prepare('SELECT 1 FROM proof_nonces WHERE nonce=?').get(claims.nonce),409,'PUBLICATION_REPLAY');this.db.prepare('INSERT INTO proof_nonces VALUES(?,?)').run(claims.nonce,claims.at+120);});
    return scope;
  }
  origin(actor,scope,store){
    this.access(actor,scope,'data-admin');P.id(store);
    return this.transaction(()=>{
      const old=this.db.prepare('SELECT org FROM origins WHERE store=?').get(store);fail(!old || old.org===scope.orgId,409,'PUBLICATION_ORIGIN_MISMATCH');
      this.db.prepare('INSERT OR IGNORE INTO origins VALUES(?,?)').run(store,scope.orgId);
      this.db.prepare('INSERT OR IGNORE INTO origin_devices VALUES(?,?)').run(store,scope.installationId);this.audit(actor,'origin-approved',store);return {approved:true};
    });
  }
  originAccess(scope,id){
    const row=this.db.prepare('SELECT 1 FROM origins o JOIN origin_devices d ON d.store=o.store WHERE o.store=? AND o.org=? AND d.installation=?').get(id.originStoreId,scope.orgId,scope.installationId);
    fail(row,403,'PUBLICATION_ORIGIN_APPROVAL_REQUIRED');
  }
  key(m){return S.digest([m.scope.orgId,m.content.identity]);}
  existing(m){
    const row=this.db.prepare('SELECT * FROM publications WHERE identity=?').get(this.key(m));
    if(row){fail(row.workspace===m.scope.workspaceId,409,'PUBLICATION_TARGET_MISMATCH');fail(!row.deleted,410,'PUBLICATION_DELETED');fail(row.digest===m.contentDigest,409,'PUBLICATION_CONTENT_CONFLICT');}
    return row;
  }
  info(){return {maskPublicKey:this.config.maskPublicKey,meshPublicKey:this.config.meshPublicKey,overlayPolicy:'exmo-no-identifiers-v1'};}
  attachment(row,kind){return kind==='overlay'?this.db.prepare('SELECT attempt FROM publication_overlays WHERE result=?').get(row.id)?.attempt:row.mesh_attempt;}
  review(m){if(m.artifact.kind==='overlay')fail(m.overlay.privacyReview.reviewedAt<=Date.now()/1000+300,400,'PUBLICATION_PRIVACY_REVIEW');}
  begin(actor,scope,m){
    S.manifest(m);this.review(m);fail(S.canonical(scope)===S.canonical(m.scope),403,'PUBLICATION_ACCOUNT_MISMATCH');this.originAccess(scope,m.content.identity);
    return this.transaction(()=>{
      const existing=this.existing(m),old=this.db.prepare('SELECT * FROM attempts WHERE id=?').get(m.attemptId);
      if(old){fail(old.digest===S.digest(m),409,'PUBLICATION_ATTEMPT_CONFLICT');return this.status(actor,scope,m.attemptId);}
      if(existing && m.artifact.kind==='mask')return this.dto(existing);
      if(m.artifact.kind!=='mask'){fail(existing,409,'PUBLICATION_CORE_REQUIRED');
        const prior=this.attachment(existing,m.artifact.kind);
        if(prior){const old=JSON.parse(this.db.prepare('SELECT document FROM attempts WHERE id=?').get(prior).document);if(old.artifact.sha256===m.artifact.sha256 && (m.artifact.kind!=='overlay'||S.digest(old.overlay)===S.digest(m.overlay)))return this.dto(existing);}
        fail(existing.revision===m.attachmentRevision,409,'PUBLICATION_ATTACHMENT_CONFLICT');}
      const used=this.db.prepare("SELECT document FROM attempts WHERE org=? AND state NOT IN ('cancelled','expired')").all(scope.orgId).reduce((n,r)=>n+JSON.parse(r.document).artifact.bytes,0);
      fail(used+m.artifact.bytes<=this.config.quotaBytes,413,'PUBLICATION_QUOTA');
      fs.mkdirSync(directory(path.join(this.root,'objects'),m.attemptId),{recursive:true});
      this.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(m.attemptId,this.key(m),scope.orgId,scope.workspaceId,actor.sub,S.canonical(m),S.digest(m),'uploading',Math.floor(Date.now()/1000)+86400);
      this.audit(actor,'upload-begun',m.attemptId);return this.status(actor,scope,m.attemptId);
    });
  }
  attempt(actor,scope,id){
    P.id(id);this.access(actor,scope);const row=this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id);
    fail(row && row.org===scope.orgId && row.workspace===scope.workspaceId && row.subject===actor.sub,404,'PUBLICATION_NOT_FOUND');
    fail(row.state!=='expired',410,'PUBLICATION_ATTEMPT_EXPIRED');
    const m=JSON.parse(row.document);fail(m.scope.installationId===scope.installationId,403,'PUBLICATION_DEVICE');this.originAccess(scope,m.content.identity);this.existing(m);
    return {row,m};
  }
  status(actor,scope,id){
    const {row,m}=this.attempt(actor,scope,id),existing=this.existing(m);
    if(existing && (m.artifact.kind==='mask' || this.attachment(existing,m.artifact.kind)===id))return this.dto(existing);
    fail(!['cancelled','expired'].includes(row.state) && row.expires>Date.now()/1000,410,'PUBLICATION_ATTEMPT_EXPIRED');
    const dir=directory(path.join(this.root,'objects'),id);
    const uploaded=m.artifact.parts.map((part,i)=>{try{const file=path.join(dir,i+'.part');return fs.statSync(file).size===part.bytes && S.hash(fs.readFileSync(file))===part.sha256;}catch{return false;}});
    return {state:row.state,attemptId:id,uploaded};
  }
  part(actor,scope,{attemptId,index,data}){
    const {row,m}=this.attempt(actor,scope,attemptId);fail(row.state==='uploading' && row.expires>Date.now()/1000,410,'PUBLICATION_ATTEMPT_EXPIRED');P.integer(index);
    const p=m.artifact.parts[index];fail(p && typeof data==='string' && data.length<=Math.ceil((S.CHUNK+28)/3)*4,400,'PUBLICATION_PART');
    const bytes=Buffer.from(data,'base64');fail(bytes.toString('base64')===data && bytes.length===p.bytes && S.hash(bytes)===p.sha256,400,'PUBLICATION_PART');
    atomicWrite(path.join(directory(path.join(this.root,'objects'),attemptId),index+'.part'),bytes);return {received:index};
  }
  complete(actor,scope,id){
    return this.transaction(()=>{
      const {row,m}=this.attempt(actor,scope,id),existing=this.existing(m);
      if(existing && (m.artifact.kind==='mask' || this.attachment(existing,m.artifact.kind)===id))return this.dto(existing);
      const status=this.status(actor,scope,id);fail(status.uploaded.every(Boolean),409,'PUBLICATION_INCOMPLETE');
      if(!row.receipt){this.db.prepare("UPDATE attempts SET state='verifying' WHERE id=?").run(id);return {state:'verifying',attemptId:id};}
      const receipt=JSON.parse(row.receipt),message=Buffer.from(receipt.message);
      fail(crypto.verify(null,message,this.config.receiptPublicKey,Buffer.from(receipt.signature,'base64url')),400,'PUBLICATION_RECEIPT');
      const verified=JSON.parse(receipt.message);fail(verified.attemptId===id && verified.manifestDigest===row.digest && verified.valid===true,422,'PUBLICATION_ARTIFACT_INVALID');
      this.access(actor,scope);this.originAccess(scope,m.content.identity);this.review(m);
      if(m.artifact.kind==='mask'){
        const resultId=crypto.randomUUID();
        this.db.prepare('INSERT INTO publications(identity,id,org,workspace,digest,content,mask_attempt,mesh_attempt,revision,deleted,publisher) VALUES(?,?,?,?,?,?,?,NULL,0,0,?)').run(this.key(m),resultId,scope.orgId,scope.workspaceId,m.contentDigest,S.canonical(m.content),id,actor.sub);
      }else{
        fail(existing && existing.revision===m.attachmentRevision,409,'PUBLICATION_ATTACHMENT_CONFLICT');
        if(m.artifact.kind==='overlay'){
          this.db.prepare('INSERT INTO publication_overlays VALUES(?,?) ON CONFLICT(result) DO UPDATE SET attempt=excluded.attempt').run(existing.id,id);
          this.db.prepare('UPDATE publications SET revision=revision+1 WHERE identity=?').run(this.key(m));
        }else this.db.prepare('UPDATE publications SET mesh_attempt=?,revision=revision+1 WHERE identity=?').run(id,this.key(m));
      }
      this.db.prepare("UPDATE attempts SET state='published' WHERE id=?").run(id);this.audit(actor,'publication-committed',id);return this.dto(this.existing(m));
    });
  }
  dto(row){return {state:'published',resultId:row.id,attachmentRevision:row.revision,meshState:row.mesh_attempt?'ready':JSON.parse(row.content).analysis==='xray'?'empty':'pending',overlayState:this.attachment(row,'overlay')?'ready':'empty'};}
  cancel(actor,scope,id){
    const {row,m}=this.attempt(actor,scope,id);const published=this.existing(m);
    if(published && (published.mask_attempt===id || this.attachment(published,m.artifact.kind)===id))return this.dto(published);
    this.db.prepare("UPDATE attempts SET state='cancelled',receipt=NULL WHERE id=?").run(id);this.audit(actor,'upload-cancelled',id);return {state:'cancelled'};
  }
  describe(row){const v=JSON.parse(row.content),context=this.db.prepare('SELECT document FROM publication_contexts WHERE result=?').get(row.id)?.document;return {...this.dto(row),solutionId:v.solutionId,variant:v.variant,analysis:v.analysis,route:v.route,unit:v.unit,context:context?JSON.parse(context):null};}
  list(actor,scope){this.access(actor,scope,'read');return this.db.prepare('SELECT * FROM publications WHERE org=? AND workspace=? AND deleted=0 ORDER BY rowid DESC LIMIT 200').all(scope.orgId,scope.workspaceId).map(r=>this.describe(r));}
  result(actor,scope,id){P.id(id);this.access(actor,scope,'read');const row=this.db.prepare('SELECT * FROM publications WHERE id=? AND org=? AND workspace=? AND deleted=0').get(id,scope.orgId,scope.workspaceId);fail(row,404,'PUBLICATION_NOT_FOUND');return row;}
  read(actor,scope,id){const row=this.result(actor,scope,id),v=JSON.parse(row.content);delete v.mask;delete v.identity;this.audit(actor,'result-read',id);
    const artifact=row.mesh_attempt?JSON.parse(this.db.prepare('SELECT document FROM attempts WHERE id=?').get(row.mesh_attempt).document).artifact:null;
    const overlayId=this.attachment(row,'overlay'),image=overlayId?JSON.parse(this.db.prepare('SELECT document FROM attempts WHERE id=?').get(overlayId).document):null;
    return {...this.describe(row),analysis:v,mesh:artifact?S.pick(artifact,['sha256','bytes']):null,overlay:image?{...S.pick(image.artifact,['sha256','bytes']),...image.overlay}:null};}
  context(actor,scope,id,value){
    S.context(value);this.access(actor,scope);return this.transaction(()=>{
      const row=this.result(actor,scope,id),v=JSON.parse(row.content);this.originAccess(scope,v.identity);
      const old=this.db.prepare('SELECT document FROM publication_contexts WHERE result=?').get(id)?.document;
      fail(!old || old===S.canonical(value),409,'PUBLICATION_CONTEXT_CONFLICT');
      this.db.prepare('INSERT OR IGNORE INTO publication_contexts VALUES(?,?)').run(id,S.canonical(value));this.audit(actor,'context-linked',id);return {linked:true};
    });
  }
  meshPart(actor,scope,body){return this.displayPart(actor,scope,body,'mesh');}
  displayPart(actor,scope,{resultId,revision,sha256,index},kind){
    fail(['mesh','overlay'].includes(kind),400,'PUBLICATION_PART');
    P.integer(revision);P.digest(sha256);P.integer(index);const row=this.result(actor,scope,resultId);
    const attempt=this.attachment(row,kind);fail(attempt && row.revision===revision,409,'PUBLICATION_ATTACHMENT_CONFLICT');
    const m=JSON.parse(this.db.prepare('SELECT document FROM attempts WHERE id=?').get(attempt).document);
    fail(m.artifact.kind===kind && m.artifact.sha256===sha256 && index<Math.ceil(m.artifact.bytes/S.CHUNK),400,'PUBLICATION_PART');
    // Only the verifier writes this validated display copy. No native Mask or decryption key is served.
    const dir=directory(path.join(this.root,'objects'),attempt),file=path.join(dir,kind==='mesh'?'display.glb':'display.png');
    fail(fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink(),503,'PUBLICATION_MESH_UNAVAILABLE');
    const fd=fs.openSync(file,'r');try{
      fail(fs.fstatSync(fd).size===m.artifact.bytes,503,'PUBLICATION_MESH_UNAVAILABLE');
      const bytes=Buffer.alloc(Math.min(S.CHUNK,m.artifact.bytes-index*S.CHUNK));
      fail(fs.readSync(fd,bytes,0,bytes.length,index*S.CHUNK)===bytes.length,503,'PUBLICATION_MESH_UNAVAILABLE');
      if(index===0)this.audit(actor,kind+'-read',resultId);return {data:bytes.toString('base64')};
    }finally{fs.closeSync(fd);}
  }
  delete(actor,scope,id,revision){
    this.access(actor,scope,'data-admin');P.integer(revision);
    return this.transaction(()=>{const row=this.result(actor,scope,id);fail(row.revision===revision,409,'PUBLICATION_ATTACHMENT_CONFLICT');
      this.db.prepare('DELETE FROM publication_contexts WHERE result=?').run(id);
      this.db.prepare('DELETE FROM publication_overlays WHERE result=?').run(id);
      this.db.prepare("UPDATE publications SET deleted=1,content='{}',revision=revision+1 WHERE id=?").run(id);this.audit(actor,'result-deleted',id);return {deleted:true};});
  }
  sweep(){
    this.db.prepare('DELETE FROM publication_contexts WHERE result IN (SELECT id FROM publications WHERE deleted=1)').run();
    const rows=this.db.prepare('SELECT * FROM attempts').all();
    for(const row of rows){const ref=this.db.prepare('SELECT id,deleted,mask_attempt,mesh_attempt FROM publications WHERE identity=?').get(row.identity);
      if(ref && !ref.deleted && [ref.mask_attempt,ref.mesh_attempt,this.attachment(ref,'overlay')].includes(row.id))continue;
      if(ref?.deleted || row.expires<Date.now()/1000 || row.state==='cancelled'){
        const dir=directory(path.join(this.root,'objects'),row.id);S.check(path.dirname(dir)===path.join(this.root,'objects'));
        fs.rmSync(dir,{recursive:true,force:true});this.db.prepare("UPDATE attempts SET state='expired',receipt=NULL,document='{}' WHERE id=?").run(row.id);
      }
    }
  }
  close(){this.db.close();}
}
function createServer(service,verify){
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');res.setHeader('X-Content-Type-Options','nosniff');
    try{
      fail(req.socket.remoteAddress==='127.0.0.1' && !req.headers.origin && !req.headers['sec-fetch-site'],403,'DESKTOP_API_ONLY');
      fail(req.method==='POST' && /^Bearer [A-Za-z0-9._~-]{1,32768}$/.test(req.headers.authorization??''),401,'SIGN_IN_REQUIRED');
      let actor;try{actor=await verify(req.headers.authorization.slice(7));}catch{throw Object.assign(Error('SIGN_IN_REQUIRED'),{status:401});}
      const size=Number(req.headers['content-length']);fail(req.headers['content-type']==='application/json' && !req.headers['transfer-encoding'] && Number.isInteger(size) && size>0 && size<=2*1024*1024,413,'PUBLICATION_REQUEST_SIZE');
      const chunks=[];let bytes=0;for await(const part of req){bytes+=part.length;fail(bytes<=size,413,'PUBLICATION_REQUEST_SIZE');chunks.push(part);}fail(bytes===size,400,'PUBLICATION_INCOMPLETE');
      const body=JSON.parse(Buffer.concat(chunks).toString()),scope=service.authenticate(actor,req.url,body,req.headers['x-exmo-publication-proof']);
      let value;
      switch(req.url){
        case '/v1/publications/info':P.fields(body,[]);value=service.info();break;
        case '/v1/publications/approve-origin':P.fields(body,['originStoreId']);value=service.origin(actor,scope,body.originStoreId);break;
        case '/v1/publications/begin':value=service.begin(actor,scope,body);break;
        case '/v1/publications/status':P.fields(body,['attemptId']);value=service.status(actor,scope,body.attemptId);break;
        case '/v1/publications/part':P.fields(body,['attemptId','index','data']);value=service.part(actor,scope,body);break;
        case '/v1/publications/complete':P.fields(body,['attemptId']);value=service.complete(actor,scope,body.attemptId);break;
        case '/v1/publications/cancel':P.fields(body,['attemptId']);value=service.cancel(actor,scope,body.attemptId);break;
        case '/v1/publications/list':P.fields(body,[]);value=service.list(actor,scope);break;
        case '/v1/publications/read':P.fields(body,['resultId']);value=service.read(actor,scope,body.resultId);break;
        case '/v1/publications/context':P.fields(body,['resultId','context']);value=service.context(actor,scope,body.resultId,body.context);break;
        case '/v1/publications/mesh-part':P.fields(body,['resultId','revision','sha256','index']);value=service.meshPart(actor,scope,body);break;
        case '/v1/publications/overlay-part':P.fields(body,['resultId','revision','sha256','index']);value=service.displayPart(actor,scope,body,'overlay');break;
        case '/v1/publications/delete':P.fields(body,['resultId','revision']);value=service.delete(actor,scope,body.resultId,body.revision);break;
        default:throw Object.assign(Error('NOT_FOUND'),{status:404});
      }
      res.end(JSON.stringify(value));
    }catch(e){res.statusCode=e.status??400;res.end(JSON.stringify({error:e.status?e.message:'PUBLICATION_INVALID'}));}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;server.setTimeout(30000,s=>s.destroy());return server;
}
async function main([command,root,accountDirectory,configFile,port]){
  S.check(command==='serve','results-server.cjs serve RESULT_DIR ACCOUNT_DIR CONFIG PORT');
  const config=JSON.parse(read(configFile)),db=new DatabaseSync(path.join(accountDirectory,'authority.sqlite'),{readOnly:true});
  S.check(db.prepare('SELECT issuer FROM account_issuer').get()?.issuer===config.oidc.issuer,'RESULT_ACCOUNT_ISSUER_MISMATCH');
  const service=new Results(root,db,config),verify=await verifier(config.oidc),server=createServer(service,verify);
  P.integer(Number(port));S.check(Number(port)>=1024 && Number(port)<=65535);
  service.sweep();const timer=setInterval(()=>{try{service.sweep();}catch{console.error('RESULT_STORAGE_CLEANUP_FAILED');}},60000);timer.unref();
  server.listen(Number(port),'127.0.0.1',()=>console.log('Result API ready on loopback.'));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>{clearInterval(timer);service.close();db.close();}));
}
if(require.main===module)main(process.argv.slice(2)).catch(()=>{console.error('RESULT_SERVICE_START_FAILED');process.exitCode=1;});
module.exports={Results,createServer,directory,main};
