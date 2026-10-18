const http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const {ViewerResults,createViewer}=require('./viewer-server.cjs');
const A=require('./account-test-fixtures.cjs');
async function startViewer(t,f){
  const reserved=http.createServer();await new Promise(r=>reserved.listen(0,'127.0.0.1',r));const port=reserved.address().port;await new Promise(r=>reserved.close(r));
  const base='http://127.0.0.1:'+port,service=new ViewerResults(f.root,f.authority.db,f.config);A.cleanup(t,()=>service.close());
  const server=await createViewer({service,config:{origin:base,issuer:f.idp.base,clientId:'desktop',resource:f.idp.base+'/api',jwksUrl:f.idp.base+'/jwks'},staticRoot:path.resolve('dist-viewer'),allowLoopback:true});
  await new Promise(r=>server.listen(port,'127.0.0.1',r));A.cleanup(t,()=>{server.closeAllConnections();server.close();});
  return {base,server,service};
}
function browser(base){
  let cookie='',state;
  async function request(route,body,headers={}){
    const response=await fetch(base+route,{redirect:'manual',method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(state?.scopeKey?{'X-EXMO-Workspace':state.scopeKey}:{}),...(body===undefined?{}:{Origin:base,'Content-Type':'application/json','X-EXMO-CSRF':state?.csrf??''}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return response;
  }
  async function session(){const r=await request('/api/session');assert.equal(r.status,200);state=await r.json();return state;}
  async function login(){await session();const r=await request('/auth/login',{});assert.equal(r.status,200);const {location}=await r.json();const auth=await fetch(location,{redirect:'manual'});assert.equal(auth.status,302);const callback=new URL(auth.headers.get('location'));const result=await request(callback.pathname+callback.search);assert.equal(result.status,303,await result.text());const value=await session();assert.equal(value.signedIn,true);return value;}
  async function workspace(orgId='hospital-a',workspaceId='research'){assert.equal((await request('/api/workspace',{orgId,workspaceId})).status,200);return session();}
  return {request,session,login,workspace,get cookie(){return cookie;},get state(){return state;}};
}
module.exports={startViewer,browser};
