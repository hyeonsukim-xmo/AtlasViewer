// Operator-side conversion: preserve signed model/runtime bytes and freeze this app's adapters.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const P=require('../../desktop/security/license-protocol.cjs'),M=require('../../desktop/security/model-package.cjs');
const S=require('../../desktop/security/selection.cjs'),{verifyPayload,inventory,hashFile}=require('../../desktop/security/payload.cjs');
const {Authority}=require('./license-server.cjs');
function sealComponent(authority,root,id,version){
  const records=inventory(path.join(root,'content')).map(name=>({path:name,...hashFile(path.join(root,'content',name))}));
  const index=Buffer.from(JSON.stringify(records));fs.writeFileSync(path.join(root,'files.json'),index,{flag:'wx'});
  const token=M.sign({schema:'exmo-runtime-component-v1',id,version,profile:authority.profile,indexSha256:M.hash(index)},authority.key);
  fs.writeFileSync(path.join(root,'component.json'),JSON.stringify({token}),{flag:'wx'});
  return {digest:M.hash(Buffer.from(token)),bytes:records.reduce((n,r)=>n+r.size,0),files:records.length};
}
function sealCatalog(authority,root,version,models){
  const components=Object.fromEntries(S.IDS.map(id=>[id,sealComponent(authority,path.join(root,'components',id),id,version)]));
  const sets=Object.fromEntries(Object.entries(S.GRAPH).map(([selection,ids])=>[selection,M.sign({schema:'exmo-selected-payload-v1',version,profile:authority.profile,python:'3.12.8',selection,
    components:Object.fromEntries(ids.map(id=>[id,components[id].digest])),models:Object.fromEntries(S.ENGINES[selection].map(e=>[e,models[e]]))},authority.key)]));
  fs.writeFileSync(path.join(root,'catalog.json'),JSON.stringify({token:M.sign({schema:'exmo-install-catalog-v1',version,profile:authority.profile,sets},authority.key)}),{flag:'wx'});
  S.catalog(root,authority.publicKey,authority.profile);return components;
}
function create(authority,source,output,version,python){
  source=path.resolve(source);output=path.resolve(output);P.id(version);
  P.check(!fs.existsSync(output) && !output.startsWith(source+path.sep),'Use a new directory outside the source');
  const policy=verifyPayload(source,authority.publicKey);P.check(policy.profile===authority.profile,'Source profile mismatch');
  const root=path.resolve(__dirname,'../..'),site=path.join(source,'envs/ct/Lib/site-packages');
  const reader=JSON.parse(execFileSync(python,['-B',path.join(__dirname,'reader-dependencies.py'),site],{encoding:'utf8',windowsHide:true,maxBuffer:8*1024**2}));
  const records=JSON.parse(fs.readFileSync(path.join(source,'files.json'))),byName=new Map(records.map(r=>[r.path,r]));
  fs.mkdirSync(output,{recursive:true});for(const id of S.IDS)fs.mkdirSync(path.join(output,'components',id,'content'),{recursive:true});
  function copy(id,record,target=record.path){
    const dest=path.join(output,'components',id,'content',target);fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.copyFileSync(path.join(source,record.path),dest,fs.constants.COPYFILE_EXCL);
    const copied=hashFile(dest);P.check(copied.sha256===record.sha256 && copied.size===record.size,'Source changed while copying');
  }
  for(const record of records){
    const id=record.path.startsWith('envs/ct/')?'ct':S.IDS.find(id=>S.owned(id,record.path));
    P.check(id,'Unassigned runtime file: '+record.path);copy(id,record);
  }
  for(const relative of reader.files){const record=byName.get('envs/ct/Lib/site-packages/'+relative);P.check(record,'Reader dependency outside the signed source: '+relative);
    copy('common',record,'envs/reader/Lib/site-packages/'+relative);}
  const adapters=path.join(output,'components/common/content/adapters');fs.mkdirSync(adapters);
  for(const name of fs.readdirSync(path.join(root,'desktop')).filter(n=>n.endsWith('.py'))){
    let bytes=fs.readFileSync(path.join(root,'desktop',name));
    if(['model-runner.py','model_security.py'].includes(name)){
      const source=bytes.toString('utf8');P.check(source.split('PROTECTED_MRI = False').length===2);bytes=Buffer.from(source.replace('PROTECTED_MRI = False','PROTECTED_MRI = True'));
    }fs.writeFileSync(path.join(adapters,name),bytes,{flag:'wx'});
  }
  fs.writeFileSync(path.join(adapters,'model-policy.json'),JSON.stringify({profile:authority.profile,issuerPublicKey:authority.publicKey.export({type:'spki',format:'pem'}),licenseVersion:3}),{flag:'wx'});
  fs.copyFileSync(path.join(root,'dist-desktop/imaging-palette.json'),path.join(adapters,'imaging-palette.json'));
  fs.cpSync(path.join(__dirname,'trust'),path.join(adapters,'trust'),{recursive:true,errorOnExist:true,force:false});
  const components=sealCatalog(authority,output,version,policy.models);
  fs.writeFileSync(output+'.report.json',JSON.stringify({schema:'exmo-selection-build-v1',sourceVersion:policy.version,sourceIndexSha256:policy.indexSha256,components,reader:reader.packages,
    dependencies:S.GRAPH,numericalChanges:false},null,2),{flag:'wx'});
  return {version,components};
}
function main([directory,source,output,version,python]){
  P.check(python,'Usage: selection-payload.cjs AUTHORITY SIGNED_PAYLOAD OUTPUT VERSION BUILD_PYTHON');
  const authority=new Authority(directory);try{console.log(JSON.stringify(create(authority,source,output,version,python)));}finally{authority.close();}
}
if(require.main===module){try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={create,sealCatalog,sealComponent};
