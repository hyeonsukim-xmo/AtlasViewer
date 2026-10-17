const fs=require('node:fs'),path=require('node:path');
const P=require('./license-protocol.cjs'),M=require('./model-package.cjs');
const {resolveSolution}=require('../solutions.cjs');
function scope(job){
  const analysis=job.analysis==='xray-classifier'?'xray':job.analysis;
  const s=resolveSolution(job.solutionId??analysis);
  P.check(s.analysis===analysis && (job.workflowId===undefined || job.workflowId===s.workflowId),'Execution solution mismatch');
  return {solutionId:s.id,workflowId:s.workflowId};
}
function binding(job,{engineRoot,scriptsRoot,issuer},capability,modelDigest=null){
  P.check(['analyze','classify','result-mutation'].includes(capability));
  const identity=scope(job),engine=M.modelId(job),variant=capability==='result-mutation'?job.variant:null;
  P.check(job.solutionId===identity.solutionId && job.workflowId===identity.workflowId,'Explicit execution identity required');
  P.check(capability==='classify' ? engine==='xray-classifier' : engine!=='xray-classifier');
  if(capability==='result-mutation')P.check((engine==='mri'?['raw','pp500','strong']:engine==='ct'?['raw']:[]).includes(variant));
  const signed=JSON.parse(fs.readFileSync(path.join(engineRoot,'payload.json'),'utf8'));P.fields(signed,['token']);
  M.verify(signed.token,issuer,'exmo-runtime-payload-v1');
  const files=fs.readdirSync(scriptsRoot).filter(n=>n.endsWith('.py')).sort().map(name=>{
    const file=path.join(scriptsRoot,name);P.check(!fs.lstatSync(file).isSymbolicLink() && fs.statSync(file).size<=16*1024**2);
    return {name,sha256:M.hash(fs.readFileSync(file))};
  });P.check(files.some(f=>f.name==='imaging-worker.py') && files.some(f=>f.name==='model-runner.py'));
  return {...identity,capability,engine,modelDigest,
    recipeDigest:M.hash(Buffer.from(JSON.stringify({schema:'exmo-execution-recipe-v1',engine,capability,variant,files}))),
    packageSetDigest:M.hash(Buffer.from(signed.token))};
}
module.exports={scope,binding};
