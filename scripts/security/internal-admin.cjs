// Run on the EXMO authority host; this file and the issuer private key never ship to installations.
const fs=require('node:fs');
const P=require('../../desktop/security/license-protocol.cjs');
const M=require('../../desktop/security/model-package.cjs');
const {read}=require('../../desktop/security/storage.cjs');
const {validateBuild}=require('../../desktop/security/runtime.cjs');
const {Authority}=require('./license-server.cjs');
function write(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});}
function expiryTime(value) {
  P.check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) && new Date(value).toISOString()===value.replace('Z','.000Z'),'Expiry must be an explicit UTC date/time');
  return Date.parse(value)/1000;
}
function main([command,directory,...args]) {
  P.check(['approve','extend','activation','build-config','build-config-v3','solutions','solutions-dry-run','solution-status','solution-expiry'].includes(command),
    'Usage: internal-admin.cjs approve DIR REQUEST LICENSE_ID EXPIRY_UTC ct,mri,ap,lat | extend DIR LICENSE_ID EXPIRY_UTC | activation DIR LICENSE_ID OUTPUT | build-config DIR HTTPS_URL OUTPUT [--loopback-test]');
  const authority=new Authority(directory);
  try {
    P.check(authority.profile==='internal','Internal authority required');
    if(command.startsWith('solution')) {console.log(JSON.stringify(require('./solution-admin.cjs').configure(authority,command,args)));}
    else if(command==='approve') {
      P.check(args.length===4);
      const [requestFile,licenseId,expiry,engines]=args,request=JSON.parse(read(requestFile));
      if(request.modelKeyPublicKey)M.validateEnrollment(request);
      else P.fields(request,['profile','installationId','installationKey','installationPublicKey']);
      P.check(request.profile==='internal');
      authority.approve({binding:{profile:'internal',licenseId,installationId:request.installationId,installationKey:request.installationKey},
        installationPublicKey:request.installationPublicKey,engines:engines.split(','),contractEnd:expiryTime(expiry),
        graceSeconds:7*86400,renewSeconds:300});
      console.log('Approved installation with an explicit expiry. Export its public activation file next.');
    } else if(command==='extend') {
      P.check(args.length===2);authority.extend(args[0],expiryTime(args[1]));
      console.log('Extended internal approval. Revoked or suspended status is unchanged.');
    } else if(command==='activation') {
      P.check(args.length===2);P.id(args[0]);
      const row=authority.db.prepare('SELECT config FROM licenses WHERE id=?').get(args[0]);P.check(row,'Unknown approval');
      const config=JSON.parse(row.config);
      write(args[1],{binding:config.binding,installationPublicKey:config.installationPublicKey});
      console.log('Exported public activation binding; online activation still required.');
    } else {
      P.check(args.length===2 || (args.length===3 && args[2]==='--loopback-test'));
      write(args[1],validateBuild({profile:'internal',issuerPublicKey:authority.publicKey.export({format:'pem',type:'spki'}),
        serverUrl:args[0],allowLoopback:args[2]==='--loopback-test',...(command==='build-config-v3'?{licenseVersion:3}:{})}));
      console.log('Exported public build trust. No private key or preapproved installation included.');
    }
  } finally {authority.close();}
}
if(require.main===module){try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={main,expiryTime};
