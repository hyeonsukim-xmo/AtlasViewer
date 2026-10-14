import assert from 'node:assert/strict';
import {groupPatients, studyDate, seriesLabel, studyAnalysisHistory} from '../desktop/ui/patient-groups.ts';
const file=(id,patientId,studyDate,patientIssuer='HOSPITAL',extra={})=>({id,name:'same filename',metadata:{caseName:'Same name',patientId,studyDate,patientIssuer,...extra}});
const rows=[file('a','00042','20251012'),file('b','00042','20261006'),file('c','00042','20261006'),
 file('d','00042','20261006','OTHER'),file('e','00043','20261006'),file('f','Anonymous','20261006'),
 file('g','','20251012'),file('h','','bad'),file('i','00042','20261006',''),file('j','00042','20251012','')];
const groups=groupPatients(rows);
assert.equal(groups.length,6);
const patient=groups.find(g=>g.patientId==='00042'&&g.issuer==='HOSPITAL');
assert.deepEqual(patient.dates.map(d=>d.date),['2026-10-06','2025-10-12']);
assert.deepEqual(patient.dates[0].items.map(f=>f.id),['b','c']);
assert.equal(groups.at(-1).key,'unidentified');
assert.deepEqual(groups.at(-1).dates.map(d=>d.date),['2026-10-06','2025-10-12','']);
assert.equal(studyDate('20250229'),'');assert.equal(studyDate('20240229'),'2024-02-29');
assert.equal(groupPatients([{id:'one',name:'20261006_person.nrrd'},{id:'two',name:'same name'}])[0].dates[0].date,'');
assert.deepEqual(groupPatients(rows.filter(r=>['a','e'].includes(r.id))).flatMap(g=>g.items).map(f=>f.id),['a','e']);
assert.equal(groupPatients([{id:'failed',name:'broken.dcm',ready:false}])[0].key,'import-failed');
assert.equal(seriesLabel({name:'20260811_Axial_1.3.12.2.1107.5.1.4.76568__AN_20260828.nrrd'}),'20260811_Axial');
assert.equal(seriesLabel({name:'original_verylong.nrrd',metadata:{seriesDescription:'Axial  5.0 Br59 2'}}),'Axial 5.0 Br59 2');
console.log('PASS: patient/issuer boundaries, leading zeros, date hierarchy/order, anonymous bucket, missing issuer isolation, valid dates, no filename identity guesses');
const scan=(id,studyUid,seriesUid,analysis='ct')=>({id,analysis,metadata:{patientId:'00042',studyDate:'20261006',studyUid,seriesUid}});
const scans=[scan('done','study-a','series-a'),scan('sibling','study-a','series-b'),scan('same-day-other-study','study-b','series-c'),
 scan('reimport','study-a','series-a'),scan('missing-uid','',''),scan('unrelated-unknown','',''),scan('other-modality','study-a','series-a','mri')];
const history=studyAnalysisHistory(scans,[{inputId:'done',analysis:'ct',metadata:{}},{inputId:'missing-uid',analysis:'ct',metadata:{}}]);
assert.deepEqual([...history.analyzedInputs],['done','sibling','reimport','missing-uid']);
assert.deepEqual([...history.completedInputs],['done','reimport','missing-uid']);
const retained=studyAnalysisHistory(scans,[{inputId:'no-longer-in-library',analysis:'ct',metadata:{studyUid:'study-a',seriesUid:'series-a'}}]);
assert.deepEqual([...retained.analyzedInputs],['done','sibling','reimport']);
assert.deepEqual([...retained.completedInputs],['done','reimport']);
assert.equal(studyAnalysisHistory(scans,[]).analyzedInputs.size,0);
console.log('PASS: study-wide completion history, actual series badges, same-day study isolation, missing UID exact-input fallback, modality isolation, saved result matching after input removal');
