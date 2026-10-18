const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const P=require('./license-protocol.cjs');
const A=require('./account-protocol.cjs');
const {protectedStore}=require('./storage.cjs');

function openAccount({config,directory,safeStorage,openExternal,licensing,allowLoopback=false,loginTimeoutMs=180000}){
  if(!config)return {status:()=>({state:'unconfigured',me:null,workspace:null}),close(){}};
  A.configuration(config,allowLoopback);
  try{fs.mkdirSync(directory,{recursive:true});}
  catch{return {status:()=>({state:'storage-unavailable',me:null,workspace:null}),close(){}};}
  const file=path.join(directory,'session.bin'),store=protectedStore(file,safeStorage);
  let session=null,identity=null,selected=null,state='signed-out',generation=0,flow=null,refreshing=null,discovery=null;
  // Tokens and cloud selection have a separate lifetime from device leases and result keys.
  try{const saved=store.read();if(saved){P.fields(saved,['issuer','clientId','refreshToken','subject']);P.check(saved.issuer===config.issuer && saved.clientId===config.clientId);A.text(saved.subject,512);A.text(saved.refreshToken,32768);session={...saved};state='restorable';}}catch{state='sign-in-required';}
  const status=()=>({state,me:identity,workspace:selected,deviceOrgId:licensing?.status().orgId??null,installationId:licensing?.status().installationId??null});
  const current=epoch=>P.check(epoch===generation,'Account operation cancelled');
  const save=()=>{if(session?.refreshToken)store.write({issuer:config.issuer,clientId:config.clientId,refreshToken:session.refreshToken,subject:session.subject});else fs.rmSync(file,{force:true});};
  async function provider(){
    if(!discovery)discovery=(async()=>{
      const oidc=await import('openid-client');
      const client=await oidc.discovery(new URL(config.issuer),config.clientId,{token_endpoint_auth_method:'none'},oidc.None(),{
        timeout:15,execute:[oidc.enableNonRepudiationChecks,...(allowLoopback?[oidc.allowInsecureRequests]:[])],
        [oidc.customFetch]:(input,options)=>{A.url(String(input),allowLoopback);return fetch(input,{...options,redirect:'error'});},
      });
      for(const name of ['authorization_endpoint','token_endpoint','jwks_uri'])A.url(client.serverMetadata()[name],allowLoopback);
      P.check(client.serverMetadata().supportsPKCE('S256'),'Identity provider must support PKCE S256');
      return {oidc,client};
    })().catch(e=>{discovery=null;throw e;});
    return discovery;
  }
  function accept(tokens,subject,epoch){
    current(epoch);P.check(tokens.token_type?.toLowerCase()==='bearer' && Number.isFinite(tokens.expires_in) && tokens.expires_in>0,'Invalid account token');
    A.text(tokens.access_token,32768);if(tokens.refresh_token)A.text(tokens.refresh_token,32768);
    const claims=tokens.claims();if(claims)P.check(claims.sub===subject,'Account subject changed');
    session={subject,accessToken:tokens.access_token,expiresAt:Date.now()+tokens.expires_in*1000,refreshToken:tokens.refresh_token??session?.refreshToken};save();
  }
  async function token(){
    P.check(session,'Sign in required');
    if(session.accessToken && session.expiresAt>Date.now()+30000)return session.accessToken;
    if(!refreshing){const epoch=generation,previous=session;refreshing=(async()=>{
      P.check(previous.refreshToken,'Sign in required');
      const {oidc,client}=await provider();
      // Retire before sending: a crash or an ambiguous network response must not reuse a rotated token.
      current(epoch);fs.rmSync(file,{force:true});session={...previous,refreshToken:undefined};
      try{const tokens=await oidc.refreshTokenGrant(client,previous.refreshToken,{resource:config.resource});accept(tokens,previous.subject,epoch);}
      catch(e){if(epoch===generation){session=null;identity=null;selected=null;state='sign-in-required';}throw e;}
      finally{if(epoch===generation)refreshing=null;}
    })();}
    await refreshing;P.check(session?.accessToken,'Sign in required');return session.accessToken;
  }
  async function request(route,body,extraHeaders={},limit=1024*1024){
    const epoch=generation,access=await token();current(epoch);
    const response=await fetch(config.apiUrl.replace(/\/$/,'')+route,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{Authorization:'Bearer '+access,...extraHeaders,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    current(epoch);
    if(response.status===401){session=null;identity=null;selected=null;state='sign-in-required';fs.rmSync(file,{force:true});}
    const chunks=[];let bytes=0;
    for await(const part of response.body){bytes+=part.length;P.check(bytes<=limit,'Account response too large');chunks.push(part);}
    current(epoch);
    const value=JSON.parse(Buffer.concat(chunks).toString());
    if(!response.ok)throw Object.assign(Error(typeof value.error==='string'?value.error:'Account service unavailable'),{accountStatus:response.status});return value;
  }
  async function refresh(){
    const epoch=generation;
    try{const value=A.me(await request('/v1/me'));current(epoch);P.check(value.subject===session.subject,'Account subject mismatch');identity=value;state='signed-in';
      if(selected && !identity.memberships.some(m=>m.orgId===selected.orgId && m.workspaceId===selected.workspaceId))selected=null;
      return status();
    }catch(error){if(epoch===generation && session){identity=null;selected=null;state='unavailable';}throw error;}
  }
  async function login(){
    P.check(!flow,'Sign-in already in progress');
    const epoch=++generation;session=null;identity=null;selected=null;refreshing=null;fs.rmSync(file,{force:true});state='signing-in';
    const marker={cancel:()=>{}};flow=marker;
    let server,timer;
    try{
      const {oidc,client}=await provider();current(epoch);
      const verifier=oidc.randomPKCECodeVerifier(),stateValue=oidc.randomState(),nonce=oidc.randomNonce();
      let resolve,reject,used=false;
      const callback=new Promise((ok,no)=>{resolve=ok;reject=no;});callback.catch(()=>{});
      marker.cancel=()=>reject(Error('Sign-in cancelled'));
      server=http.createServer((req,res)=>{
        res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'none'");
        try{
          const address=`127.0.0.1:${server.address().port}`;
          P.check(req.method==='GET' && req.socket.remoteAddress==='127.0.0.1' && req.headers.host===address && !used && req.url.length<8192);
          const received=new URL(req.url,`http://${address}`);
          P.check(received.pathname==='/callback' && received.searchParams.getAll('state').length===1 && received.searchParams.get('state')===stateValue);
          used=true;res.end('EXMO sign-in received. Return to the desktop application.');resolve(received);
        }catch{res.statusCode=400;res.end('Invalid sign-in callback.');}
      });
      server.requestTimeout=5000;server.headersTimeout=5000;
      await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});current(epoch);
      const redirect=`http://127.0.0.1:${server.address().port}/callback`;
      const authorization=oidc.buildAuthorizationUrl(client,{redirect_uri:redirect,scope:'openid profile offline_access exmo.account',resource:config.resource,
        code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256',state:stateValue,nonce,max_age:'600',prompt:'select_account'});
      timer=setTimeout(()=>reject(Error('Sign-in timed out')),loginTimeoutMs);
      await openExternal(authorization.href);current(epoch);
      const received=await callback;current(epoch);
      const tokens=await oidc.authorizationCodeGrant(client,received,{pkceCodeVerifier:verifier,expectedState:stateValue,expectedNonce:nonce,idTokenExpected:true,maxAge:600},{resource:config.resource});
      accept(tokens,tokens.claims().sub,epoch);await refresh();return status();
    }catch(error){if(epoch===generation){session=null;identity=null;selected=null;state='sign-in-required';fs.rmSync(file,{force:true});}throw error;}
    finally{clearTimeout(timer);server?.close();server?.closeAllConnections();if(flow===marker)flow=null;}
  }
  function logout(){
    const previous=session;++generation;flow?.cancel();flow=null;session=null;identity=null;selected=null;refreshing=null;state='signed-out';
    if(previous?.refreshToken)void provider().then(({oidc,client})=>oidc.tokenRevocation(client,previous.refreshToken,{token_type_hint:'refresh_token'})).catch(()=>{});
    fs.rmSync(file,{force:true});
    return status();
  }
  async function workspace(orgId,workspaceId){
    P.id(orgId);P.id(workspaceId);await refresh();
    P.check(identity.memberships.some(m=>m.orgId===orgId && m.workspaceId===workspaceId),'Workspace membership required');
    const bound=licensing?.status().orgId;P.check(!bound || bound===orgId,'Device belongs to another organization');
    selected={orgId,workspaceId};return status();
  }
  async function enroll(){
    P.check(selected && licensing?.enrollmentProof,'Select a workspace on a protected installation first');
    const epoch=generation,target={...selected};
    const challenge=A.challenge(await request('/v1/enrollments/challenge',target));
    P.check(challenge.orgId===target.orgId && challenge.workspaceId===target.workspaceId);
    const proof=await licensing.enrollmentProof(challenge);current(epoch);
    return request('/v1/enrollments',proof);
  }
  return {status,login,logout,refresh,workspace,enroll,
    async publicationRequest(route,body,binding){
      const S=require('../publication-protocol.cjs');S.scope(binding);
      P.check(/^\/v1\/publications\/[a-z-]+$/.test(route));
      const epoch=generation;await token();current(epoch);
      P.check(session?.subject===binding.subject,'Publication account changed');
      P.check(selected?.orgId===binding.orgId && selected?.workspaceId===binding.workspaceId,'Publication workspace changed');
      P.check(status().installationId===binding.installationId && status().deviceOrgId===binding.orgId,'Device belongs to another organization');
      const claims={...binding,route,bodyDigest:S.digest(body),nonce:require('node:crypto').randomBytes(32).toString('base64url'),at:Math.floor(Date.now()/1000)};
      const signature=await licensing.publicationProof(claims);current(epoch);
      P.check(selected?.orgId===binding.orgId && selected?.workspaceId===binding.workspaceId,'Publication workspace changed');
      const proof=Buffer.from(JSON.stringify({claims,signature})).toString('base64url');
      return request(route,body,{'X-EXMO-Publication-Proof':proof},2*1024*1024);
    },
    enrollments:()=>request('/v1/enrollments'),
    decide:(id,revision,keyPolicy,decision)=>{P.id(id);P.integer(revision);P.check(['required','internal-exempt'].includes(keyPolicy) && ['approve','reject'].includes(decision));return request('/v1/enrollments/'+id+'/decision',{revision,keyPolicy,decision});},
    solution:(id,revision,solutionId,state)=>{P.id(id);P.integer(revision);require('./license-v3.cjs').name(solutionId);P.check(['active','suspended'].includes(state));return request('/v1/enrollments/'+id+'/solution',{revision,solutionId,state});},
    async activate(id){P.id(id);const epoch=generation;P.check(licensing,'Protected installation required');const value=await request('/v1/enrollments/'+id+'/activation');current(epoch);
      P.check(selected?.orgId===value.orgId,'Select the approved organization');await licensing.activate(value.activation);return status();},
    close(){++generation;flow?.cancel();flow=null;identity=null;selected=null;session=null;},
  };
}
module.exports={openAccount};
