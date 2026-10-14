const fs = require('node:fs');
const path = require('node:path');
const fields = {patientId:'PatientID', patientIssuer:'IssuerOfPatientID', institutionName:'InstitutionName',
  studyUid:'StudyInstanceUID', seriesUid:'SeriesInstanceUID', sopUid:'SOPInstanceUID', studyDate:'StudyDate',
  acquisitionTime:'AcquisitionTime', caseName:'PatientName', studyDescription:'StudyDescription', seriesDescription:'SeriesDescription'};

function readNrrdMetadata(filename) {
  const handle = fs.openSync(filename, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const size = fs.readSync(handle, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, size).toString('utf8');
    const end = text.search(/\r?\n\r?\n/);
    if (!/^NRRD\d{4}\r?\n/.test(text) || end < 0) return {};
    const header = {};
    for (const line of text.slice(0, end).split(/\r?\n/)) {
      const match = line.match(/^([^#][^:=]*):=(.*)$/);
      if (match) header[match[1].trim()] = match[2].trim();
    }
    return Object.fromEntries(Object.entries(fields).flatMap(([key, tag]) => {
      const value = header[tag] || header['DICOM_' + tag];
      return value ? [[key, value.slice(0, 300)]] : [];
    }));
  } finally {fs.closeSync(handle);}
}
function createSourceMetadata(storageRoot) {
  const filename = path.join(storageRoot, 'source-metadata.json');
  const data = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {version:1,records:{}};
  if (data.version !== 1 || !data.records || typeof data.records !== 'object') throw Error('Invalid recovered metadata table.');
  const cache = new Map();
  return {
    apply(record, inputRecord = record) {
      if (!['ct','mri','xray'].includes(record.analysis)) return record;
      const id = inputRecord.inputId || inputRecord.id;
      const cacheKey = id + ':' + (inputRecord.input || '');
      if (!cache.has(cacheKey)) {
        let metadata = {...data.records[id]?.metadata};
        // Retained input.nrrd remains next to validated-input.nii.gz after CT validation.
        const candidates = inputRecord.input ? [...new Set([inputRecord.input, path.join(path.dirname(inputRecord.input), 'input.nrrd')])].filter(file => /\.nrrd$/i.test(file)) : [];
        for (const candidate of candidates) {
          const rel = path.relative(storageRoot, candidate);
          if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
          try {metadata = {...metadata, ...readNrrdMetadata(candidate)};} catch { /* Keep verified recovery data if the retained header is unavailable. */ }
        }
        metadata = Object.fromEntries(Object.entries(metadata).filter(([key,value]) => key in fields && typeof value === 'string' && value.trim()));
        cache.set(cacheKey, metadata);
      }
      const recovered = cache.get(cacheKey);
      return Object.keys(recovered).length ? {...record, metadata:{...record.metadata, ...recovered}} : record;
    },
  };
}
module.exports = {readNrrdMetadata, createSourceMetadata};
