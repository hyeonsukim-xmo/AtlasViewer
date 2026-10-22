const {solutions}=require('../solutions.cjs');
function expiredSolutions(client){
  if(!client?.receipt)return [];
  // Only a signed contract expiry or an entitlement deadline permits deletion, never a lost lease.
  if(client.receipt.decision==='expired')return solutions.map(s=>s.id);
  const now=client.time();
  if(client.timeUntrusted)return [];
  return (client.receipt.entitlements??[]).filter(e=>e.validUntil!==null && now>=e.validUntil).map(e=>e.solutionId);
}
function openModelExpiry({licensing,installations}){
  let pending,closed=false;
  function sweep(){
    if(closed)return Promise.resolve();
    if(pending)return pending;
    pending=(async()=>{
      if(installations.status().busy)return;
      for(const solution of installations.status().solutions){
        if(closed || installations.status().busy)return;
        if((solution.installed || solution.canRollback) && licensing.expiredSolutions().includes(solution.solutionId))
          await installations.remove(solution.analysis);
      }
      // Pinned running jobs finish normally; their workers release the files at batch completion.
      await installations.collect();
    })().finally(()=>{pending=null;});
    return pending;
  }
  const timer=setInterval(()=>void sweep().catch(error=>console.error('Expired model cleanup failed:',error.message)),1000);
  timer.unref();
  return {sweep,async close(){closed=true;clearInterval(timer);await pending?.catch(()=>{});}};
}
module.exports={expiredSolutions,openModelExpiry};
