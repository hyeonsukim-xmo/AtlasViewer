const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve('dist-viewer'),files=fs.readdirSync(root,{recursive:true}).filter(f=>fs.statSync(path.join(root,f)).isFile());
assert.ok(files.includes('index.html'));
assert.ok(files.every(f=>f==='index.html'||/^assets[\\/][\w.-]+\.(js|css|woff2)$/.test(f)),'Viewer must contain only its isolated UI assets');
const js=files.filter(f=>f.endsWith('.js')).map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n');
for(const forbidden of ['exmoDesktop','chooseFiles','resultPreview','syncEnqueue','EXMO_VIEWER_CLIENT_SECRET','publicationSource'])assert.ok(!js.includes(forbidden),'Desktop/private capability bundled: '+forbidden);
console.log('Viewer build: no Desktop IPC, local input, publication operations, model or Mask assets.');
