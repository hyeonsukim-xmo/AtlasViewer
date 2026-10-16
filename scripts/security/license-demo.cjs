// Explicitly simulated devices, outside the customer package. Never import from desktop/.
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const P=require('../../desktop/security/license-protocol.cjs');
const {Authority,main:serverCommand}=require('./license-server.cjs');
const {LicenseClient,localTransport}=require('../../desktop/security/license-client.cjs');

function createFixture(directory,profile='customer') {
  fs.mkdirSync(directory,{recursive:false,mode:0o700});
  const server=path.join(directory,'server'); serverCommand(['init',server,profile]);
  const publicKeys={}, privateKeys={};
  for(const role of ['installation','dongle','agreement']) {
    const pair=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    publicKeys[role]=pair.publicKey;
    privateKeys[role]=pair.privateKey.export({format:'pem',type:'pkcs8'});
  }
  const binding={profile,licenseId:'development-only',installationId:crypto.randomUUID(),
    installationKey:P.fingerprint(publicKeys.installation),...(profile==='customer'?{dongleKey:P.fingerprint(publicKeys.dongle),agreementKey:P.fingerprint(publicKeys.agreement)}:{})};
  const config={binding,issuerPublicKey:fs.readFileSync(path.join(server,'issuer-public.pem'),'utf8'),
    installationPublicKey:publicKeys.installation.export({format:'pem',type:'spki'}),
    ...(profile==='customer'?{donglePublicKey:publicKeys.dongle.export({format:'pem',type:'spki'})}:{})};
  const approval={binding,installationPublicKey:config.installationPublicKey,...(profile==='customer'?{donglePublicKey:config.donglePublicKey}:{}),
    engines:[...P.ENGINES],contractEnd:profile==='internal'?Math.floor(Date.now()/1000)+30*86400:null,graceSeconds:7*86400,renewSeconds:300};
  fs.writeFileSync(path.join(directory,'client-public.json'),JSON.stringify(config,null,2),{flag:'wx'});
  fs.writeFileSync(path.join(directory,'approval-public.json'),JSON.stringify(approval,null,2),{flag:'wx'});
  fs.writeFileSync(path.join(directory,'SIMULATED-device-private.json'),JSON.stringify(privateKeys),{flag:'wx',mode:0o600});
  const authority=new Authority(server);
  try {authority.approve(approval);} finally {authority.close();}
  return {config,approval,server};
}
function fileStore(file) {
  return {
    read() {
      try {P.check(fs.statSync(file).size<=P.LIMIT);return JSON.parse(fs.readFileSync(file,'utf8'));}
      catch(error) {if(error.code==='ENOENT')return null;throw error;}
    },
    write(value) {
      // shortcut: atomic but not tamper-resistant; replace with protected state before customer integration.
      const temporary=`${file}.${crypto.randomUUID()}.tmp`;
      let fd;
      try {
        fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
        fs.renameSync(temporary,file);
      } finally {if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temporary,{force:true});}
    },
  };
}
function simulatedClient(directory,url,clock) {
  const config=JSON.parse(fs.readFileSync(path.join(directory,'client-public.json'),'utf8'));
  const keys=JSON.parse(fs.readFileSync(path.join(directory,'SIMULATED-device-private.json'),'utf8'));
  return new LicenseClient({profile:config.binding.profile,config,store:fileStore(path.join(directory,'client-state.json')),post:localTransport(url),clock,
    sign:async(role,message)=>{
      P.check(!fs.existsSync(path.join(directory,'dongle-removed')) || role!=='dongle','Simulated dongle removed');
      return crypto.sign('sha256',message,keys[role]);
    }});
}
async function main([command,directory,url,engine]) {
  P.check(directory && ['init','refresh','analyze'].includes(command),
    'Usage: license-demo.cjs init DIRECTORY | refresh DIRECTORY URL | analyze DIRECTORY URL ct|mri|ap|lat');
  if(command==='init') {P.check(!url && !engine);createFixture(directory);console.log('Created SIMULATED devices and public approval for local testing only.');return;}
  const client=simulatedClient(directory,url);
  try {
    if(command==='refresh') console.log(JSON.stringify({simulation:true,state:await client.refresh()}));
    else console.log(JSON.stringify({simulation:true,...await client.authorize({runId:crypto.randomUUID(),engine})}));
  } finally {client.close();}
}
if(require.main===module) main(process.argv.slice(2)).catch(()=>{
  console.error('PoC operation failed; no new analysis authorized. Check server, state, engine and simulated dongle.');process.exitCode=1;
});
module.exports={createFixture,fileStore,simulatedClient};
