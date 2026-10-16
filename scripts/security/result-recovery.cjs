// Institution/operator only. Recovery private keys never ship with the application.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const P=require('../../desktop/security/license-protocol.cjs'),M=require('../../desktop/security/model-package.cjs');
const {read}=require('../../desktop/security/storage.cjs');
const {Authority}=require('./license-server.cjs');
function main([command,...args]) {
  const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
  if(command==='init') {
    P.check(args.length===1);fs.mkdirSync(args[0],{recursive:false,mode:0o700});
    const keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
    fs.writeFileSync(path.join(args[0],'recovery-private.pem'),keys.privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});
    fs.writeFileSync(path.join(args[0],'recovery-public.pem'),keys.publicKey.export({type:'spki',format:'pem'}),{flag:'wx'});return;
  }
  P.check(['policy','restore'].includes(command) && args.length===5,'Usage: result-recovery.cjs init DIR | policy AUTH LICENSE PUBLIC_PEM ACTIVATION OUTPUT | restore AUTH PRIVATE_PEM RECOVERY_JSON NEW_ENROLLMENT OUTPUT');
  const [directory,...values]=args,authority=new Authority(directory);
  try {
    if(command==='policy') {
      const [licenseId,publicFile,activationFile,output]=values;P.id(licenseId);
      const config=JSON.parse(authority.db.prepare('SELECT config FROM licenses WHERE id=?').get(licenseId)?.config || 'null');P.check(config);
      const recoveryPublicKey=read(publicFile).toString();require('../../desktop/security/result-storage.cjs').recoveryKey(recoveryPublicKey);
      const activation=JSON.parse(read(activationFile));P.sameBinding(activation.binding,config.binding);
      activation.recovery=M.sign({schema:'exmo-result-recovery-v1',binding:config.binding,recoveryPublicKey},authority.key);write(output,activation);
    } else {
      const [privateFile,recoveryFile,enrollmentFile,output]=values;
      const recovery=JSON.parse(read(recoveryFile)),request=JSON.parse(read(enrollmentFile));M.validateEnrollment(request);
      P.fields(recovery,['schema','id','recipient','wrappedKey','policy']);P.check(recovery.schema==='exmo-result-recovery-v1');P.id(recovery.id);
      const privateKey=crypto.createPrivateKey(read(privateFile));P.check(P.fingerprint(crypto.createPublicKey(privateKey))===recovery.recipient);
      const policy=M.verify(recovery.policy,authority.publicKey,'exmo-result-recovery-v1');P.check(P.fingerprint(crypto.createPublicKey(policy.recoveryPublicKey))===recovery.recipient);
      const key=crypto.privateDecrypt({key:privateKey,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},P.decode(recovery.wrappedKey));
      try {
        P.check(key.length===32);const recipient=M.rsa(request.modelKeyPublicKey);
        const wrappedKey=crypto.publicEncrypt({key:recipient,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},key).toString('base64url');
        write(output,{token:M.sign({schema:'exmo-result-restore-v1',id:recovery.id,installationId:request.installationId,recipient:P.fingerprint(recipient),wrappedKey},authority.key)});
      }finally{key.fill(0);}
    }
  }finally{authority.close();}
}
if(require.main===module){try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={main};
