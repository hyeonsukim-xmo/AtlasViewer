// Synthetic identity provider and device fixtures, used only by local validation.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http');
const P=require('../../desktop/security/license-protocol.cjs'),M=require('../../desktop/security/model-package.cjs');
const {openLicensing}=require('../../desktop/security/runtime.cjs');
const {Accounts,verifier,createServer}=require('./account-server.cjs');
const {Authority,main,createServer:licenseServer}=require('./license-server.cjs');
const start=async server=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`;};
const cleanupKey=Symbol('cleanup');
function cleanup(t,fn){if(!t[cleanupKey]){t[cleanupKey]=[];t.after(async()=>{for(const action of t[cleanupKey].reverse())await action();});}t[cleanupKey].push(fn);}
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'exmo-account-'));cleanup(t,()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});return root;}
function safeStorage(){const key=crypto.randomBytes(32);return {isEncryptionAvailable:()=>true,encryptString:value=>{const nonce=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,nonce);return Buffer.concat([nonce,c.update(value),c.final(),c.getAuthTag()]);},decryptString:value=>{const c=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));c.setAuthTag(value.subarray(-16));return Buffer.concat([c.update(value.subarray(12,-16)),c.final()]).toString();}};}
async function identityProvider(t){
  const jose=await import('jose'),keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),jwk=await jose.exportJWK(keys.publicKey);jwk.kid='test';
  const codes=new Map(),refreshTokens=new Map(),settings={subject:'manager',badNonce:false,badSignature:false,refreshes:0,stall:false,issued:[]};
  let base;
  const sign=(claims,expires='5m')=>new jose.SignJWT(claims).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(base).setIssuedAt().setExpirationTime(expires).sign(keys.privateKey);
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,base);res.setHeader('Content-Type','application/json');
      if(url.pathname==='/.well-known/openid-configuration')return res.end(JSON.stringify({issuer:base,authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',revocation_endpoint:base+'/revoke',jwks_uri:base+'/jwks',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']}));
      if(url.pathname==='/jwks')return res.end(JSON.stringify({keys:[jwk]}));
      if(url.pathname==='/authorize'){
        assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('resource'),base+'/api');
        const code=crypto.randomUUID();codes.set(code,{parameters:url.searchParams,subject:settings.subject});
        const redirect=new URL(url.searchParams.get('redirect_uri'));assert.equal(redirect.hostname,'127.0.0.1');
        redirect.searchParams.set('code',code);redirect.searchParams.set('state',url.searchParams.get('state'));redirect.searchParams.set('iss',base);
        res.writeHead(302,{Location:redirect.href});return res.end();
      }
      const chunks=[];for await(const part of req)chunks.push(part);const body=new URLSearchParams(Buffer.concat(chunks).toString());
      if(url.pathname==='/revoke'){refreshTokens.delete(body.get('token'));return res.end('{}');}
      assert.equal(url.pathname,'/token');assert.equal(body.get('client_id'),'desktop');assert.equal(body.get('client_secret'),null);
      let sub,nonce;
      if(body.get('grant_type')==='authorization_code'){
        const auth=codes.get(body.get('code'));assert.ok(auth);codes.delete(body.get('code'));
        assert.equal(crypto.createHash('sha256').update(body.get('code_verifier')).digest('base64url'),auth.parameters.get('code_challenge'));
        assert.equal(body.get('redirect_uri'),auth.parameters.get('redirect_uri'));sub=auth.subject;nonce=auth.parameters.get('nonce');
      }else{
        assert.equal(body.get('grant_type'),'refresh_token');sub=refreshTokens.get(body.get('refresh_token'));assert.ok(sub);refreshTokens.delete(body.get('refresh_token'));settings.refreshes++;
      }
      const refresh=crypto.randomBytes(32).toString('base64url');refreshTokens.set(refresh,sub);settings.issued.push(refresh);
      const access=await sign({sub,aud:base+'/api',azp:'desktop',scope:'exmo.account',amr:['mfa'],auth_time:Math.floor(Date.now()/1000)});
      let id=await sign({sub,aud:'desktop',auth_time:Math.floor(Date.now()/1000),...(nonce?{nonce:settings.badNonce?'wrong-nonce':nonce}:{})});
      if(settings.badSignature)id=id.slice(0,-10)+'AAAAAAAAAA';
      res.end(JSON.stringify({token_type:'Bearer',access_token:access,refresh_token:refresh,expires_in:settings.expiresIn??300,id_token:id}));
    }catch(e){res.statusCode=400;res.end(JSON.stringify({error:'invalid_grant'}));}
  });
  base=await start(server);cleanup(t,()=>{server.closeAllConnections();server.close();});
  async function browser(url){if(settings.stall)return;const response=await fetch(url,{redirect:'manual'});assert.equal(response.status,302);const redirect=response.headers.get('location');const wrong=new URL(redirect);wrong.searchParams.set('state','forged');assert.equal((await fetch(wrong)).status,400);assert.equal((await fetch(redirect)).status,200);}
  return {base,settings,browser,sign};
}
async function setup(t){
  const root=temporary(t),directory=path.join(root,'authority');main(['init',directory,'internal']);
  const authority=new Authority(directory);cleanup(t,()=>authority.close());
  const accounts=new Accounts(authority);accounts.membership('manager','hospital-a','research','Research',['device-admin']);accounts.membership('manager','hospital-b','research','Other hospital',['device-admin']);accounts.membership('analyst','hospital-a','research','Research',['analyst']);accounts.operator('operator',true);
  const idp=await identityProvider(t),verify=await verifier({issuer:idp.base,audience:idp.base+'/api',clientId:'desktop',jwksUrl:idp.base+'/jwks'},true);
  const server=createServer(accounts,verify),apiUrl=await start(server);cleanup(t,()=>{server.closeAllConnections();server.close();});
  return {root,authority,accounts,idp,apiUrl,verify,config:{issuer:idp.base,clientId:'desktop',apiUrl,resource:idp.base+'/api'}};
}
async function device(t,f){
  const ec=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),rsa=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
  const pub=ec.publicKey.export({type:'spki',format:'pem'}),rsaPub=rsa.publicKey.export({type:'spki',format:'pem'});
  const key={create:async()=>pub,public:async()=>pub,modelPublic:async()=>rsaPub,sign:async(_,m)=>crypto.sign('sha256',m,ec.privateKey),close(){}};
  const server=licenseServer(f.authority),serverUrl=await start(server);cleanup(t,()=>{server.closeAllConnections();server.close();});
  const licensing=await openLicensing({build:{profile:'internal',issuerPublicKey:f.authority.publicKey.export({type:'spki',format:'pem'}),serverUrl,allowLoopback:true,licenseVersion:3},directory:path.join(f.root,'device'),key,safeStorage:safeStorage()});cleanup(t,()=>licensing.close());
  return licensing;
}
function prepare(f,request,row){
  const binding={profile:'internal',licenseId:'license-a',installationId:request.installationId,installationKey:request.installationKey},digest='a'.repeat(64);
  f.authority.approve({binding,installationPublicKey:request.installationPublicKey,engines:['ct'],contractEnd:Math.floor(Date.now()/1000)+3600,graceSeconds:3600,renewSeconds:300});
  f.authority.db.prepare("INSERT INTO models VALUES(?,'active')").run(digest);f.authority.db.prepare('INSERT INTO model_grants VALUES(?,?,?)').run(binding.licenseId,'ct',digest);
  const execution={solutionId:'exmo.thigh.ct',workflowId:'thigh-muscle-ct-v1',capability:'analyze',engine:'ct',modelDigest:digest,recipeDigest:'b'.repeat(64),packageSetDigest:'c'.repeat(64)};
  f.authority.solutions(binding.licenseId,{orgId:'hospital-a',entitlements:[{entitlementId:'ct',solutionId:execution.solutionId,validFrom:0,validUntil:null,state:'active',revision:1,capabilities:['analyze'],executions:[execution]}]});
  const token=M.sign({schema:'exmo-model-access-v1',binding,modelDigest:digest,recipient:P.fingerprint(M.rsa(request.modelKeyPublicKey)),wrappedKey:crypto.randomBytes(384).toString('base64url')},f.authority.key);
  const activation={binding,installationPublicKey:request.installationPublicKey,models:{ct:token}};
  f.accounts.prepare(row.id,activation);return activation;
}

module.exports={cleanup,temporary,safeStorage,identityProvider,setup,device,prepare};
