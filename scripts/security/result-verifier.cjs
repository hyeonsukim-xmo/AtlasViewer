// Run as a separate OS identity: this worker alone can unwrap native mask keys.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const S=require('../../desktop/publication-protocol.cjs');
const {decryptParts}=require('../../desktop/publication-crypto.cjs');
const {atomicWrite}=require('../../desktop/security/storage.cjs');
function determinant(d){return d[0]*(d[4]*d[8]-d[5]*d[7])-d[1]*(d[3]*d[8]-d[5]*d[6])+d[2]*(d[3]*d[7]-d[4]*d[6]);}
function mesh(bytes,content){
  S.check(bytes.length>=20 && bytes.readUInt32LE(0)===0x46546c67 && bytes.readUInt32LE(4)===2 && bytes.readUInt32LE(8)===bytes.length);
  const n=bytes.readUInt32LE(12);S.check(n>0 && n<=8*1024*1024 && bytes.readUInt32LE(16)===0x4e4f534a);
  const json=JSON.parse(bytes.subarray(20,20+n).toString());S.check(json.asset?.version==='2.0');
  const names=new Set(['world',...content.parts.map(p=>p.id),...content.rows.map(p=>p.id)]);
  function walk(value){
    if(Array.isArray(value)){value.forEach(walk);return;}
    if(!value || typeof value!=='object')return;
    for(const [k,v] of Object.entries(value)){S.check(!['uri','extensions','extensionsUsed','extensionsRequired'].includes(k));if(k==='extras')S.check(v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).every(k=>k==='processed' && typeof v[k]==='boolean'));if(k==='name')S.check(names.has(v));walk(v);}
  }
  walk(json);S.check(!json.images && !json.textures && !json.animations && !json.skins);
  S.check(Array.isArray(json.nodes) && json.nodes.length<=2048 && json.nodes.filter(n=>n.mesh!==undefined).every(n=>names.has(n.name)));
  const offset=20+n;S.check(offset+8<=bytes.length && bytes.readUInt32LE(offset+4)===0x004e4942 && offset+8+bytes.readUInt32LE(offset)===bytes.length);
  S.check(json.buffers?.length===1 && json.buffers[0].byteLength<=bytes.length-offset-8 && bytes.length-offset-8-json.buffers[0].byteLength<4);
}
async function verifyArtifact(root,m,keys){
  S.manifest(m);const dir=path.join(root,'objects',m.attemptId);
  const stream=decryptParts(dir,m,m.artifact.kind==='mask'?keys.mask:keys.mesh);
  if(m.artifact.kind==='mask'){
    const counts=new Float64Array(65536);
    for await(const block of stream){S.check(block.length%2===0);for(let i=0;i<block.length;i+=2)counts[block.readUInt16LE(i)]++;}
    const labels=new Set([0,...m.content.rows.map(r=>r.label)]);for(let i=1;i<counts.length;i++)S.check(!counts[i] || labels.has(i));
    const g=m.content.geometry,det=Math.abs(determinant(g.direction));S.check(Math.abs(det-1)<1e-5);
    const unit=m.content.unit==='pixel'?1:m.content.unit==='cm²'?g.spacing[0]*g.spacing[1]/100:g.spacing.reduce((a,b)=>a*b,det)/1000;
    for(const row of m.content.rows){S.check(counts[row.label]===row.count);S.check(Math.abs(row.count*unit-row.value)<=Math.max(1e-5,Math.abs(row.value)*1e-5));}
  }else{
    S.check(m.artifact.bytes<=128*1024*1024);const blocks=[];
    for await(const block of stream)blocks.push(Buffer.from(block));
    const bytes=Buffer.concat(blocks);try{mesh(bytes,m.content);}finally{bytes.fill(0);blocks.forEach(b=>b.fill(0));}
  }
}
async function verifyPending(root,keys){
  const db=new DatabaseSync(path.join(root,'results.sqlite'));db.exec('PRAGMA busy_timeout=5000');let count=0;
  try{
    for(const row of db.prepare("SELECT id,document,digest FROM attempts WHERE state='verifying' AND receipt IS NULL LIMIT 10").all()){
      let valid=false;
      try{await verifyArtifact(root,JSON.parse(row.document),keys);valid=true;}catch{/* Do not log decrypted content or local paths. */}
      const message=S.canonical({attemptId:row.id,manifestDigest:row.digest,valid});
      const receipt=JSON.stringify({message,signature:crypto.sign(null,Buffer.from(message),keys.receipt).toString('base64url')});
      db.prepare("UPDATE attempts SET receipt=? WHERE id=? AND digest=? AND state='verifying' AND receipt IS NULL").run(receipt,row.id,row.digest);count++;
    }
  }finally{db.close();}return count;
}
function initialize(directory,publicFile){
  S.check(!fs.existsSync(directory) && !fs.existsSync(publicFile));fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const output={};
  for(const name of ['mask','mesh','receipt']){
    const pair=crypto.generateKeyPairSync(name==='receipt'?'ed25519':'rsa',name==='receipt'?{}:{modulusLength:3072});
    fs.writeFileSync(path.join(directory,name+'.pem'),pair.privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});
    output[name+'PublicKey']=pair.publicKey.export({type:'spki',format:'pem'});
  }
  atomicWrite(publicFile,JSON.stringify({...output,quotaBytes:10*1024**3},null,2));
}
async function main([command,root,keyDirectory]){
  if(command==='init')return initialize(root,keyDirectory);
  S.check(['once','watch'].includes(command),'result-verifier.cjs init PRIVATE_KEYS PUBLIC_CONFIG | once|watch RESULT_DIR PRIVATE_KEYS');
  const keys=Object.fromEntries(['mask','mesh','receipt'].map(k=>[k,crypto.createPrivateKey(fs.readFileSync(path.join(keyDirectory,k+'.pem')))]));
  do{await verifyPending(root,keys);if(command==='watch')await new Promise(r=>setTimeout(r,2000));}while(command==='watch');
}
if(require.main===module)main(process.argv.slice(2)).catch(()=>{console.error('RESULT_VERIFIER_FAILED');process.exitCode=1;});
module.exports={verifyPending,verifyArtifact,mesh,initialize};
