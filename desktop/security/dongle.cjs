const {spawn}=require('node:child_process');
const P=require('./license-protocol.cjs');
class Dongle {
  constructor(python,script,bootstrapArgs=[]){Object.assign(this,{python,script,bootstrapArgs});this.queue=Promise.resolve();this.children=new Set();}
  request(value,signal){
    const run=()=>new Promise((resolve,reject)=>{
      P.check(!this.closed && !signal?.aborted,'Dongle authentication cancelled');
      const env={...process.env};for(const name of Object.keys(env))if(/^(PYTHON|ELECTRON|NODE_OPTIONS)/i.test(name))delete env[name];
      const child=spawn(this.python,['-I','-B','-X','utf8',...this.bootstrapArgs,this.script],{windowsHide:true,env,stdio:['pipe','pipe','ignore']});
      this.children.add(child);let output='',done=false;
      const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);this.children.delete(child);child.kill();error?reject(error):resolve(value);};
      const abort=()=>finish(Error('YubiKey authentication cancelled or timed out'));
      const timer=setTimeout(abort,10000);signal?.addEventListener('abort',abort,{once:true});
      child.on('error',()=>finish(Error('YubiKey runtime unavailable')));child.stdin.on('error',abort);
      child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(output.length>32768)abort();});
      child.on('close',code=>{try {const reply=JSON.parse(output);P.check(code===0 && !reply.error,reply.error || 'YubiKey operation failed');P.fields(reply,['value']);finish(null,reply.value);}catch(error){finish(error);}});
      child.stdin.end(JSON.stringify(value)+'\n');
    });
    const next=this.queue.then(run);this.queue=next.catch(()=>{});return next;
  }
  enrollment(signal){return this.request({operation:'enroll'},signal);}
  async sign(hardware,message,signal){return P.decode(await this.request({operation:'sign',hardware,message:message.toString('base64url')},signal));}
  async unwrap(hardware,token,context,signal){const key=P.decode(await this.request({operation:'unwrap',hardware,token,context},signal));P.check(key.length===32);return key;}
  close(){this.closed=true;for(const child of this.children)child.kill();}
}
module.exports={Dongle};
