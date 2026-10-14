const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

function identifier(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^(anonymous|anonymized|anonymised|anon|unknown|n\/a|null|none|익명|미상)$/i.test(text) ? '' : text;
}
function createExportIdentities(storageRoot) {
  const filename = path.join(storageRoot, 'export-identities.json');
  let queue = Promise.resolve();
  async function load() {
    try {
      const data = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.identities) || !Array.isArray(data.exports)) throw Error('Invalid export identity table.');
      return data;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return {version:1, identities:[], exports:[]};
    }
  }
  function transact(action, save = true) {
    const task = queue.then(async () => {
      const data = await load();
      const result = action(data);
      if (save) {
        await fs.mkdir(storageRoot, {recursive:true});
        const temporary = filename + '.' + randomUUID() + '.tmp';
        await fs.writeFile(temporary, JSON.stringify(data, null, 2), {encoding:'utf8',flag:'wx'});
        await fs.rename(temporary, filename);
      }
      return result;
    });
    queue = task.catch(() => {});
    return task;
  }
  return {
    resolve(source) {
      return transact(data => {
        const patientId = identifier(source.patientId);
        const issuer = identifier(source.patientIssuer) || identifier(source.institutionName);
        // Names, dates and filenames never establish patient identity.
        const key = JSON.stringify(patientId && issuer ? ['patient',issuer,patientId]
          : source.studyUid ? ['study',source.studyUid] : ['input',source.inputId]);
        let identity = data.identities.find(row =>
          (row.key === key || row.links.some(link => link.inputId === source.inputId)) &&
          (!row.patientId || !patientId || row.patientId === patientId) &&
          (!row.issuer || !issuer || row.issuer === issuer));
        if (!identity) {
          identity = {uuid:randomUUID(),key,patientId,issuer,createdAt:new Date().toISOString(),links:[]};
          data.identities.push(identity);
        }
        if (!identity.patientId && patientId) identity.patientId = patientId;
        if (!identity.issuer && issuer) identity.issuer = issuer;
        if (patientId && issuer) identity.key = key;
        const link = {inputId:source.inputId,resultId:source.resultId || '',analysis:source.analysis,
          studyDate:source.studyDate || '',studyUid:source.studyUid || '',seriesUid:source.seriesUid || ''};
        const prior = identity.links.findIndex(row => row.inputId === link.inputId && row.resultId === link.resultId);
        if (prior < 0) identity.links.push(link); else identity.links[prior] = link;
        return {uuid:identity.uuid,patientId:identity.patientId,issuer:identity.issuer};
      });
    },
    recordExport(identity, source, details) {
      return transact(data => {
        if (!data.identities.some(row => row.uuid === identity.uuid)) throw Error('Export identity missing.');
        data.exports.push({exportId:randomUUID(),uuid:identity.uuid,patientIdAtExport:identity.patientId,
          inputId:source.inputId,resultId:source.resultId || '',exportedAt:new Date().toISOString(),...details});
      });
    },
    csv() {
      return transact(data => {
        const columns = ['uuid','patient_id','issuer','study_date','study_uid','series_uid','input_id','result_id',
          'analysis','export_id','exported_at','action','filename','patient_id_at_export','sha256'];
        const rows = [columns];
        for (const identity of data.identities) for (const link of identity.links) {
          const exports = data.exports.filter(item => item.uuid === identity.uuid && item.inputId === link.inputId && item.resultId === link.resultId);
          for (const item of exports.length ? exports : [{}]) rows.push([
            identity.uuid,identity.patientId,identity.issuer,link.studyDate,link.studyUid,link.seriesUid,link.inputId,link.resultId,
            link.analysis,item.exportId || '',item.exportedAt || '',item.action || '',item.filename || '',item.patientIdAtExport || '',item.sha256 || '',
          ]);
        }
        // UTF-8 BOM for Excel. Keep fields literal; the JSON table preserves exact identifiers.
        const quote = value => '"' + String(/^[=+\-@\t\r\n]/.test(String(value)) ? "'" + value : value).replaceAll('"','""') + '"';
        return '\uFEFF' + rows.map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
      }, false);
    },
  };
}
module.exports = {createExportIdentities};
