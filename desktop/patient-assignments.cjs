const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

function createPatientAssignments(storageRoot) {
  const filename = path.join(storageRoot, 'patient-assignments.json');
  let assignments = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {};
  let queue = Promise.resolve();
  return {
    apply(record) {
      const assignment = assignments[record.inputId || record.id];
      if (!assignment || !['ct', 'mri'].includes(record.analysis)) return record;
      return {...record, metadata: {...record.metadata, ...assignment, patientAssigned: true}};
    },
    assign(analysis, ids, study, recordFor) {
      if (!['ct', 'mri'].includes(analysis) || !Array.isArray(ids) || !ids.length || ids.length > 6000 || ids.some(id => typeof id !== 'string'))
        throw Error('Invalid patient assignment.');
      const records = [...new Set(ids)].map(id => {
        const record = recordFor(id);
        if (record?.analysis !== analysis || !record.metadata) throw Error('Selected image not found.');
        return record;
      });
      let value = null;
      if (study !== null) {
        if (!study || ['patientId', 'patientIssuer'].some(key => typeof study[key] !== 'string' || !study[key].trim() || study[key].length > 120) ||
          /^(anonymous|anonymized|anonymised|anon|unknown|n\/a|null|none|익명|미상)$/i.test(study.patientId.trim()))
          throw Error('Enter a patient ID and institution.');
        value = {patientId: study.patientId.trim(), patientIssuer: study.patientIssuer.trim()};
        if (study.studyDate != null && study.studyDate !== '') {
          if (typeof study.studyDate !== 'string') throw Error('Invalid study date.');
          const date = study.studyDate.replaceAll('-', '');
          const parsed = new Date(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T00:00:00Z`);
          if (!/^\d{8}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10).replaceAll('-','') !== date) throw Error('Invalid study date.');
          value.studyDate = date;
        }
      }
      const task = queue.then(async () => {
        const next = {...assignments};
        for (const record of records) {
          if (value) next[record.id] = {...value, ...(!value.studyDate && assignments[record.id]?.studyDate ? {studyDate:assignments[record.id].studyDate} : {})};
          else delete next[record.id];
        }
        await fsp.mkdir(storageRoot, {recursive:true});
        const temp = filename + '.' + randomUUID() + '.tmp';
        await fsp.writeFile(temp, JSON.stringify(next), {flag:'wx'});
        await fsp.rename(temp, filename);
        assignments = next;
      });
      queue = task.catch(() => {});
      return task;
    },
  };
}
module.exports = {createPatientAssignments};
