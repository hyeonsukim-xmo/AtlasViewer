const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const P=require('./license-protocol.cjs');
const M=require('./model-package.cjs');
const {LicenseClient,transport}=require('./license-client.cjs');
const {read,atomicWrite,protectedStore}=require('./storage.cjs');

function validateBuild(build) {
  P.fields(build,['profile','issuerPublicKey','serverUrl','allowLoopback']);
  P.check(['internal','customer'].includes(build.profile));
  P.check(typeof build.allowLoopback==='boolean' && (!build.allowLoopback || build.profile==='internal'));
  P.check(typeof build.issuerPublicKey==='string' && !build.issuerPublicKey.includes('PRIVATE'));
  P.check(crypto.createPublicKey(build.issuerPublicKey).asymmetricKeyType==='ed25519');
  transport(build.serverUrl,build.allowLoopback);
  return Object.freeze({...build});
}
function loadBuild(packaged,file=path.join(__dirname,'build.json')) {
  if(!packaged)return Object.freeze({profile:'development'});
  try {return validateBuild(JSON.parse(read(file)));}
  catch {throw Error('설치본의 서명 서버·빌드 정책이 없습니다. EXMO 설치본을 다시 준비하세요.');}
}
async function openLicensing({build,directory,key,safeStorage,resultStorage,dongle}) {
  validateBuild(build);
  P.check(build.profile==='internal' || dongle,'Customer hardware authentication is unavailable');
  fs.mkdirSync(directory,{recursive:true});
  const identityPath=path.join(directory,'installation.json'),activationPath=path.join(directory,'activation.json');
  let identity,client,registration,models={},error=null;
  try {
    if(fs.existsSync(identityPath)) {
      identity=JSON.parse(read(identityPath));P.fields(identity,['installationId','installationPublicKey',...(identity.modelKeyPublicKey?['modelKeyPublicKey']:[])]);
      P.check(P.fingerprint(P.p256(await key.public(identity.installationId)))===P.fingerprint(P.p256(identity.installationPublicKey)),'Installation key changed');
    } else {
      const installationId=crypto.randomUUID(),installationPublicKey=await key.create(installationId);
      identity={installationId,installationPublicKey};
      atomicWrite(identityPath,JSON.stringify(identity));
    }
    if(!identity.modelKeyPublicKey) {
      identity.modelKeyPublicKey=await key.modelPublic(identity.installationId,true);
      atomicWrite(identityPath,JSON.stringify(identity));
    } else P.check(await key.modelPublic(identity.installationId)===identity.modelKeyPublicKey,'Model key changed');
    registration={profile:build.profile,...identity,installationKey:P.fingerprint(P.p256(identity.installationPublicKey))};
    if(build.profile==='internal') {
      registration.modelKeySignature=(await key.sign(identity.installationId,M.enrollmentMessage(registration))).toString('base64url');
      M.validateEnrollment(registration);
    }
  } catch {error='KEY_UNAVAILABLE';}
  const store=protectedStore(path.join(directory,'lease.bin'),safeStorage);
  const make=activation=>{
    P.check(identity && !error,'Installation key unavailable');
    P.fields(activation,['binding','installationPublicKey',...(activation.models?['models']:[]),...(activation.recovery?['recovery']:[]),...(build.profile==='customer'?['hardware']:[])]);P.binding(activation.binding);
    P.check(activation.binding.profile===build.profile && activation.binding.installationId===identity.installationId &&
      activation.binding.installationKey===P.fingerprint(P.p256(identity.installationPublicKey)) &&
      activation.installationPublicKey===identity.installationPublicKey,'Approval belongs to another build or installation');
    if(activation.models) {
      P.check(typeof activation.models==='object' && !Array.isArray(activation.models));
      for(const [engine,token] of Object.entries(activation.models)) {
        P.check(M.ENGINES.includes(engine));
        M.envelope(token,crypto.createPublicKey(build.issuerPublicKey),activation.binding,identity.modelKeyPublicKey);
      }
    }
    const hardware=build.profile==='customer'?M.hardwareKeys(activation.hardware):null;
    if(hardware)P.check(P.fingerprint(hardware['9e'])===activation.binding.dongleKey && P.fingerprint(hardware['9d'])===activation.binding.agreementKey,'Wrong hardware binding');
    const next=new LicenseClient({profile:build.profile,config:{binding:activation.binding,installationPublicKey:activation.installationPublicKey,issuerPublicKey:build.issuerPublicKey,
      ...(hardware?{donglePublicKey:hardware['9e'].export({type:'spki',format:'pem'})}:{})},store,
      post:transport(build.serverUrl,build.allowLoopback),
      sign:(role,message,signal)=>{
        if(role==='dongle' && hardware)return dongle.sign(activation.hardware,message,signal);
        P.check(role==='installation');return key.sign(identity.installationId,message,signal);
      }});
    next.hardware=activation.hardware;return next;
  };
  if(!error && fs.existsSync(activationPath)) {
    try {const activation=JSON.parse(read(activationPath));client=make(activation);models=activation.models || {};client.start();}catch {error='CONFIG_ERROR';}
  }
  return {
    status(){return {profile:build.profile,state:error || client?.state() || 'UNACTIVATED',expiresAt:client?.receipt?.exp ?? null};},
    enrollment(){
      P.check(identity && error!=='KEY_UNAVAILABLE','Windows 설치 키를 사용할 수 없습니다.');
      if(build.profile==='customer')return (async()=>{
        const request={...registration,hardware:await dongle.enrollment()};
        request.modelKeySignature=(await key.sign(identity.installationId,M.enrollmentMessage(request))).toString('base64url');
        M.validateEnrollment(request);return request;
      })();
      return {...registration};
    },
    async activate(activation){
      P.check(error!=='KEY_UNAVAILABLE','Windows installation key unavailable');
      const oldError=error;error=null;let next;
      try {
        next=make(activation);
        // Approval files only identify the installation; a fresh signed online lease grants access.
        P.check(await next.refresh()==='VALID','온라인 승인을 확인하지 못했습니다. 서버 등록과 연결을 확인하세요.');
        const same=client && JSON.stringify(client.config.binding)===JSON.stringify(activation.binding);
        const combined={...activation,models:{...(same?models:{}),...activation.models}};
        if(activation.recovery){P.check(resultStorage,'Result storage unavailable');resultStorage.recovery(activation.recovery,crypto.createPublicKey(build.issuerPublicKey),activation.binding);}
        atomicWrite(activationPath,JSON.stringify(combined));
        client?.close();client=next;next=null;models=combined.models;client.start();
      } catch(cause){error=oldError;throw cause;}finally {next?.close();}
    },
    async refresh(){if(client)await client.refresh();},
    async restoreResults(token){
      P.check(identity && resultStorage,'Result recovery unavailable');
      return resultStorage.restore(token,crypto.createPublicKey(build.issuerPublicKey),identity,wrapped=>key.unwrap(identity.installationId,wrapped));
    },
    async authorize(request){
      P.check(!error && client,`신규 분석 권한 없음: ${error || 'UNACTIVATED'}. 상단 라이선스에서 개발 장비를 등록하세요.`);
      if(resultStorage)P.check(resultStorage.ready(),'결과 보호 키 복구가 필요합니다.');
      if(build.profile==='customer')P.check(resultStorage?.hasRecovery(),'기관 결과 복구 키가 등록되어야 신규 분석을 시작할 수 있습니다.');
      return client.authorize(request);
    },
    async authorizeModel({runId,job,challenge,signal}) {
      const engine=M.modelId(job);
      P.check(!error && client,'Model analysis authorization unavailable');
      if(build.profile==='customer')P.check(resultStorage?.hasRecovery(),'기관 결과 복구 키가 필요합니다.');
      P.fields(challenge,['nonce','modelDigest']);P.nonce(challenge.nonce);P.digest(challenge.modelDigest);
      P.check(models[engine],'암호화 모델 승인이 없습니다. 모델 권한이 포함된 승인 파일을 적용하세요.');
      const access=M.envelope(models[engine],crypto.createPublicKey(build.issuerPublicKey),client.config.binding,identity.modelKeyPublicKey);
      P.check(access.modelDigest===challenge.modelDigest,'Approved model differs from installed model');
      await client.authorize({runId,engine:M.entitlement(engine),signal});
      P.check(client.receipt.modelDigests.includes(access.modelDigest),'설치된 모델 버전의 권한이 회수되었거나 갱신이 필요합니다.');
      let plain;
      if(build.profile==='customer') {
        const E=require('./model-envelope.cjs'),context=E.context(client.config.binding,access.modelDigest);
        const inner=await E.unwrap(access.jwe,wrapped=>key.unwrap(identity.installationId,wrapped,signal),context);
        plain=await dongle.unwrap(client.hardware,inner,context,signal);
      } else plain=await key.unwrap(identity.installationId,P.decode(access.wrappedKey),signal);
      try {
        P.check(plain.length===32 && ['VALID','GRACE'].includes(client.state()) && !signal?.aborted,'MRI model authorization expired');
        const lease=client.token,now=Math.floor(client.time());
        const claims={schema:'exmo-model-run-v1',runId,engine,nonce:challenge.nonce,modelDigest:access.modelDigest,
          jobDigest:M.hash(Buffer.from(JSON.stringify(job))),leaseDigest:M.hash(Buffer.from(lease)),keyDigest:M.hash(plain),
          iat:now,exp:Math.min(now+60,client.receipt.exp)};
        const message=JSON.stringify(claims);
        const signature=await key.sign(identity.installationId,Buffer.from('EXMO/MODEL-RUN/v1/'+message),signal);
        const hardwareProof=build.profile==='customer'?{
          donglePublicKey:client.config.donglePublicKey,
          dongleSignature:(await dongle.sign(client.hardware,Buffer.from('EXMO/MODEL-RUN/v1/dongle/'+message),signal)).toString('base64url'),
        }:{};
        P.check(['VALID','GRACE'].includes(client.state()) && client.token===lease && !signal?.aborted,'MRI authorization changed; retry analysis');
        return {lease,access:models[engine],installationPublicKey:identity.installationPublicKey,modelKeyPublicKey:identity.modelKeyPublicKey,
          message,signature:signature.toString('base64url'),key:plain.toString('base64url'),...hardwareProof};
      } finally {plain.fill(0);}
    },
    close(){client?.close();key.close();dongle?.close();},
  };
}
module.exports={loadBuild,validateBuild,openLicensing};
