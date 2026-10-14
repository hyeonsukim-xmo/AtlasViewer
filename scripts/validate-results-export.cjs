const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const {exportResults}=require('../desktop/results-export.cjs');
const {createExportIdentities}=require('../desktop/export-identities.cjs');
const output=path.resolve(__dirname,'../outputs/results-export-check');fs.mkdirSync(output,{recursive:true});
const store=fs.mkdtempSync(path.join(output,'registry-')), registry=createExportIdentities(store);
const publications=Array.from({length:5},(_,i)=>({record:{id:`input-${i}`},summary:{id:`result-${i}`,analysis:'ct',metadata:{caseName:'=HYPERLINK("test")',studyDescription:'한글 & <study>',seriesDescription:'CT'},
 rows:[{id:'muscle',name:'Test muscle',label:1,group:'Muscles',count:100,value:12.345678901,fat:0,hu:null,entropy:0.25,components:1,present:true,
 sides:{left:{value:7,count:60,fat:0,hu:42,entropy:0.4},right:{value:5.345678901,count:40,fat:null,hu:40,entropy:null},unassigned:{value:0,count:0,fat:null,hu:null,entropy:null},differenceCm3:1.654321099,differencePercent:26.8,flags:[]}}],
 unit:'cm³',variant:'raw',createdAt:'2026-10-13T01:00:00Z',qc:{flags:['test flag'],missing:[],unexpected:[]}}}));
const sourceFor=(record,publication)=>({inputId:record.id,resultId:publication.summary.id,analysis:'ct',patientId:record.id==='input-0'?'000042':'',patientIssuer:'TEST',studyUid:`study-${record.id}`,seriesUid:`series-${record.id}`,studyDate:'20261013'});
(async()=>{
 const original=JSON.stringify(publications);
 const canceled=await exportResults(null,publications,{registry,sourceFor,language:'en',dialog:{showSaveDialog:async()=>({canceled:true})}});
 assert.equal(canceled.action,'cancel');assert.ok(!fs.existsSync(path.join(store,'export-identities.json')));
 const file=path.join(output,'fixture.xlsx');
 assert.deepEqual(await exportResults(null,publications,{registry,sourceFor,language:'en',dialog:{showSaveDialog:async()=>({filePath:file})}}),{action:'save',count:5});
 const data=JSON.parse(fs.readFileSync(path.join(store,'export-identities.json'),'utf8'));
 assert.equal(data.identities.length,5);assert.equal(data.exports.length,5);
 assert.equal(data.identities[0].patientId,'000042');assert.equal(data.exports[0].action,'excel');
 assert.equal((await registry.resolve(sourceFor(publications[1].record,publications[1]))).uuid,data.identities[1].uuid);
 assert.equal(JSON.stringify(publications),original);
 assert.match(await registry.csv(),/fixture.xlsx/);
 console.log('PASS: cancellation, five-case export, existing UUID reuse, identifiers, export history, immutable analysis values');
})().catch(error=>{console.error(error);process.exitCode=1;});
