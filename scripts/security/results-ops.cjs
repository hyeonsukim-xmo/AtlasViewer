// Run during a maintenance window with result/verifier/viewer writers stopped.
// The signed backup contains encrypted artifacts and approved display copies, never private keys.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const P=require('../../desktop/security/license-protocol.cjs'),M=require('../../desktop/security/model-package.cjs');
const S=require('../../desktop/publication-protocol.cjs');
const {hashFile,inventory}=require('../../desktop/security/payload.cjs');
const allowed=name=>['results.sqlite','public.json'].includes(name)||/^objects\/[A-Za-z0-9_-]{1,80}\/(\d+\.part|display\.(glb|png))$/.test(name);
function copy(source,destination){fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});fs.copyFileSync(source,destination,fs.constants.COPYFILE_EXCL);fs.chmodSync(destination,0o600);}
function newFolder(output,source){
  output=path.resolve(output);source=fs.realpathSync(source);
  const target=path.join(fs.realpathSync(path.dirname(output)),path.basename(output));
  const normalized=value=>process.platform==='win32'?value.toLowerCase():value;
  const a=normalized(target),b=normalized(source);
  P.check(a!==b&&!a.startsWith(b+path.sep)&&!b.startsWith(a+path.sep)&&!fs.existsSync(output),'Use a new directory outside the source');
  fs.mkdirSync(output,{mode:0o700});return output;
}
function inspect(root){
  const db=new DatabaseSync(path.join(root,'results.sqlite'),{readOnly:true});
  try{
    P.check(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok','Result database is damaged');
    P.check(db.prepare('PRAGMA foreign_key_check').all().length===0,'Result references are damaged');
    const active=new Set(db.prepare('SELECT mask_attempt,mesh_attempt FROM publications WHERE deleted=0').all().flatMap(r=>[r.mask_attempt,r.mesh_attempt]).filter(Boolean));
    for(const r of db.prepare('SELECT attempt FROM publication_overlays o JOIN publications p ON p.id=o.result WHERE p.deleted=0').all())active.add(r.attempt);
    const names=new Set(['results.sqlite','public.json']);
    for(const row of db.prepare('SELECT id,document FROM attempts').all()){
      if(row.document==='{}')continue;
      const m=S.manifest(JSON.parse(row.document));P.check(m.attemptId===row.id);const prefix='objects/'+m.attemptId+'/';
      m.artifact.parts.forEach((part,i)=>{const name=prefix+i+'.part',file=path.join(root,name);
        if(!fs.existsSync(file)){P.check(!active.has(row.id),'Published encrypted artifact is missing');return;}
        const actual=hashFile(file);P.check(actual.sha256===part.sha256&&actual.size===part.bytes,'Artifact integrity failed');names.add(name);
      });
      if(m.artifact.kind!=='mask'){
        const name=prefix+(m.artifact.kind==='mesh'?'display.glb':'display.png'),file=path.join(root,name);
        if(fs.existsSync(file)){const actual=hashFile(file);P.check(actual.sha256===m.artifact.sha256&&actual.size===m.artifact.bytes,'Display integrity failed');names.add(name);}
        else P.check(!active.has(row.id),'Published display copy is missing; regenerate with verifier before backup');
      }
      active.delete(row.id);
    }
    P.check(!active.size,'Published artifact record is missing');return names;
  }finally{db.close();}
}
function backup(source,publicFile,receiptPrivate,output){
  output=newFolder(output,source);
  const config=JSON.parse(fs.readFileSync(publicFile)),key=crypto.createPrivateKey(fs.readFileSync(receiptPrivate));
  P.check(crypto.createPublicKey(key).export({type:'spki',format:'pem'})===config.receiptPublicKey,'Wrong backup signing key');
  const db=new DatabaseSync(path.join(source,'results.sqlite'),{readOnly:true});
  try{db.prepare('VACUUM INTO ?').run(path.join(output,'results.sqlite'));}finally{db.close();}
  copy(publicFile,path.join(output,'public.json'));
  // Copy only known artifact files. Incomplete uploads are resumable; deleted-result tombstones stay in SQLite.
  const objects=path.join(source,'objects');
  for(const name of inventory(objects)){
    const relative='objects/'+name;P.check(allowed(relative),'Unexpected result storage file');copy(path.join(objects,name),path.join(output,relative));
  }
  const required=inspect(output),actual=inventory(output);P.check(actual.every(allowed),'Unexpected backup file');
  const records=actual.map(name=>({path:name,...hashFile(path.join(output,name))}));
  P.check([...required].every(name=>actual.includes(name)));
  const index=JSON.stringify(records);fs.writeFileSync(path.join(output,'files.json'),index,{flag:'wx',mode:0o600});
  const token=M.sign({schema:'exmo-results-backup-v1',createdAt:new Date().toISOString(),indexSha256:M.hash(Buffer.from(index))},key);
  // Written last: a failed/incomplete copy is never a valid backup.
  fs.writeFileSync(path.join(output,'backup.json'),JSON.stringify({token}),{flag:'wx',mode:0o600});return verify(output,config.receiptPublicKey);
}
function verify(root,trustedPublicKey){
  P.check(fs.statSync(path.join(root,'backup.json')).size<=M.LIMIT);
  const document=JSON.parse(fs.readFileSync(path.join(root,'backup.json'),'utf8'));P.fields(document,['token']);
  const policy=M.verify(document.token,crypto.createPublicKey(trustedPublicKey),'exmo-results-backup-v1');P.fields(policy,['schema','createdAt','indexSha256']);
  const indexFile=path.join(root,'files.json');P.check(fs.statSync(indexFile).size<=64*1024**2);const index=fs.readFileSync(indexFile);
  P.check(M.hash(index)===policy.indexSha256,'Backup index signature mismatch');const records=JSON.parse(index);P.check(Array.isArray(records)&&records.length<=150000);
  const actual=inventory(root).filter(name=>name!=='backup.json'),names=new Set();
  for(const r of records){P.fields(r,['path','size','sha256']);P.check(allowed(r.path)&&!names.has(r.path));names.add(r.path);const h=hashFile(path.join(root,r.path));P.check(h.size===r.size&&h.sha256===r.sha256,'Backup integrity failed');}
  P.check(actual.length===names.size&&actual.every(name=>names.has(name)),'Unexpected backup files');
  const config=JSON.parse(fs.readFileSync(path.join(root,'public.json')));P.check(config.receiptPublicKey===trustedPublicKey,'Backup trust mismatch');
  inspect(root);return {createdAt:policy.createdAt,files:records};
}
function restore(source,trustedPublicKey,output){
  const verified=verify(source,trustedPublicKey);output=newFolder(output,source);
  for(const file of verified.files){
    const target=path.join(output,file.path);copy(path.join(source,file.path),target);
    const actual=hashFile(target);P.check(actual.sha256===file.sha256&&actual.size===file.size,'Backup changed during restoration');
  }
  inspect(output);return verified;
}
function main([command,...args]){
  if(command==='backup'){P.check(args.length===4);backup(...args);}
  else if(command==='verify'||command==='restore'){P.check(args.length===(command==='verify'?2:3));const [source,publicFile,output]=args,key=JSON.parse(fs.readFileSync(publicFile)).receiptPublicKey;if(command==='verify')verify(source,key);else restore(source,key,output);}
  else throw Error('results-ops.cjs backup RESULT_DIR PUBLIC_CONFIG RECEIPT_PRIVATE_PEM NEW_BACKUP | verify BACKUP TRUSTED_PUBLIC_CONFIG | restore BACKUP TRUSTED_PUBLIC_CONFIG NEW_RESULT_DIR');
  console.log('Result backup operation verified. Protect approved display copies and escrow verifier keys separately.');
}
if(require.main===module){try{main(process.argv.slice(2));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={backup,verify,restore,inspect};
