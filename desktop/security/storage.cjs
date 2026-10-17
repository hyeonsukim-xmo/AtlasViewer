const fs=require('node:fs');
const crypto=require('node:crypto');
const P=require('./license-protocol.cjs');
function read(file,limit=65536) {
  P.check(fs.statSync(file).size<=limit,'Licensing file too large');
  return fs.readFileSync(file);
}
function atomicWrite(file,bytes) {
  const temporary=`${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(temporary,file);
  } finally {if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temporary,{force:true});}
}
function protectedStore(file,safeStorage) {
  const ready=()=>P.check(safeStorage.isEncryptionAvailable(),'Windows protected storage unavailable');
  return {
    read(){ready();try{return JSON.parse(safeStorage.decryptString(read(file,256*1024)));}catch(error){if(error.code==='ENOENT')return null;throw error;}},
    write(value){ready();atomicWrite(file,safeStorage.encryptString(JSON.stringify(value)));},
  };
}
module.exports={read,atomicWrite,protectedStore};
