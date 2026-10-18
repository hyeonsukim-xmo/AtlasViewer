const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const F=require('./publication-test-fixtures.cjs'),V=require('./viewer-test-fixtures.cjs');
const S=require('../../desktop/publication-protocol.cjs'),PNG=require('../../desktop/publication-image.cjs');
const {encryptArtifact}=require('../../desktop/publication-crypto.cjs');

test('BFF OIDC session, CSRF, workspace ACL and read-only boundary without a PC or dongle',async t=>{
  const f=await F.fixture(t),v=await V.startViewer(t,f),b=V.browser(v.base);
  f.accounts.membership('reader','hospital-a','research','Research',['reviewer']);f.idp.settings.subject='reader';
  assert.equal((await b.request('/api/results')).status,401);
  const anon=await b.session(),initial=b.cookie;
  assert.equal((await b.request('/auth/login',{}, {'X-EXMO-CSRF':'forged'})).status,403);
  assert.equal((await b.request('/auth/login',{}, {Origin:'https://evil.invalid'})).status,403);
  assert.equal(await new Promise((resolve,reject)=>{const req=require('node:http').get(v.base+'/api/session',{headers:{Host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);}),403);
  const state=await b.login();assert.equal(state.subject,'reader');assert.notEqual(initial,b.cookie);assert.notEqual(anon.csrf,state.csrf);
  assert.equal(f.authority.db.prepare('SELECT COUNT(*) AS n FROM account_enrollments WHERE subject=?').get('reader').n,0);
  assert.equal((await b.request('/api/workspace',{orgId:'hospital-b',workspaceId:'research'})).status,403);
  await b.workspace();assert.equal((await b.request('/api/results')).status,200);
  for(const route of ['/v1/publications/begin','/v1/enrollments','/api/delete','/api/run','/api/results/anything/mask'])assert.ok([404,400].includes((await b.request(route,route.includes('mask')?undefined:{})).status),route);
  const status=await b.request('/api/session'),serialized=JSON.stringify(await status.json());
  assert.ok(!/access_token|refresh_token|installationId|privateKey/.test(serialized));assert.match(status.headers.get('set-cookie')??'',/^$/);
  assert.match(status.headers.get('cache-control'),/no-store/);assert.match(status.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  f.accounts.membership('reader','hospital-a','research','Research',[]);assert.equal((await b.request('/api/results')).status,403);
  assert.equal((await b.session()).workspace,null);
  assert.equal((await b.request('/auth/logout',{})).status,200);assert.equal((await b.request('/api/results')).status,401);
  f.idp.settings.badNonce=true;await assert.rejects(b.login());f.idp.settings.badNonce=false;
  const old=await b.session();assert.equal(old.signedIn,false);
  const auth=await (await b.request('/auth/login',{})).json(),redirect=await fetch(auth.location,{redirect:'manual'}),url=new URL(redirect.headers.get('location'));
  const forged=new URL(url);forged.searchParams.set('state','forged');assert.equal((await b.request(forged.pathname+forged.search)).status,400);
  assert.equal((await b.request(url.pathname+url.search)).status,303);assert.equal((await b.request(url.pathname+url.search)).status,400);
  f.idp.settings.expiresIn=10;const refreshes=f.idp.settings.refreshes;await b.login();assert.ok(f.idp.settings.refreshes>refreshes,'BFF rotates a nearly expired token');
  const refreshToken=f.idp.settings.issued.at(-1);await fetch(f.idp.base+'/revoke',{method:'POST',body:new URLSearchParams({token:refreshToken})});
  assert.equal((await b.request('/api/session')).status,401,'failed renewal destroys the session');assert.equal((await b.session()).signedIn,false);
});

test('verified display assets: exact hash, no Mask/identity, stale scope/revision, revocation and logout',async t=>{
  const f=await F.fixture(t);await f.rpc('approve-origin',{originStoreId:f.source.identity.originStoreId});
  const a=await F.attempt(f),published=await F.commit(f,a),mesh=fs.readFileSync(F.meshFile(f.root));
  const png=PNG.encode({width:1000,height:800,pixels:crypto.randomBytes(1000*800*3)});let revision=0;
  for(const [kind,bytes]of [['mesh',mesh],['overlay',png]]){
    const attemptId=crypto.randomUUID(),dir=path.join(f.root,attemptId);fs.mkdirSync(dir);
    const chunks=[];for(let i=0;i<bytes.length;i+=S.CHUNK)chunks.push(bytes.subarray(i,i+S.CHUNK));
    const artifact=await encryptArtifact(chunks,kind,dir,f.scope,a.manifest.content.identity,attemptId,f.config.meshPublicKey);
    const overlay={width:1000,height:800,capture:{view:'axial',index:0,count:130,window:'soft',opacity:0.45,classIds:null,side:'all',orientation:['A','P','R','L']},privacyReview:{policy:'exmo-no-identifiers-v1',sha256:artifact.sha256,permittedIdentifiers:'none',redacted:true,subject:f.scope.subject,reviewedAt:Math.floor(Date.now()/1000)}};
    const result=await F.commit(f,{dir,manifest:{...a.manifest,attemptId,artifact,attachmentRevision:revision,...(kind==='overlay'?{overlay}:{})}});revision=result.attachmentRevision;
  }
  f.accounts.membership('reader','hospital-a','research','Research',['reviewer']);f.idp.settings.subject='reader';
  const v=await V.startViewer(t,f),b=V.browser(v.base);await b.login();await b.workspace();
  const rows=await (await b.request('/api/results')).json();assert.equal(rows.length,1);
  const detail=await (await b.request('/api/results/'+published.resultId)).json();
  assert.equal(detail.content.mask,undefined);assert.equal(detail.content.identity,undefined);assert.ok(!JSON.stringify(detail).includes('PRIVATE PATIENT'));
  for(const [url,bytes] of [[detail.meshUrl,mesh],[detail.overlay.url,png]]){const response=await b.request(url);assert.equal(response.status,200);assert.equal(S.hash(Buffer.from(await response.arrayBuffer())),S.hash(bytes));}
  const interrupted=await b.request(detail.overlay.url);await interrupted.body.cancel();assert.equal((await b.request('/api/results')).status,200,'closed asset connection must not block subsequent requests');
  assert.equal((await b.request(detail.meshUrl.replace(/sha256=[a-f0-9]+/,'sha256='+'a'.repeat(64)))).status,409);
  await b.workspace();assert.equal((await b.request(detail.meshUrl)).status,409,'previous workspace handle must expire even on reselection');
  const updated=await (await b.request('/api/results/'+published.resultId)).json();
  f.accounts.membership('reader','hospital-a','research','Research',[]);assert.equal((await b.request(updated.overlay.url)).status,403);
  f.accounts.membership('reader','hospital-a','research','Research',['reviewer']);await b.request('/auth/logout',{});assert.equal((await b.request(updated.meshUrl)).status,401);
  await b.login();await b.workspace();await f.rpc('delete',{resultId:published.resultId,revision});
  assert.equal((await b.request('/api/results/'+published.resultId)).status,404);
  assert.ok(f.service.db.prepare("SELECT 1 FROM result_audit WHERE actor='reader' AND event='overlay-read'").get());
});
