// Native Electron clipboard round-trip; only menu/dialog choices are mocked.
const {app,nativeImage,clipboard,ClipboardItem}=require('electron');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const output=path.resolve(__dirname,'../outputs/image-menu-check');fs.mkdirSync(output,{recursive:true});
let choice='save',cancel=false,items,options,clipboardFailure=false;
let originalClipboard;
const {createExportIdentities}=require('../desktop/export-identities.cjs');
const registry=createExportIdentities(fs.mkdtempSync(path.join(output,'registry-')));
const source={inputId:'fixture-input',resultId:'fixture-result',analysis:'ct',studyDate:'20261006',studyUid:'fixture-study',patientId:'000123',patientIssuer:'test'};
const target=path.join(output,'snapshot.png');
const mock={nativeImage,Menu:{buildFromTemplate(template){items=template;return{popup({callback}){if(choice)template[choice==='save'?0:choice==='copy'?1:3].click();callback();}};}},
 dialog:{async showSaveDialog(_window,config){options=config;return{canceled:cancel,filePath:target};}},
 ClipboardItem, clipboard:{async write(items){
  if(clipboardFailure)throw Error('test clipboard failure');
  await clipboard.write(items);
 }}};
const moduleObject={exports:{}};
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../desktop/image-menu.cjs'),'utf8'),{
 require:name=>name==='electron'?mock:require(name),module:moduleObject,Buffer,Blob,
});
(async()=>{
 await app.whenReady();
 originalClipboard=await Promise.all((await clipboard.read()).map(async item=>
  new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type=>[type,await item.getType(type)]))))));
 const image=nativeImage.createFromBuffer(Buffer.from([30,80,180,255,80,140,220,255,20,50,120,255,40,90,180,255]),{width:2,height:2});
 const png=image.toPNG();assert.ok(png.length);
 const payload={image:'data:image/png;base64,'+png.toString('base64'),filename:'CT/20261006:axial.png',language:'en'};
 const showImageMenu=(window,payload)=>moduleObject.exports.showImageMenu(window,payload,{registry,source});
 assert.equal((await showImageMenu({},payload)).action,'save');
 assert.ok(fs.readFileSync(target).equals(png));
 assert.equal(options.defaultPath,'000123_CT_20261006_axial.png');
 assert.match(items[0].label,/PNG/);
 choice='copy';assert.equal((await showImageMenu({},payload)).action,'copy');
 const copied=(await clipboard.read()).find(item=>item.types.includes('image/png'));
 assert.ok(copied,'Windows clipboard contains image/png');
 const copiedBytes=Buffer.from(await (await copied.getType('image/png')).arrayBuffer());
 const decoded=nativeImage.createFromBuffer(copiedBytes);
 assert.deepEqual(decoded.getSize(),image.getSize());
 assert.ok(decoded.toBitmap().equals(image.toBitmap()),'Actual clipboard pixel parity');
 const beforeFailure=await registry.csv();
 clipboardFailure=true;
 await assert.rejects(showImageMenu({},payload),/test clipboard failure/);
 assert.equal(await registry.csv(),beforeFailure,'Failed copy must not add an export record');
 clipboardFailure=false;
 choice=null;assert.equal((await showImageMenu({},payload)).action,'cancel');
 choice='save';cancel=true;assert.equal((await showImageMenu({},payload)).action,'cancel');
 cancel=false;choice='mapping';assert.equal((await showImageMenu({},payload)).action,'mapping');
 assert.equal(options.defaultPath,'EXMO-identifier-mapping.csv');
 assert.match(fs.readFileSync(target,'utf8'),/000123/);
 await assert.rejects(showImageMenu({}, {...payload,image:'data:text/html;base64,AAAA'}));
 await assert.rejects(showImageMenu({}, {...payload,image:'data:image/png;base64,AAAA'}));
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,checks:['PNG byte parity','decoded clipboard image','safe suggested filename','menu cancellation','save cancellation','invalid payload rejection']}));
 console.log('PASS: PNG save parity, native Windows clipboard pixels/dimensions, failed-copy audit, filename, cancellations and invalid payloads');
 await clipboard.write(originalClipboard);app.quit();
})().catch(async error=>{console.error(error);if(originalClipboard)await clipboard.write(originalClipboard);app.exit(1);});
