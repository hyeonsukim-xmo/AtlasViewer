// Build profile and issuer are pinned by the caller, never by an activation file.
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const P = require('./license-protocol.cjs');
const V3 = require('./license-v3.cjs');

function localTransport(base) {
  return transport(base,true);
}
function transport(base,allowLoopback=false) {
  const url = new URL(base);
  const loopback=url.protocol==='http:' && url.hostname==='127.0.0.1' && url.port;
  P.check((url.protocol==='https:' || (allowLoopback && loopback)) &&
    url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash,'Licensing requires HTTPS or an explicitly enabled local test server');
  return (route,body,signal)=>new Promise((resolve,reject)=>{
    P.check(['/v1/challenge','/v1/lease','/v3/challenges','/v3/leases'].includes(route));
    const protocol=route.startsWith('/v3/')?V3:P;
    const data = JSON.stringify(body); P.check(Buffer.byteLength(data)<=protocol.LIMIT);
    const request = (url.protocol==='https:'?https:http).request(new URL(route,url),{method:'POST',signal,headers:{
      'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),Connection:'close'}},response=>{
      const chunks=[]; let size=0;
      response.on('data',chunk=>{
        size+=chunk.length;
        if (size>protocol.LIMIT+32) response.destroy(Error('Licensing response too large')); else chunks.push(chunk);
      });
      response.on('error',reject);
      response.on('end',()=>{
        try {
          P.check(response.statusCode===200 && response.headers['content-type']==='application/json','Licensing server unavailable');
          const text=Buffer.concat(chunks).toString('utf8'),reply=JSON.parse(text);P.check(JSON.stringify(reply)===text);P.fields(reply,['token']);
          resolve(reply);
        } catch(error) {reject(error);}
      });
    });
    request.on('error',reject); request.end(data);
  });
}

class LicenseClient {
  constructor({profile,config,store,sign,post,version=2,clock={wall:()=>Date.now()/1000,mono:()=>performance.now()/1000}}) {
    P.check([2,3].includes(version));this.version=version;this.protocol=version===3?V3:P;
    P.check(['internal','customer'].includes(profile) && config.binding?.profile===profile,'License profile does not match this build');
    P.fields(config,['binding','issuerPublicKey','installationPublicKey',...(profile==='customer'?['donglePublicKey']:[])]);
    P.binding(config.binding);
    this.profile=profile;
    this.config=structuredClone(config);
    this.issuer=crypto.createPublicKey(config.issuerPublicKey);
    P.check(this.issuer.asymmetricKeyType==='ed25519');
    this.keys={installation:P.p256(config.installationPublicKey)};
    if(profile==='customer')this.keys.dongle=P.p256(config.donglePublicKey);
    for(const role of Object.keys(this.keys))P.check(P.fingerprint(this.keys[role])===config.binding[`${role}Key`]);
    this.store=store; this.sign=sign; this.post=post; this.clock=clock;
    this.queue=Promise.resolve(); this.receipt=null; this.token=null; this.offline=true;
    this.timeUntrusted=false; this.storageFailed=false; this.closed=false;
    this.nextAttempt=0;
    try {
      const saved=store.read();
      if (saved !== null) {
        P.fields(saved,['token','wall','serverNow']);
        this.receipt=this.protocol.verifyToken(saved.token,this.issuer,'lease',config.binding); this.token=saved.token;
        P.check(Number.isFinite(saved.wall) && Number.isFinite(saved.serverNow) && saved.serverNow>=this.receipt.iat);
        this.anchor={wall:saved.wall,server:saved.serverNow,mono:clock.mono()}; this.lastWall=saved.wall;
        this.time();
      }
    } catch {this.timeUntrusted=true;}
  }
  enqueue(action) {
    const next=this.queue.then(()=>{P.check(!this.closed,'Licensing client closed');return action();});
    this.queue=next.catch(()=>{}); return next;
  }
  time() {
    if (!this.anchor) return 0;
    const wall=this.clock.wall(), mono=this.clock.mono();
    if (!Number.isFinite(wall) || !Number.isFinite(mono) || wall<this.lastWall-2 || mono<this.anchor.mono) this.timeUntrusted=true;
    this.lastWall=Math.max(this.lastWall,wall);
    return this.anchor.server+Math.max(0,this.lastWall-this.anchor.wall,mono-this.anchor.mono);
  }
  state() {
    const now=this.time();
    if (this.storageFailed) return 'STORAGE_ERROR';
    if (this.receipt && this.receipt.decision!=='allow') return this.receipt.decision.toUpperCase();
    if (this.timeUntrusted) return 'TIME_UNTRUSTED';
    if (!this.receipt) return 'UNACTIVATED';
    if (now>=this.receipt.exp) return 'EXPIRED';
    return this.offline || now>=this.receipt.renewAfter ? 'GRACE' : 'VALID';
  }
  persist() {
    try {
      const serverNow=this.time();
      this.store.write({token:this.token,wall:this.lastWall,serverNow});
      this.storageFailed=false;
    } catch {this.storageFailed=true; throw Error('Licensing state could not be saved');}
  }
  async bounded(action, parentSignal) {
    P.check(!parentSignal?.aborted,'Analysis cancelled');
    const controller=new AbortController();
    let timer, cancelled;
    try {
      return await Promise.race([action(controller.signal),new Promise((_,reject)=>{
        cancelled=()=>{controller.abort();reject(Error('Analysis cancelled'));};
        parentSignal?.addEventListener('abort',cancelled,{once:true});
        if(parentSignal?.aborted)cancelled();
        timer=setTimeout(()=>{controller.abort();reject(Error('Licensing request timed out'));},10000);
      })]);
    } finally {clearTimeout(timer);parentSignal?.removeEventListener('abort',cancelled);controller.abort();}
  }
  async proofs(message,signal) {
    const result={};
    for (const role of Object.keys(this.keys)) {
      P.check(!signal.aborted,'Authentication cancelled');
      const signature=await this.sign(role,P.proofMessage(role,message),signal);
      P.check(Buffer.isBuffer(signature));
      result[`${role}Signature`]=signature.toString('base64url');
      P.verifyProof(this.keys[role],role,message,result[`${role}Signature`]);
    }
    return result;
  }
  async renew(parentSignal) {
    this.offline=true;
    this.nextAttempt=this.clock.mono()+30;
    try {
      await this.bounded(async signal=>{
        const started=this.clock.mono(), nonce=crypto.randomBytes(32).toString('base64url');
        const request={binding:this.config.binding,nonce};
        const challenge=await this.post(this.version===3?'/v3/challenges':'/v1/challenge',request,signal);
        const claims=this.protocol.verifyToken(challenge.token,this.issuer,'challenge',request.binding);
        P.check(claims.nonce===nonce,'Challenge belongs to another request');
        const signatures=await this.proofs(challenge.token,signal);
        const response=await this.post(this.version===3?'/v3/leases':'/v1/lease',{challengeId:claims.challengeId,...signatures},signal);
        const receipt=this.protocol.verifyToken(response.token,this.issuer,'lease',request.binding);
        const elapsed=this.clock.mono()-started;
        P.check(!this.closed && !signal.aborted && elapsed>=0 && elapsed<60 && receipt.nonce===nonce &&
          receipt.iat>=claims.iat && receipt.iat<claims.exp,'Expired or mismatched response');
        if (this.receipt) {
          P.check(receipt.revision>=this.receipt.revision && receipt.sequence>this.receipt.sequence && receipt.iat>=this.receipt.iat,'Stale licensing response');
          if (this.receipt.decision!=='allow' && receipt.decision==='allow') P.check(receipt.revision>this.receipt.revision,'A newer administrative approval is required');
          if(this.version===3 && this.receipt.decision==='allow' && receipt.decision==='allow')V3.transition(this.receipt,receipt);
        }
        this.receipt=receipt; this.token=response.token;
        this.anchor={wall:this.clock.wall(),mono:this.clock.mono(),server:receipt.iat+elapsed};
        this.lastWall=this.anchor.wall; this.timeUntrusted=false;
        this.persist(); this.offline=false;
      },parentSignal);
    } catch { /* An unsigned failure never grants, extends or revokes a lease. */ }
    return this.state();
  }
  refresh() {return this.enqueue(()=>this.renew());}
  authorize({runId,engine,execution,signal}) {
    return this.enqueue(async()=>{
      P.check(typeof runId==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId) && [...P.ENGINES,'xray-classifier'].includes(engine));
      P.check(!this.closed && !signal?.aborted,'Analysis cancelled');
      if (this.state()!=='VALID' && this.clock.mono()>=this.nextAttempt) await this.renew(signal);
      P.check(!this.closed && !signal?.aborted,'Analysis cancelled');
      let state=this.state();
      P.check(['VALID','GRACE'].includes(state),`신규 분석 권한 없음: ${state}`);
      const permitted=()=>this.version===3?V3.allowed(this.receipt,execution,this.time()):P.check(engine==='xray-classifier'?this.receipt.engines.some(value=>value==='ap'||value==='lat'):this.receipt.engines.includes(engine),'이 분석 모델의 사용 권한이 없습니다.');
      permitted();
      try {
        // Offline and cached runs still prove the installation (and customer dongle) afresh.
        const message=JSON.stringify({binding:this.config.binding,runId,engine,nonce:crypto.randomBytes(32).toString('base64url')});
        await this.bounded(abort=>this.proofs(message,abort),signal);
      } catch {
        P.check(!signal?.aborted,'Analysis cancelled');
        throw Error(this.profile==='internal'?'등록된 개발 PC 인증 실패: 신규 분석을 시작하지 않습니다.':'등록된 PC·동글 인증 실패: 신규 분석을 시작하지 않습니다.');
      }
      P.check(!this.closed && !signal?.aborted,'Analysis cancelled');
      state=this.state();
      P.check(['VALID','GRACE'].includes(state),`신규 분석 권한 없음: ${state}`);
      permitted();
      this.persist();
      return {runId,engine,state};
    });
  }
  start() {
    P.check(!this.closed,'Licensing client closed');
    if (this.timer) return;
    if(this.state()!=='VALID')this.refresh().catch(()=>{});
    this.timer=setInterval(()=>{if(this.state()!=='VALID')this.refresh().catch(()=>{});},30000);
    this.timer.unref?.();
  }
  close() {this.closed=true;clearInterval(this.timer);this.timer=null;}
}
module.exports={LicenseClient,localTransport,transport};
