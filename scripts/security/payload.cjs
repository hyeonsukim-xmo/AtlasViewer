// Build host only. Offline payload contains pinned runtimes and encrypted models, not training data.
const fs=require('node:fs'),path=require('node:path');
const P=require('../../desktop/security/license-protocol.cjs'),M=require('../../desktop/security/model-package.cjs');
const {inventory,hashFile,verifyPayload}=require('../../desktop/security/payload.cjs');
const {Authority}=require('./license-server.cjs');
function copy(source,target,exclude=()=>false) {
  const stat=fs.lstatSync(source);P.check(!stat.isSymbolicLink());
  if(stat.isDirectory()){
    fs.mkdirSync(target,{recursive:true});
    for(const name of fs.readdirSync(source))if(name!=='__pycache__' && !exclude(name))copy(path.join(source,name),path.join(target,name));
  }else {P.check(stat.isFile());fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);}
}
function create(authority,engine,packages,security,output,version) {
  P.id(version);P.check(!fs.existsSync(output),'Use a new payload output');
  for(const source of [engine,packages,security])P.check(!path.resolve(output).startsWith(path.resolve(source)+path.sep));
  const config=fs.readFileSync(path.join(engine,'envs/ct/pyvenv.cfg'),'utf8');
  const base=config.match(/^home\s*=\s*(.+)$/m)?.[1].trim();P.check(base && /version_info\s*=\s*3\.12\.8/.test(config));
  for(const name of ['ct','mri','ap','lat','security']) {
    const source=name==='security'?security:path.join(engine,'envs',name);
    P.check(/^version(?:_info)?\s*=\s*3\.12\.8\s*$/m.test(fs.readFileSync(path.join(source,'pyvenv.cfg'),'utf8')),'Runtime Python versions differ');
  }
  fs.mkdirSync(output,{recursive:false});
  copy(base,path.join(output,'python'),name=>['Scripts','Lib'].includes(name));
  copy(path.join(base,'Lib'),path.join(output,'python/Lib'),name=>name==='site-packages');
  for(const name of ['ct','mri','ap','lat','security']) {
    const source=name==='security'?security:path.join(engine,'envs',name);
    copy(path.join(source,'Lib/site-packages'),path.join(output,'envs',name,'Lib/site-packages'));
  }
  copy(packages,path.join(output,'packages'));
  fs.writeFileSync(path.join(output,'verified-packages.json'),JSON.stringify({schema:'exmo-protected-delivery-v1'}),{flag:'wx'});
  return seal(authority,output,version);
}
function seal(authority,output,version) {
  P.id(version);
  const models={};
  for(const e of M.ENGINES){const family=e==='mri'?'EXMO_MRI':e==='ct'?'EXMO_CT':'EXMO_XRAY',file=e==='ct'||e==='mri'?'model-package.json':`model-package-${e}.json`;
    const value=JSON.parse(fs.readFileSync(path.join(output,'packages',family,file),'utf8'));P.check(M.manifest(value.token,authority.publicKey).engine===e);models[e]=M.hash(Buffer.from(value.token));}
  const files=inventory(output).map(name=>({path:name,...hashFile(path.join(output,name))}));
  const index=Buffer.from(JSON.stringify(files));fs.writeFileSync(path.join(output,'files.json'),index,{flag:'wx'});
  const token=M.sign({schema:'exmo-runtime-payload-v1',version,profile:authority.profile,python:'3.12.8',indexSha256:M.hash(index),models},authority.key);
  fs.writeFileSync(path.join(output,'payload.json'),JSON.stringify({token}),{flag:'wx'});
  verifyPayload(output,authority.publicKey);return {version,files:files.length,bytes:files.reduce((sum,f)=>sum+f.size,0)};
}
function main([command,directory,...args]) {
  const authority=new Authority(directory);
  try {
    if(command==='create'){P.check(args.length===5);console.log(JSON.stringify(create(authority,...args)));}
    else if(command==='verify'){P.check(args.length===1);console.log(JSON.stringify(verifyPayload(args[0],authority.publicKey)));}
    else throw Error('Usage: payload.cjs create AUTH ENGINE_SOURCE ENCRYPTED_PACKAGES SECURITY_ENV OUTPUT VERSION | verify AUTH PAYLOAD');
  }finally{authority.close();}
}
if(require.main===module){try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={copy,create,seal,main};
