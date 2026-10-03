const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const asar=require('@electron/asar');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'outputs/pipeline-update-check');fs.mkdirSync(output,{recursive:true});
const data=path.join(process.env.APPDATA,'EXMO Atlas/imaging');
const installation=path.join(process.env.LOCALAPPDATA,'Programs/exmo-segmentation-atlas/resources');
const hash=file=>fs.existsSync(file)?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
const snapshot={library:hash(path.join(data,'library.json')),results:{}};
for(const id of fs.readdirSync(path.join(data,'runs'))) {
  const f=path.join(data,'runs',id,'published.json');if(fs.existsSync(f))snapshot.results[id]=hash(f);
}
const before=path.join(output,'before.json');
const version=JSON.parse(asar.extractFile(path.join(installation,'app.asar'),'package.json')).version;
if(process.argv.includes('--before')) {
  fs.writeFileSync(before,JSON.stringify(snapshot,null,2));
  console.log(JSON.stringify({snapshotSaved:true,version,completedResults:Object.keys(snapshot.results).length}));
} else {
  assert.deepEqual(snapshot,JSON.parse(fs.readFileSync(before,'utf8')),'Existing library and results must be unchanged');
  assert.equal(version,JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version);
  for(const name of ['imaging.cjs','analysis-pipeline.cjs','analysis-worker.cjs'])
    assert.ok(asar.extractFile(path.join(installation,'app.asar'),'desktop/'+name).equals(fs.readFileSync(path.join(root,'desktop',name))));
  for(const name of ['model-runner.py','model-service.py','imaging-worker.py'])
    assert.equal(hash(path.join(installation,'imaging',name)),hash(path.join(root,'desktop',name)));
  for(const name of ['index.html',...fs.readdirSync(path.join(root,'dist-desktop/assets')).filter(name=>/\.(js|css)$/.test(name)).map(name=>'assets/'+name)])
    assert.ok(asar.extractFile(path.join(installation,'app.asar'),path.join('dist-desktop',name)).equals(fs.readFileSync(path.join(root,'dist-desktop',name))),name);
  const report={passed:true,installedVersion:version,libraryAndResultsUnchanged:true,
    images:JSON.parse(fs.readFileSync(path.join(data,'library.json'),'utf8')).length,completedResults:Object.keys(snapshot.results).length};
  fs.writeFileSync(path.join(output,'installed.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
