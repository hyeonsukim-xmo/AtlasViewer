const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),engine=path.join(process.env.LOCALAPPDATA,'EXMO Atlas/engine');
const directory=fs.mkdtempSync(path.join(path.dirname(root),'sb-'));
const job=JSON.parse(fs.readFileSync(path.join(root,'outputs/ct-speed-validation/large-final/job.json'),'utf8'));
job.output=path.join(directory,'out');
fs.writeFileSync(path.join(directory,'job.json'),JSON.stringify(job));
console.log(JSON.stringify({directory}));
const started=performance.now(),events=[];
const child=cp.spawn(path.join(engine,'envs/ct/Scripts/python.exe'),['-X','utf8',path.join(root,'desktop/model-runner.py'),'--engine-root',engine,'--job',path.join(directory,'job.json')],
  {windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:'4',OPENBLAS_NUM_THREADS:'2'},stdio:['ignore','pipe','pipe']});
const log=fs.createWriteStream(path.join(directory,'private.log'));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
require('node:readline').createInterface({input:child.stdout}).on('line',line=>{
  try {const event=JSON.parse(line);if(!event.exmo)return;events.push(event);
    if(event.stage!=='inference_progress' && (event.current==null||event.current===event.total||event.current%100<8))console.log(JSON.stringify(event));
  }catch{}
});
child.once('close',code=>{log.end();const report={exitCode:code,seconds:(performance.now()-started)/1000,directory,events};
  fs.writeFileSync(path.join(directory,'timings.json'),JSON.stringify(report,null,2));process.exitCode=code||0;});
