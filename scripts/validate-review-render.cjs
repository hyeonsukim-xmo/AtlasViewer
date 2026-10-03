// Component rendering regression without a GPU. Hooks and image decoding are
// controlled fixtures; this does not replace a real browser layout test.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'desktop/ui/thigh-workspace.tsx'), 'utf8');
const names = [...source.matchAll(/const \[([^,]+),[^\]]+\] = useState/g)].map(match=>match[1]);
const compiled = ts.transpileModule(source, {compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const files = Array.from({length:118},(_,i)=>({id:String(i),name:'Fixture '+i,analysis:'ct',ready:i<116,warnings:[],confirmation:'hu',metadata:{caseName:'Fixture '+i,size:[512,512,185],spacing:[1,1,1]}}));
function render(page, selection=files.slice(0,116).map(f=>f.id), allConfirmed=false, job=null) {
  let hook = 0;
  const state = {files,selected:selection,confirmed:allConfirmed?selection:['0'],step:'review',reviewPage:page,model:{estimationAvailable:true},job};
  const module = {exports:{}};
  const context = {module,exports:module.exports,require: name => {
    if(name==='react') return {...React,useEffect:()=>{},useRef: value=>({current:value}),useState: initial=>{
      const key=names[hook++];return [Object.hasOwn(state,key)?state[key]:(typeof initial==='function'?initial():initial),()=>{}];
    }};
    if(name==='react/jsx-runtime')return require(name);
    if(name==='./language')return {useLanguage:()=> 'ko',localeTag:()=> 'ko-KR',t:(text,values={})=>text?.replace(/\{\{(\w+)\}\}/g,(_,key)=>values[key])||''};
    if(name==='./image-preview')return {default:props=>React.createElement('div',{'data-preview':props.id})};
    if(name==='./result-view')return {default:()=>null};
    if(name==='./imaging')return {number:value=>String(value),unwrap:reply=>reply.value};
    throw new Error('Unexpected module '+name);
  }};
  vm.runInNewContext(compiled,context);
  return renderToStaticMarkup(React.createElement(module.exports.default,{analysis:'ct',name:'CT',visible:true,onBack:()=>{}}));
}
for(const page of [0,1,15,28,29]) {
  const html=render(page);
  assert.equal((html.match(/data-preview=/g)||[]).length,4);
  const start=Math.min(page,28)*4;
  for(let i=start;i<start+4;i++)assert.ok(html.includes('data-preview="'+i+'"'));
  assert.ok(html.includes('검토 대상 116개 · 지금 실행 가능한 영상 1개'));
  assert.ok(!html.includes('현재 페이지 영상만 선택'));
  assert.ok(html.includes('분석 가능한 영상 전체 선택'));
}
assert.equal((render(28,['0','1']).match(/data-preview=/g)||[]).length,2);
assert.equal((render(0,[]).match(/data-preview=/g)||[]).length,0);
assert.ok(render(0).includes('checked=""'));
const selection = files.slice(0,116).map(file=>file.id);
const runButton = html => html.match(/<button[^>]*>Segmentation 실행 \(\d+개\)<\/button>/)[0];
assert.ok(!runButton(render(0,selection)).includes('disabled'));
assert.ok(runButton(render(0,selection)).includes('(1개)'));
assert.ok(render(0,selection).includes('나머지 115개는 이번 실행에서 제외'));
assert.ok(runButton(render(0,['1','2'])).includes('disabled'));
assert.ok(runButton(render(0,[])).includes('disabled'));
assert.ok(runButton(render(0,selection,true)).includes('(116개)'));
assert.ok(!runButton(render(0,selection,true)).includes('disabled'), 'All 116 confirmed selections can run together');
const runningJob = {id:'test',analysis:'ct',state:'running',current:'Fixture',stage:'원본 좌표 복원',progress:100,completed:[],failed:[],total:116};
let html = render(0,selection,true,runningJob);
assert.match(html, /<progress aria-label="전체 배치 진행률" max="116" value="0"/);
assert.ok(html.includes('현재 단계 100% · 전체 완료 아님'));
html = render(0,selection,true,{...runningJob,stage:'결과 측정·저장·검증',progress:null,completed:[{}],failed:[{}]});
assert.match(html, /<progress aria-label="전체 배치 진행률" max="116" value="2"/);
assert.ok(html.includes('전체 처리 2 / 116 · 성공 1 · 실패 1'));
assert.ok(html.includes('현재 단계 처리 중 · 전체 완료 아님'));
const css=fs.readFileSync(path.join(root,'desktop/ui/workspace.css'),'utf8');
html = render(0,selection,true,{...runningJob,active:[
  {id:'1',name:'CPU case one',lane:'cpu',stage:'원본 좌표 복원',progress:30},
  {id:'2',name:'GPU case two',lane:'gpu',stage:'Segmentation',progress:40},
]});
assert.ok(html.includes('CPU · 원본 좌표 복원 30% · CPU case one'));
assert.ok(html.includes('GPU · Segmentation 40% · GPU case two'));
assert.match(html,/class="task-stage-progress"[^>]*max="100" value="30"/);
assert.match(html,/class="task-stage-progress"[^>]*max="100" value="40"/);
assert.match(html,/<progress aria-label="전체 배치 진행률" max="116" value="0"/);
html = render(0,selection,true,{...runningJob,active:[
  {id:'1',name:'Saving',lane:'cpu',stage:'분할 결과 파일 저장',progress:null},
  {id:'2',name:'Waiting',lane:'waiting',stage:'메모리 확보 대기',progress:null},
]});
assert.equal((html.match(/class="task-stage-indeterminate"/g)||[]).length,1);
assert.ok(html.includes('대기 중 · 아직 시작하지 않았습니다'));
assert.ok(!html.includes('aria-valuenow'));
assert.match(css,/\.analysis-status progress::\-webkit-progress-value[^}]*#4ade80/);
assert.match(css,/\.review-grid\s*\{[^}]*grid-auto-rows:\s*max-content/s);
assert.match(css,/\.review-case\s*\{[^}]*min-height:\s*440px/s);
console.log('PASS: 116 selections render four previews; first/next/last/clamped/empty pages, confirmation and non-collapsing CSS rules');
