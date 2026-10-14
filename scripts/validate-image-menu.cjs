// Electron image decoding with mocked menu/dialog/clipboard; writes only test output.
const {app,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const output=path.resolve(__dirname,'../outputs/image-menu-check');fs.mkdirSync(output,{recursive:true});
let choice='save',cancel=false,copied=null,items,options;
const {createExportIdentities}=require('../desktop/export-identities.cjs');
const registry=createExportIdentities(fs.mkdtempSync(path.join(output,'registry-')));
const source={inputId:'fixture-input',resultId:'fixture-result',analysis:'ct',studyDate:'20261006',studyUid:'fixture-study',patientId:'000123',patientIssuer:'test'};
const target=path.join(output,'snapshot.png');
const mock={nativeImage,Menu:{buildFromTemplate(template){items=template;return{popup({callback}){if(choice)template[choice==='save'?0:choice==='copy'?1:3].click();callback();}};}},
 dialog:{async showSaveDialog(_window,config){options=config;return{canceled:cancel,filePath:target};}},
 clipboard:{writeImage(image){copied=image;}}};
const moduleObject={exports:{}};
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../desktop/image-menu.cjs'),'utf8'),{
 require:name=>name==='electron'?mock:require(name),module:moduleObject,Buffer,
});
(async()=>{
 await app.whenReady();
 const image=nativeImage.createFromBuffer(Buffer.from([30,80,180,255,80,140,220,255,20,50,120,255,40,90,180,255]),{width:2,height:2});
 const png=image.toPNG();assert.ok(png.length);
 const payload={image:'data:image/png;base64,'+png.toString('base64'),filename:'CT/20261006:axial.png',language:'en'};
 const showImageMenu=(window,payload)=>moduleObject.exports.showImageMenu(window,payload,{registry,source});
 assert.equal((await showImageMenu({},payload)).action,'save');
 assert.ok(fs.readFileSync(target).equals(png));
 assert.equal(options.defaultPath,'000123_CT_20261006_axial.png');
 assert.match(items[0].label,/PNG/);
 choice='copy';assert.equal((await showImageMenu({},payload)).action,'copy');
 assert.ok(copied.toPNG().equals(png));
 choice=null;assert.equal((await showImageMenu({},payload)).action,'cancel');
 choice='save';cancel=true;assert.equal((await showImageMenu({},payload)).action,'cancel');
 cancel=false;choice='mapping';assert.equal((await showImageMenu({},payload)).action,'mapping');
 assert.equal(options.defaultPath,'EXMO-identifier-mapping.csv');
 assert.match(fs.readFileSync(target,'utf8'),/000123/);
 await assert.rejects(showImageMenu({}, {...payload,image:'data:text/html;base64,AAAA'}));
 await assert.rejects(showImageMenu({}, {...payload,image:'data:image/png;base64,AAAA'}));
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,checks:['PNG byte parity','decoded clipboard image','safe suggested filename','menu cancellation','save cancellation','invalid payload rejection']}));
 console.log('PASS: PNG save parity, clipboard copy, filename, cancellations and invalid payloads');app.quit();
})().catch(error=>{console.error(error);app.exit(1);});
