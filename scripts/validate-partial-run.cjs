const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../desktop/ui/thigh-workspace.tsx'),'utf8');
const ts=require('typescript');
const logic=source.slice(source.indexOf('  const runnable ='),source.indexOf('  const filtered ='));
const run=source.slice(source.indexOf('  async function run()'),source.indexOf('  async function clear()'));
const compile=code=>ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
(async()=>{
  const all=Array.from({length:116},(_,id)=>({id:String(id),ready:true,confirmation:'hu'}));
  for(const fixture of [
    {chosen:all,confirmed:['0'],expected:['0']},
    {chosen:all,confirmed:all.map(f=>f.id),expected:all.map(f=>f.id)},
    {chosen:all,confirmed:[],expected:[]},
    {chosen:all.slice(2,4),confirmed:['0','2'],expected:['2']},
    {chosen:[{id:'bad',ready:false,confirmation:'hu'}],confirmed:['bad'],expected:[]},
    {chosen:[{id:'ap',ready:true,confirmation:null}],confirmed:[],expected:['ap']},
  ]) {
    const calls=[];
    const context={...fixture,busy:false,analysis:'ct',device:'cuda:0',
      setChanging(){},setError(message){assert.equal(message,'')},setJob(){},unwrap:x=>x,
      window:{exmoDesktop:{run:async(...args)=>{calls.push(args);return {};}}}};
    vm.createContext(context);vm.runInContext(compile(logic+run),context);
    await context.run();
    assert.equal(calls.length,fixture.expected.length?1:0);
    if(calls.length)assert.deepEqual(Array.from(calls[0][1]),fixture.expected);
  }
  console.log('PASS: real run handler submits exactly 1/116/subset/implicit-confirmation IDs; zero/unready inputs never run');
})().catch(error=>{console.error(error);process.exitCode=1});
