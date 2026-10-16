// Authority-host CLI. No remote admin API, installer bypass or simulated-dongle switch.
const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const P=require('../../desktop/security/license-protocol.cjs');
const M=require('../../desktop/security/model-package.cjs');
const {read}=require('../../desktop/security/storage.cjs');
const {Authority}=require('./license-server.cjs');
function issuerCrypto(message) {
  const python=process.env.EXMO_ISSUER_PYTHON || path.resolve(__dirname,'../../work/security-poc/env/Scripts/python.exe');
  const output=spawnSync(python,['-B',path.join(__dirname,'issuer-crypto.py')],{input:JSON.stringify(message)+'\n',encoding:'utf8',timeout:15000,maxBuffer:32768,windowsHide:true});
  P.check(!output.error && output.status===0,'Hardware attestation or key wrapping failed');
  const result=JSON.parse(output.stdout);P.fields(result,['value']);return result.value;
}
function main([command,directory,...args]) {
  P.check(['approve','activation','build-config','model-status','extend','status'].includes(command));
  const authority=new Authority(directory);
  const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
  try {
    P.check(authority.profile==='customer','Customer authority required');
    if(command==='approve') {
      P.check(args.length===4);const [file,licenseId,expiry,engines]=args,request=JSON.parse(read(file));
      M.validateEnrollment(request);P.check(request.profile==='customer');
      const verified=issuerCrypto({operation:'verify',hardware:request.hardware}),keys=M.hardwareKeys(request.hardware);
      const contractEnd=expiry==='perpetual'?null:Date.parse(expiry)/1000;
      if(contractEnd!==null)P.check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(expiry) && new Date(contractEnd*1000).toISOString()===expiry.replace('Z','.000Z'));
      P.check(verified['9e']===P.fingerprint(keys['9e']) && verified['9d']===P.fingerprint(keys['9d']));
      authority.approve({binding:{profile:'customer',licenseId,installationId:request.installationId,installationKey:request.installationKey,
        dongleKey:verified['9e'],agreementKey:verified['9d']},installationPublicKey:request.installationPublicKey,
        donglePublicKey:keys['9e'].export({type:'spki',format:'pem'}),engines:engines.split(','),contractEnd,graceSeconds:7*86400,renewSeconds:300});
      write(path.join(directory,licenseId+'.hardware.json'),request.hardware);
    } else if(command==='activation') {
      P.check(args.length===2);P.id(args[0]);
      const row=authority.db.prepare('SELECT config FROM licenses WHERE id=?').get(args[0]);P.check(row);const config=JSON.parse(row.config);
      write(args[1],{binding:config.binding,installationPublicKey:config.installationPublicKey,hardware:JSON.parse(read(path.join(directory,args[0]+'.hardware.json')))});
    } else if(command==='extend') {
      P.check(args.length===2 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(args[1]));
      authority.extend(args[0],Date.parse(args[1])/1000);
    } else if(command==='status') {
      P.check(args.length===2);authority.status(...args);
    } else if(command==='model-status') {
      P.check(args.length===2);authority.modelStatus(...args);
    } else {
      P.check(args.length===2);
      write(args[1],require('../../desktop/security/runtime.cjs').validateBuild({profile:'customer',issuerPublicKey:authority.publicKey.export({type:'spki',format:'pem'}),serverUrl:args[0],allowLoopback:false}));
    }
    console.log('Customer authority operation completed. No patient data or private key exported.');
  }finally{authority.close();}
}
if(require.main===module){try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={issuerCrypto,main};
