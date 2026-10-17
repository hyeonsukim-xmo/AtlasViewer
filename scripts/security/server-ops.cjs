const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const P=require('../../desktop/security/license-protocol.cjs'),M=require('../../desktop/security/model-package.cjs');
const {hashFile}=require('../../desktop/security/payload.cjs');
const {Authority}=require('./license-server.cjs');
function allowed(name){return ['authority.json','authority.sqlite','issuer-private.pem','issuer-public.pem'].includes(name) || /^[A-Za-z0-9_-]{1,80}\.hardware\.json$/.test(name) || /^model-keys\/[0-9a-f]{64}\.key$/.test(name);}
function backup(directory,output) {
  P.check(!fs.existsSync(output),'Use a new backup directory');
  const authority=new Authority(directory);fs.mkdirSync(output,{recursive:false,mode:0o700});
  try {
    authority.db.prepare('VACUUM INTO ?').run(path.resolve(output,'authority.sqlite'));
    const names=['authority.json','issuer-private.pem','issuer-public.pem',...fs.readdirSync(directory).filter(name=>name.endsWith('.hardware.json'))];
    const keys=path.join(directory,'model-keys');if(fs.existsSync(keys))for(const name of fs.readdirSync(keys))names.push('model-keys/'+name);
    for(const name of names){P.check(allowed(name));const target=path.join(output,name);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.copyFileSync(path.join(directory,name),target,fs.constants.COPYFILE_EXCL);fs.chmodSync(target,0o600);}
    fs.chmodSync(path.join(output,'authority.sqlite'),0o600);
    const files=['authority.sqlite',...names].sort().map(name=>({path:name,...hashFile(path.join(output,name))}));
    const token=M.sign({schema:'exmo-authority-backup-v1',profile:authority.profile,createdAt:authority.clock(),files},authority.key);
    fs.writeFileSync(path.join(output,'backup.json'),JSON.stringify({token}),{flag:'wx',mode:0o600});
  }finally{authority.close();}
}
function verify(directory,publicKey) {
  const record=path.join(directory,'backup.json');P.check(fs.statSync(record).size<=M.LIMIT);
  const document=JSON.parse(fs.readFileSync(record,'utf8'));P.fields(document,['token']);
  const policy=M.verify(document.token,publicKey,'exmo-authority-backup-v1');P.fields(policy,['schema','profile','createdAt','files']);
  P.check(Array.isArray(policy.files) && policy.files.length>=4);const names=new Set();
  for(const f of policy.files){P.fields(f,['path','size','sha256']);P.check(allowed(f.path) && !names.has(f.path));names.add(f.path);
    const actual=hashFile(path.join(directory,f.path));P.check(actual.size===f.size && actual.sha256===f.sha256,'Backup integrity failed');}
  const db=new DatabaseSync(path.join(directory,'authority.sqlite'),{readOnly:true});
  try{P.check(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok');
    for(const row of db.prepare('SELECT DISTINCT digest FROM model_grants').all())P.check(names.has('model-keys/'+row.digest+'.key'),'Backup is missing a granted model key');
  }finally{db.close();}
  return policy;
}
function main([command,...args]) {
  if(command==='backup'){P.check(args.length===2);backup(...args);}
  else if(command==='verify' || command==='restore') {
    P.check(args.length===(command==='restore'?3:2));const [source,publicFile,output]=args;
    const policy=verify(source,crypto.createPublicKey(fs.readFileSync(publicFile)));
    if(output){P.check(!fs.existsSync(output));fs.mkdirSync(output,{recursive:false,mode:0o700});for(const f of policy.files){const target=path.join(output,f.path);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.copyFileSync(path.join(source,f.path),target,fs.constants.COPYFILE_EXCL);fs.chmodSync(target,0o600);}}
  } else if(command==='deploy-files') {
    P.check(args.length===2);const [host,output]=args;
    P.check(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) && !fs.existsSync(output));fs.mkdirSync(output,{recursive:false});
    fs.writeFileSync(path.join(output,'exmo-license.service'),`[Unit]\nDescription=EXMO licensing authority\nAfter=network.target\n\n[Service]\nUser=exmo-license\nGroup=exmo-license\nWorkingDirectory=/opt/exmo/AtlasViewer\nExecStart=/usr/bin/node scripts/security/license-server.cjs serve /var/lib/exmo-license 43127\nRestart=on-failure\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths=/var/lib/exmo-license\n\n[Install]\nWantedBy=multi-user.target\n`,{flag:'wx'});
    fs.writeFileSync(path.join(output,'exmo-license.conf'),`limit_req_zone $binary_remote_addr zone=exmo_license:10m rate=10r/s;\nserver {\n    listen 443 ssl;\n    server_name ${host};\n    ssl_certificate /etc/letsencrypt/live/${host}/fullchain.pem;\n    ssl_certificate_key /etc/letsencrypt/live/${host}/privkey.pem;\n    ssl_protocols TLSv1.2 TLSv1.3;\n    client_max_body_size 128k;\n    location ~ ^/(v1/(challenge|lease)|v3/(challenges|leases))$ {\n        limit_req zone=exmo_license burst=20 nodelay;\n        proxy_pass http://127.0.0.1:43127;\n        proxy_set_header Host 127.0.0.1:43127;\n        proxy_set_header Connection close;\n        proxy_read_timeout 10s;\n    }\n    location / { return 404; }\n}\n`,{flag:'wx'});
  } else throw Error('Usage: server-ops.cjs backup AUTH OUTPUT | verify BACKUP TRUSTED_PUBLIC_PEM | restore BACKUP TRUSTED_PUBLIC_PEM NEW_AUTH | deploy-files HOST OUTPUT');
  console.log('Server operation completed. Backup directories contain secret authority material; keep them on protected operator storage.');
}
if(require.main===module){try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={backup,verify,main};
