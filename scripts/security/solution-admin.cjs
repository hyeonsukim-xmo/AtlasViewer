// Authority-host only. Bindings are generated from the exact packaged worker and signed payload.
const fs=require('node:fs'),path=require('node:path');
const P=require('../../desktop/security/license-protocol.cjs'),M=require('../../desktop/security/model-package.cjs');
const E=require('../../desktop/security/execution.cjs'),V3=require('../../desktop/security/license-v3.cjs');
const {Authority}=require('./license-server.cjs');
function document(file){P.check(fs.statSync(file).size<=V3.LIMIT);return JSON.parse(fs.readFileSync(file,'utf8'));}
function configure(authority,command,args){
  if(command==='solutions' || command==='solutions-dry-run'){
    P.check(args.length===2);const value=document(args[1]);
    const report=authority.solutions(args[0],value,{dryRun:true});
    if(command==='solutions-dry-run')return report;
    const backup=path.join(authority.directory,'before-solutions-'+require('node:crypto').randomUUID()+'.sqlite');
    authority.db.prepare('VACUUM INTO ?').run(backup);
    return {...authority.solutions(args[0],value),backup};
  }
  P.check(['solution-status','solution-expiry'].includes(command) && args.length===3);P.id(args[0]);
  // Read/modify/write under the same transaction; another admin cannot overwrite a concurrent change.
  return authority.transaction(()=>{
    const row=authority.db.prepare('SELECT document FROM solution_assignments WHERE license=?').get(args[0]);P.check(row,'No v3 assignment');
    const doc=JSON.parse(row.document),e=doc.entitlements.find(e=>e.solutionId===args[1]);P.check(e,'Unknown solution');
    if(command==='solution-status'){P.check(['active','suspended','revoked'].includes(args[2]));e.state=args[2];}
    else {const expiry=args[2]==='perpetual'?null:require('./internal-admin.cjs').expiryTime(args[2]);
      P.check(expiry===null || expiry>authority.clock(),'Expiry must be in the future');e.validUntil=expiry;}
    e.revision++;
    // Keep the existing writer transaction through validation, revision update and audit.
    return authority.solutions(args[0],doc,{inTransaction:true});
  });
}
function main([command,directory,...args]){
  const authority=new Authority(directory);
  try{
    if(command==='executions'){
      P.check(args.length===3);const [engineRoot,scriptsRoot,output]=args;
      const bindings=[];
      for(const engine of M.ENGINES){
        const analysis=['ct','mri','xray-classifier'].includes(engine)?engine:'xray';
        const job={analysis,...(analysis==='xray'?{route:{ap:'AP',lat_lt:'LAT_LT',lat_rt:'LAT_RT'}[engine]}:{})};
        Object.assign(job,E.scope(job));
        const folder=path.join(engineRoot,'packages',engine==='ct'?'EXMO_CT':engine==='mri'?'EXMO_MRI':'EXMO_XRAY');
        const file=path.join(folder,['ct','mri'].includes(engine)?'model-package.json':`model-package-${engine}.json`);
        if(!fs.existsSync(file))continue;
        const token=document(file).token;P.check(M.manifest(token,authority.publicKey).engine===engine);
        bindings.push(E.binding(job,{engineRoot,scriptsRoot,issuer:authority.publicKey},engine==='xray-classifier'?'classify':'analyze',M.hash(Buffer.from(token))));
        if(['ct','mri'].includes(engine))for(const variant of engine==='mri'?['raw','pp500','strong']:['raw'])
          bindings.push(E.binding({...job,variant},{engineRoot,scriptsRoot,issuer:authority.publicKey},'result-mutation'));
      }
      P.check(bindings.length>0,'No signed model packages');fs.writeFileSync(output,JSON.stringify(bindings,null,2),{flag:'wx'});
      console.log('Exported exact execution bindings; review permitted routes before assigning them.');
    }else{
      console.log(JSON.stringify(configure(authority,command,args),null,2));
    }
  }finally{authority.close();}
}
if(require.main===module){try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={configure,main};
