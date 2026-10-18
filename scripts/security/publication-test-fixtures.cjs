const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const {execFile}=require('node:child_process');
const assert=require('node:assert/strict');
const F=require('./account-test-fixtures.cjs');
const S=require('../../desktop/publication-protocol.cjs');
const {Results,createServer}=require('./results-server.cjs');
const {verifyPending,initialize}=require('./result-verifier.cjs');
const {openAccount}=require('../../desktop/security/account.cjs');
const start=async server=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+server.address().port;};
const id=()=>crypto.randomUUID();
const identity=()=>({originStoreId:id(),originResultId:id(),analysisRevision:id()});
const geometry={size:[64,64,130],spacing:[1,1,2],origin:[0,0,0],direction:[1,0,0,0,1,0,0,0,1]};
function summary(){return {analysis:'mri',variant:'raw',route:null,unit:'cm³',name:'Synthetic',metadata:{caseName:'PRIVATE PATIENT',patientId:'SECRET_ID'},rows:[{label:1,id:'sartorius',name:'sartorius',group:'All',color:'#ff5599',count:64*64*130,value:64*64*130*2/1000,fat:null,hu:null,entropy:null,components:null,present:true}],parts:[],laterality:null,qc:{flags:[],entropy:null,ttaDisagreement:null,missing:[],unexpected:[],tta:'None'}};}
function source(){return {identity:{...identity(),solutionId:'exmo.thigh.mri',workflowId:'thigh-mri-water-v1'},summary:summary(),result:'fixture',variant:'raw',snapshotDigest:'a'.repeat(64)};}
async function pythonExport(root,options){
  const fixtureRoot=path.join(root,'fixture');fs.mkdirSync(fixtureRoot,{recursive:true});
  return new Promise((resolve,reject)=>{
    const child=execFile(path.resolve('work/modality-integration/envs/ct/Scripts/python.exe'),['-B','-X','utf8','scripts/security/test-publication-export.py'],{maxBuffer:1024*1024},(e,out,err)=>e?reject(Error(err)):resolve(JSON.parse(out)));
    child.stdin.end(JSON.stringify({fixtureRoot,snapshotDigest:'a'.repeat(64),result:'fixture',variant:'raw',...options}));
  });
}
function meshFile(root){
  const json=Buffer.from(JSON.stringify({asset:{version:'2.0'},nodes:[],buffers:[{byteLength:4}]}));
  const padded=Buffer.alloc(Math.ceil(json.length/4)*4,32);json.copy(padded);
  const bytes=Buffer.alloc(12+8+padded.length+8+4);bytes.writeUInt32LE(0x46546c67);bytes.writeUInt32LE(2,4);bytes.writeUInt32LE(bytes.length,8);bytes.writeUInt32LE(padded.length,12);bytes.writeUInt32LE(0x4e4f534a,16);padded.copy(bytes,20);bytes.writeUInt32LE(4,20+padded.length);bytes.writeUInt32LE(0x004e4942,24+padded.length);
  const file=path.join(root,'fixture.glb');fs.writeFileSync(file,bytes);return file;
}
async function fixture(t){
  const f=await F.setup(t),licensing=await F.device(t,f);
  f.accounts.membership('manager','hospital-a','research','Research',['device-admin','analyst','data-admin']);
  const keyDir=path.join(f.root,'private-result-keys'),publicFile=path.join(f.root,'public.json');initialize(keyDir,publicFile);
  const config=JSON.parse(fs.readFileSync(publicFile)),keys=Object.fromEntries(['mask','mesh','receipt'].map(k=>[k,crypto.createPrivateKey(fs.readFileSync(path.join(keyDir,k+'.pem')))]));
  const root=path.join(f.root,'results'),service=new Results(root,f.authority.db,config);F.cleanup(t,()=>service.close());
  const server=createServer(service,f.verify),resultUrl=await start(server);F.cleanup(t,()=>{server.closeAllConnections();server.close();});
  const proxy=http.createServer((req,res)=>{const url=new URL(req.url,req.url.startsWith('/v1/publications/')?resultUrl:f.apiUrl);const r=http.request(url,{method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});req.pipe(r);r.on('error',()=>{res.writeHead(502);res.end('{}');});});
  const apiUrl=await start(proxy);F.cleanup(t,()=>{proxy.closeAllConnections();proxy.close();});
  const account=openAccount({config:{...f.config,apiUrl},directory:path.join(f.root,'account'),safeStorage:F.safeStorage(),openExternal:f.idp.browser,licensing,allowLoopback:true});F.cleanup(t,()=>account.close());
  await account.login();await account.workspace('hospital-a','research');const enrollment=await account.enroll(),activation=F.prepare(f,await licensing.enrollment(),enrollment);
  f.accounts.decide({sub:'operator',amr:['mfa'],auth_time:Math.floor(Date.now()/1000)},enrollment.id, {revision:f.accounts.row(enrollment.id).revision,keyPolicy:'internal-exempt',decision:'approve'});
  await licensing.activate(activation);await account.workspace('hospital-a','research');
  const scope={orgId:'hospital-a',workspaceId:'research',subject:'manager',installationId:licensing.status().installationId};
  const rpc=(route,body={})=>account.publicationRequest('/v1/publications/'+route,body,scope);
  return {...f,licensing,service,keys,root,account,scope,rpc,config:config,source:source()};
}
async function attempt(f,source=f.source){
  const attemptId=id(),dir=path.join(f.root,'local-'+attemptId);fs.mkdirSync(dir);
  const exported=await pythonExport(f.root,{destination:dir,publicKey:f.config.maskPublicKey,scope:f.scope,identity:source.identity,attemptId});
  const content=S.fromSnapshot(source.summary,source.identity,exported.geometry,S.pick(exported.artifact,['sha256','bytes']));
  return {dir,manifest:S.manifest({schema:'exmo-upload-v1',attemptId,scope:f.scope,content,contentDigest:S.digest(content),artifact:exported.artifact,attachmentRevision:0})};
}
async function upload(f,a){await f.rpc('begin',a.manifest);for(let i=0;i<a.manifest.artifact.parts.length;i++)await f.rpc('part',{attemptId:a.manifest.attemptId,index:i,data:fs.readFileSync(path.join(a.dir,i+'.part')).toString('base64')});}
async function commit(f,a){await upload(f,a);assert.equal((await f.rpc('complete',{attemptId:a.manifest.attemptId})).state,'verifying');await verifyPending(f.root,f.keys);return f.rpc('complete',{attemptId:a.manifest.attemptId});}


module.exports={fixture,attempt,commit,upload,source,summary,geometry,pythonExport,meshFile};
