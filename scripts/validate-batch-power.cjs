// Main-process API check only: no window, renderer or application-data access.
const {app,powerSaveBlocker}=require('electron');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const directory=path.resolve(__dirname,'../outputs/batch-power-check');
fs.mkdirSync(directory,{recursive:true});
app.setPath('userData',directory);
app.disableHardwareAcceleration();
app.whenReady().then(()=>{
  const id=powerSaveBlocker.start('prevent-app-suspension');
  assert.equal(powerSaveBlocker.isStarted(id),true);
  powerSaveBlocker.stop(id);
  assert.equal(powerSaveBlocker.isStarted(id),false);
  console.log('PASS: native Electron analysis sleep blocker starts and stops');
  app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
