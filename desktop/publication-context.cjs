const path=require('node:path'),crypto=require('node:crypto');
const {protectedStore}=require('./security/storage.cjs');
const S=require('./publication-protocol.cjs');
function openContexts(directory,safeStorage){
  const store=protectedStore(path.join(directory,'study-links.bin'),safeStorage,8*1024*1024);
  return source=>{
    const saved=store.read()??{schema:1,links:{}};S.check(saved.schema===1 && saved.links && typeof saved.links==='object','PUBLICATION_CONTEXT_STORAGE');
    const m=source.summary.metadata??{},a=m.studyAssignment??m,issuer=a.patientIssuer||m.institutionName;
    const patient=issuer && a.patientId?['patient',issuer,a.patientId]:null,date=a.studyDate?.replaceAll('-','');
    const parsed=/^\d{8}$/.test(date??'')?new Date(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T00:00:00Z`):null;
    const validDate=parsed && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10).replaceAll('-','')===date;
    const study=m.studyAssignment && patient && validDate?['day',...patient,date]:m.studyUid && !m.studyAssignment?['study',issuer??'',a.patientId??'',m.studyUid]:null;
    const acquisition=['acquisition',source.identity.originStoreId,source.summary.inputId||source.identity.originResultId];
    const get=key=>{const k=S.canonical([source.identity.originStoreId,key]);return saved.links[k]??=crypto.randomUUID();};
    const value=S.context({caseId:get(patient??study??acquisition),studyId:get(study??acquisition),acquisitionId:get(acquisition)});
    store.write(saved);return value;
  };
}
module.exports={openContexts};
