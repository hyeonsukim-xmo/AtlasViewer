const {spawn}=require('node:child_process');
const path=require('node:path');
const crypto=require('node:crypto');
const P=require('./license-protocol.cjs');

function publicKey(blob) {
  const bytes=Buffer.from(blob,'base64');
  P.check(bytes.length===72 && bytes.toString('ascii',0,4)==='ECS1' && bytes.readUInt32LE(4)===32);
  return crypto.createPublicKey({key:{kty:'EC',crv:'P-256',x:bytes.subarray(8,40).toString('base64url'),
    y:bytes.subarray(40).toString('base64url')},format:'jwk'}).export({format:'pem',type:'spki'});
}
function derSignature(bytes) {
  P.check(bytes.length===64);
  const integer=part=>{
    while(part.length>1 && part[0]===0)part=part.subarray(1);
    if(part[0]&128)part=Buffer.concat([Buffer.from([0]),part]);
    return Buffer.concat([Buffer.from([2,part.length]),part]);
  };
  const body=Buffer.concat([integer(bytes.subarray(0,32)),integer(bytes.subarray(32))]);
  return Buffer.concat([Buffer.from([48,body.length]),body]);
}
class WindowsKey {
  constructor(script=path.join(__dirname,'windows-key.ps1')) {this.script=script;this.pending=new Map();this.sequence=0;}
  start() {
    P.check(!this.closed && process.platform==='win32','Windows key storage required');
    if(this.child)return;
    const executable=path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const child=spawn(executable,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',this.script],
      {windowsHide:true,stdio:['pipe','pipe','ignore']});
    this.child=child;let buffer='';
    const fail=()=>{
      if(this.child!==child)return;
      this.child=null;
      for(const pending of this.pending.values())pending.reject(Error('Windows installation key unavailable'));
      this.pending.clear();child.kill();
    };
    child.on('error',fail);child.on('exit',fail);child.stdin.on('error',fail);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      if(buffer.length>24000){fail();return;}
      let end;
      while((end=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        try {
          const reply=JSON.parse(line),pending=this.pending.get(reply.id);
          if(!pending)continue;
          this.pending.delete(reply.id);
          if(reply.error)pending.reject(Error('Windows installation key unavailable'));else pending.resolve(reply.value);
        } catch {fail();return;}
      }
    });
  }
  async request(command,installationId,message,signal) {
    P.check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(installationId));
    P.check(!signal?.aborted,'Authentication cancelled');
    this.start();const id=++this.sequence;
    let timer,abort;
    try {
      return await new Promise((resolve,reject)=>{
        abort=()=>{this.pending.delete(id);reject(Error('Windows key request cancelled'));};
        this.pending.set(id,{resolve,reject});
        timer=setTimeout(abort,10000);signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted){abort();return;}
        this.child.stdin.write(JSON.stringify({id,command,installationId,...(message?{message:message.toString('base64')}:{})})+'\n');
      });
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);this.pending.delete(id);}
  }
  async create(id) {return publicKey(await this.request('create',id));}
  async public(id) {return publicKey(await this.request('public',id));}
  async sign(id,message,signal) {return derSignature(Buffer.from(await this.request('sign',id,message,signal),'base64'));}
  async modelPublic(id,create=false) {
    const blob=Buffer.from(await this.request(create?'model-create':'model-public',id),'base64');
    P.check(blob.length===411 && blob.toString('ascii',0,4)==='RSA1' && blob.readUInt32LE(4)===3072 && blob.readUInt32LE(8)===3 && blob.readUInt32LE(12)===384 && blob.readUInt32LE(16)===0 && blob.readUInt32LE(20)===0);
    return crypto.createPublicKey({format:'jwk',key:{kty:'RSA',e:blob.subarray(24,27).toString('base64url'),n:blob.subarray(27).toString('base64url')}}).export({format:'pem',type:'spki'});
  }
  async unwrap(id,wrapped,signal) {return Buffer.from(await this.request('model-unwrap',id,wrapped,signal),'base64');}
  close() {
    this.closed=true;
    for(const pending of this.pending.values())pending.reject(Error('Windows key storage closed'));
    this.pending.clear();this.child?.kill();this.child=null;
  }
}
module.exports={WindowsKey,derSignature};
