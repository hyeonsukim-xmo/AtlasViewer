const path=require('node:path'),{spawnSync}=require('node:child_process');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const result=spawnSync(require('electron'),[path.join(__dirname,'validate-internal-electron.cjs'),...process.argv.slice(2)],
  {env,windowsHide:true,stdio:'inherit',timeout:300000});
if(result.error)console.error(result.error.message);
process.exitCode=result.status ?? 1;
