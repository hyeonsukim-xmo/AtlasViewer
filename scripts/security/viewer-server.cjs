// Browser-only BFF: no publication writes, device enrollment, native Mask or model access.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const {pipeline}=require('node:stream');
const {DatabaseSync}=require('node:sqlite');
const {Results}=require('./results-server.cjs');
const {verifier}=require('./account-server.cjs');
const P=require('../../desktop/security/license-protocol.cjs'),A=require('../../desktop/security/account-protocol.cjs');
const S=require('../../desktop/publication-protocol.cjs');
const fail=(ok,status,code)=>{if(!ok)throw Object.assign(Error(code),{status,code});};
const random=()=>crypto.randomBytes(32).toString('base64url');
class ViewerResults extends Results {
  access(actor,scope,role='analyst') {
    fail(role==='read',403,'VIEWER_READ_ONLY');P.fields(scope,['orgId','workspaceId','subject']);P.id(scope.orgId);P.id(scope.workspaceId);
    fail(actor.sub===scope.subject && this.roles(actor,scope).some(r=>['analyst','reviewer','data-admin'].includes(r)),403,'PUBLICATION_PERMISSION');
  }
  memberships(actor) {
    return this.accounts.prepare('SELECT m.org,m.workspace,w.name,m.roles FROM account_members m JOIN account_workspaces w ON w.org=m.org AND w.id=m.workspace WHERE m.subject=? ORDER BY m.org,m.workspace LIMIT 200').all(actor.sub)
      .filter(r=>JSON.parse(r.roles).some(role=>['analyst','reviewer','data-admin'].includes(role)))
      .map(r=>({orgId:r.org,workspaceId:r.workspace,name:r.name}));
  }
}
async function createViewer({service,config,staticRoot,clientSecret,allowLoopback=false}) {
  P.fields(config,['origin','issuer','clientId','resource','jwksUrl']);
  for(const key of ['origin','issuer','resource','jwksUrl'])A.url(config[key],allowLoopback);A.text(config.clientId);
  const origin=new URL(config.origin);fail(origin.origin===config.origin,400,'VIEWER_ORIGIN');
  fail(allowLoopback || (origin.protocol==='https:' && typeof clientSecret==='string' && clientSecret.length>0),400,'VIEWER_CONFIDENTIAL_CLIENT_REQUIRED');
  const oidc=await import('openid-client');
  const client=await oidc.discovery(new URL(config.issuer),config.clientId,undefined,clientSecret?oidc.ClientSecretBasic(clientSecret):oidc.None(),{
    timeout:10,execute:[oidc.enableNonRepudiationChecks,...(allowLoopback?[oidc.allowInsecureRequests]:[])],
    [oidc.customFetch]:(input,options)=>{A.url(String(input),allowLoopback);return fetch(input,{...options,redirect:'error'});},
  });
  fail(client.serverMetadata().supportsPKCE('S256'),400,'VIEWER_PKCE_REQUIRED');
  for(const name of ['authorization_endpoint','token_endpoint','jwks_uri'])A.url(client.serverMetadata()[name],allowLoopback);
  const verify=await verifier({issuer:config.issuer,audience:config.resource,clientId:config.clientId,jwksUrl:config.jwksUrl},allowLoopback);
  const sessions=new Map(),secure=origin.protocol==='https:',cookieName=secure?'__Host-exmo-viewer':'exmo-viewer-test';
  const cookie=(res,id)=>res.setHeader('Set-Cookie',`${cookieName}=${id}; Path=/; HttpOnly; SameSite=Lax${secure?'; Secure':''}`);
  function live(s){return sessions.get(s.id)===s && s.created+8*3600000>Date.now() && s.touched+30*60000>Date.now();}
  function fresh(res){
    for(const s of sessions.values())if(!live(s))sessions.delete(s.id);
    fail(sessions.size<1000,503,'VIEWER_BUSY');
    const s={id:random(),csrf:random(),created:Date.now(),touched:Date.now(),tokens:null,workspace:null,scopeKey:null,flow:null,refreshing:null,generation:0};
    sessions.set(s.id,s);cookie(res,s.id);return s;
  }
  function session(req){
    const values=(req.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(cookieName+'='));
    const s=values.length===1?sessions.get(values[0].slice(cookieName.length+1)):null;
    if(s && !live(s)){sessions.delete(s.id);return null;}if(s)s.touched=Date.now();return s;
  }
  async function accept(s,tokens,subject,generation){
    fail(tokens.token_type?.toLowerCase()==='bearer' && Number.isFinite(tokens.expires_in) && tokens.expires_in>0,401,'SIGN_IN_REQUIRED');
    const actor=await verify(tokens.access_token);fail(actor.sub===subject && (!tokens.claims() || tokens.claims().sub===subject) && live(s) && generation===s.generation,401,'SIGN_IN_REQUIRED');
    s.tokens={access:tokens.access_token,refresh:tokens.refresh_token,subject,expires:Date.now()+tokens.expires_in*1000};return actor;
  }
  async function actor(s){
    fail(s && live(s) && s.tokens,401,'SIGN_IN_REQUIRED');
    try{
      if(s.tokens.expires<Date.now()+30000){
        if(!s.refreshing)s.refreshing=(async()=>{
          const previous=s.tokens,generation=s.generation;fail(previous.refresh,401,'SIGN_IN_REQUIRED');s.tokens={...previous,refresh:undefined};
          const tokens=await oidc.refreshTokenGrant(client,previous.refresh,{resource:config.resource});
          return accept(s,tokens,previous.subject,generation);
        })().finally(()=>{s.refreshing=null;});
        await s.refreshing;
      }
      const value=await verify(s.tokens.access);fail(live(s),401,'SIGN_IN_REQUIRED');return value;
    }catch{sessions.delete(s.id);throw Object.assign(Error('SIGN_IN_REQUIRED'),{status:401});}
  }
  function scope(s,user,key){
    fail(s.workspace && key===s.scopeKey,409,'VIEWER_WORKSPACE_CHANGED');
    const value={...s.workspace,subject:user.sub};service.access(user,value,'read');return value;
  }
  async function body(req,s){
    fail(req.headers.origin===config.origin && req.headers['x-exmo-csrf']===s.csrf,403,'VIEWER_CSRF');
    const size=Number(req.headers['content-length']);fail(req.headers['content-type']==='application/json' && !req.headers['transfer-encoding'] && Number.isInteger(size) && size>0 && size<=8192,400,'VIEWER_REQUEST');
    const chunks=[];let bytes=0;for await(const part of req){bytes+=part.length;fail(bytes<=size,400,'VIEWER_REQUEST');chunks.push(part);}fail(bytes===size,400,'VIEWER_REQUEST');
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  const json=(res,value)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; worker-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if(secure)res.setHeader('Strict-Transport-Security','max-age=31536000');
    try{
      fail(req.socket.remoteAddress==='127.0.0.1' && req.headers.host===origin.host,403,'VIEWER_HOST');
      fail(!req.headers.origin || req.headers.origin===config.origin,403,'VIEWER_ORIGIN');
      fail(!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site']!=='cross-site' || req.url.startsWith('/auth/callback?'),403,'VIEWER_ORIGIN');
      fail(['GET','POST'].includes(req.method) && req.url.length<=8192,404,'NOT_FOUND');
      const url=new URL(req.url,config.origin);let s=session(req);
      if(req.method==='GET' && url.pathname==='/auth/callback'){
        fail(s?.flow && s.flow.expires>Date.now() && url.searchParams.getAll('state').length===1 && url.searchParams.get('state')===s.flow.state,400,'VIEWER_CALLBACK');
        const flow=s.flow;s.flow=null;
        try{
          const tokens=await oidc.authorizationCodeGrant(client,url,{pkceCodeVerifier:flow.verifier,expectedState:flow.state,expectedNonce:flow.nonce,idTokenExpected:true},{resource:config.resource});
          await accept(s,tokens,tokens.claims().sub,flow.generation);
        }catch{sessions.delete(s.id);cookie(res,'');res.writeHead(303,{Location:'/?auth=failed'});return res.end();}
        sessions.delete(s.id);s.id=random();s.csrf=random();s.workspace=null;s.scopeKey=null;sessions.set(s.id,s);cookie(res,s.id);
        res.writeHead(303,{Location:'/'});return res.end();
      }
      if(req.method==='GET' && url.pathname==='/api/session'){
        s??=fresh(res);
        const user=s.tokens?await actor(s):null,memberships=user?service.memberships(user):[];
        if(s.workspace && !memberships.some(m=>m.orgId===s.workspace.orgId && m.workspaceId===s.workspace.workspaceId)){s.workspace=null;s.scopeKey=null;}
        return json(res,{signedIn:!!user,csrf:s.csrf,subject:user?.sub??null,memberships,workspace:s.workspace,scopeKey:s.scopeKey});
      }
      if(req.method==='POST'){
        fail(s,401,'SIGN_IN_REQUIRED');const value=await body(req,s);
        if(url.pathname==='/auth/login'){
          P.fields(value,[]);s.tokens=null;s.workspace=null;s.scopeKey=null;s.generation++;
          s.flow={state:oidc.randomState(),nonce:oidc.randomNonce(),verifier:oidc.randomPKCECodeVerifier(),expires:Date.now()+300000,generation:s.generation};
          const location=oidc.buildAuthorizationUrl(client,{redirect_uri:config.origin+'/auth/callback',scope:'openid profile offline_access exmo.account',resource:config.resource,
            code_challenge:await oidc.calculatePKCECodeChallenge(s.flow.verifier),code_challenge_method:'S256',state:s.flow.state,nonce:s.flow.nonce,prompt:'select_account'});
          return json(res,{location:location.href});
        }
        if(url.pathname==='/auth/logout'){
          P.fields(value,[]);sessions.delete(s.id);cookie(res,'');res.setHeader('Clear-Site-Data','"cache", "storage"');
          if(s.tokens?.refresh)void oidc.tokenRevocation(client,s.tokens.refresh,{token_type_hint:'refresh_token'}).catch(()=>{});
          return json(res,{signedOut:true});
        }
        if(url.pathname==='/api/workspace'){
          P.fields(value,['orgId','workspaceId']);P.id(value.orgId);P.id(value.workspaceId);const user=await actor(s);
          service.access(user,{...value,subject:user.sub},'read');s.workspace=value;s.scopeKey=random();return json(res,{scopeKey:s.scopeKey});
        }
        fail(false,404,'NOT_FOUND');
      }
      if(url.pathname.startsWith('/api/')){
        const user=await actor(s),binding=scope(s,user,req.headers['x-exmo-workspace']??url.searchParams.get('scope'));
        if(url.pathname==='/api/results')return json(res,service.list(user,binding));
        const match=/^\/api\/results\/([A-Za-z0-9_-]{1,80})(?:\/(mesh|overlay))?$/.exec(url.pathname);fail(match,404,'NOT_FOUND');
        const value=service.read(user,binding,match[1]);S.content(value.analysis,true);
        if(match[2]){
          const kind=match[2],asset=value[kind];fail(asset && String(value.attachmentRevision)===url.searchParams.get('revision') && asset.sha256===url.searchParams.get('sha256'),409,'PUBLICATION_ATTACHMENT_CONFLICT');
          fail(asset.bytes>0 && asset.bytes<=(kind==='mesh'?128:16)*1024*1024,400,'PUBLICATION_ARTIFACT_INVALID');
          res.setHeader('Content-Type',kind==='mesh'?'model/gltf-binary':'image/png');res.setHeader('Content-Length',asset.bytes);
          const hash=crypto.createHash('sha256');
          for(let index=0;index<Math.ceil(asset.bytes/S.CHUNK);index++){
            fail(live(s),401,'SIGN_IN_REQUIRED');scope(s,await actor(s),url.searchParams.get('scope'));
            const part=service.displayPart(user,binding,{resultId:value.resultId,revision:value.attachmentRevision,sha256:asset.sha256,index},kind),bytes=Buffer.from(part.data,'base64');hash.update(bytes);
            if(index===Math.ceil(asset.bytes/S.CHUNK)-1)fail(hash.digest('hex')===asset.sha256,503,'PUBLICATION_ARTIFACT_INVALID');
            if(res.destroyed)return;
            if(!res.write(bytes))await new Promise(resolve=>{
              const done=()=>{res.off('drain',done);res.off('close',done);resolve();};
              res.once('drain',done);res.once('close',done);if(res.destroyed)done();
            });
            await new Promise(resolve=>setImmediate(resolve));
          }
          return res.end();
        }
        const assetUrl=kind=>{const asset=value[kind];return asset?`/api/results/${value.resultId}/${kind}?${new URLSearchParams({scope:s.scopeKey,revision:String(value.attachmentRevision),sha256:asset.sha256})}`:null;};
        return json(res,{...service.describe(service.result(user,binding,value.resultId)),content:value.analysis,meshBytes:value.mesh?.bytes??null,meshUrl:assetUrl('mesh'),overlay:value.overlay?{...S.pick(value.overlay,['width','height','capture','privacyReview']),url:assetUrl('overlay')}:null});
      }
      // Serve only the isolated Viewer build; never fall back to the repo/public or Desktop roots.
      fail(url.pathname==='/' || /^\/assets\/[A-Za-z0-9_.-]+\.(js|css|woff2)$/.test(url.pathname),404,'NOT_FOUND');
      const file=path.resolve(staticRoot,url.pathname==='/'?'index.html':'.'+url.pathname),root=fs.realpathSync(staticRoot);
      fail(fs.realpathSync(file).startsWith(root+path.sep),404,'NOT_FOUND');
      const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'};
      res.setHeader('Content-Type',mime[path.extname(file)]);pipeline(fs.createReadStream(file),res,()=>{});
    }catch(e){
      if(res.headersSent){res.destroy();return;}
      res.statusCode=e.status??400;json(res,{error:e.code??(e.status?e.message:'VIEWER_REQUEST')});
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.setTimeout(30000,s=>s.destroy());
  server.on('close',()=>sessions.clear());return server;
}
async function main([resultRoot,accountRoot,resultConfig,viewerConfig,staticRoot,port]){
  P.integer(Number(port));fail(Number(port)>=1024 && Number(port)<=65535,400,'VIEWER_PORT');
  const config=JSON.parse(fs.readFileSync(viewerConfig)),db=new DatabaseSync(path.join(accountRoot,'authority.sqlite'),{readOnly:true});
  fail(db.prepare('SELECT issuer FROM account_issuer').get()?.issuer===config.issuer,400,'VIEWER_ACCOUNT_ISSUER_MISMATCH');
  const service=new ViewerResults(resultRoot,db,JSON.parse(fs.readFileSync(resultConfig)));
  const server=await createViewer({service,config,staticRoot,clientSecret:process.env.EXMO_VIEWER_CLIENT_SECRET});
  server.listen(Number(port),'127.0.0.1',()=>console.log('Read-only Viewer BFF ready on loopback.'));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>{service.close();db.close();}));
}
if(require.main===module)main(process.argv.slice(2)).catch(()=>{console.error('VIEWER_START_FAILED');process.exitCode=1;});
module.exports={ViewerResults,createViewer};
