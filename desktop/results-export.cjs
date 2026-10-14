const { deflateRawSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

// Minimal SpreadsheetML writer: typed literal cells, no formulas or external links.
// https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document
const xml = value => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function column(index) {
  let label = '';
  for (index++; index; index = Math.floor((index - 1) / 26)) label = String.fromCharCode(65 + (index - 1) % 26) + label;
  return label;
}
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name), data = Buffer.from(text), compressed = deflateRawSync(data);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); header.copy(directory, 6, 4, 30);
    directory.writeUInt32LE(offset, 42); central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}
function workbook(sheets) {
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const entries = [
    ['[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<workbook xmlns="${main}" xmlns:r="${rel}"><sheets>${sheets.map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="styles" Type="${rel}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<styleSheet xmlns="${main}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF252544"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
  ];
  sheets.forEach((sheet, i) => {
    if (sheet.rows.length > 1048576 || sheet.rows.some(row => row.length > 16384)) throw Error('Excel worksheet size limit exceeded.');
    const last = `${column(sheet.rows[0].length - 1)}${sheet.rows.length}`;
    const rows = sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => {
      if (value == null || typeof value === 'number' && !Number.isFinite(value)) return '';
      const address = `r="${column(c)}${r + 1}" s="${r === 0 ? 1 : 0}"`;
      if (typeof value === 'number') return `<c ${address}><v>${value}</v></c>`;
      if (typeof value === 'boolean') return `<c ${address} t="b"><v>${value ? 1 : 0}</v></c>`;
      return `<c ${address} t="inlineStr"><is><t xml:space="preserve">${xml(String(value).slice(0, 32767))}</t></is></c>`;
    }).join('')}</row>`).join('');
    entries.push([`xl/worksheets/sheet${i + 1}.xml`, `<worksheet xmlns="${main}"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${sheet.rows[0].map((name, c) => `<col min="${c + 1}" max="${c + 1}" width="${Math.min(42, Math.max(18, String(name).length + 3))}" customWidth="1"/>`).join('')}</cols><sheetData>${rows}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`]);
  });
  return zip(entries.map(([name, data]) => [name, declaration + data]));
}

function resultSheets(items) {
  const keys = ['patient_id_or_uuid', 'uuid', 'patient_id', 'issuer', 'result_id', 'input_id', 'analysis', 'study_date', 'variant', 'unit'];
  const cases = [[...keys, 'case_name', 'study', 'series', 'study_uid', 'series_uid', 'analyzed_at', 'structure_count', 'laterality_status', 'laterality_method', 'qc_flags', 'entropy', 'tta_disagreement', 'missing_labels', 'unexpected_labels', 'removed_volume_cm3', 'removed_percent', 'changed_voxels']];
  const metrics = [[...keys, 'structure_id', 'structure', 'label', 'group', 'scope', 'value', 'raw_value', 'count', 'present', 'applicable', 'fat_range_percent', 'mean_hu', 'entropy', 'components', 'difference_cm3', 'difference_percent', 'side_flags']];
  const mapping = [['uuid', 'patient_id', 'issuer', 'study_date', 'study_uid', 'series_uid', 'input_id', 'result_id']];
  for (const {summary: r, source, identity: id} of items) {
    const base = [id.patientId || id.uuid, id.uuid, id.patientId, id.issuer, r.id, source.inputId, r.analysis, source.studyDate, r.variant, r.unit];
    cases.push([...base, r.metadata.caseName, r.metadata.studyDescription, r.metadata.seriesDescription, source.studyUid, source.seriesUid, r.createdAt, r.rows.length, r.laterality?.status, r.laterality?.method, r.qc?.flags?.join('; '), r.qc?.entropy, r.qc?.ttaDisagreement, r.qc?.missing?.join('; '), r.qc?.unexpected?.join('; '), r.qc?.postprocessing?.removedCm3, r.qc?.postprocessing?.removedPercent, r.qc?.postprocessing?.changedVoxels]);
    mapping.push([id.uuid, id.patientId, id.issuer, source.studyDate, source.studyUid, source.seriesUid, source.inputId, r.id]);
    for (const row of r.rows) {
      const structure = [...base, row.id, row.name, row.label, row.group];
      metrics.push([...structure, 'total', row.value, row.rawValue, row.count, row.present, row.applicable ?? true, row.fat, row.hu, row.entropy, row.components, row.sides?.differenceCm3, row.sides?.differencePercent, row.sides?.flags?.join('; ')]);
      if (row.sides) for (const side of ['left', 'right', 'unassigned']) {
        const value = row.sides[side];
        if (value) metrics.push([...structure, side, value.value, null, value.count, value.count > 0, row.applicable ?? true, value.fat, value.hu, value.entropy]);
      }
    }
  }
  return [{name:'Cases',rows:cases},{name:'Measurements',rows:metrics},{name:'Identifier mapping',rows:mapping},
    {name:'Read me',rows:[['Field','Meaning'],['Exported at',new Date().toISOString()],['Cases','One row per selected analysis result; variant is the saved active variant at export time.'],['Measurements','One row per structure and scope (total / patient left / patient right / unassigned). Values keep their stored precision.'],['Units','Value uses the unit column; CT/MRI volume is within scan coverage. Fat-range and difference values are percent; mean_hu is HU.'],['Missing values','Blank means unavailable. Zero remains numeric zero. Present/applicable and QC columns must be considered when interpreting values.'],['Identifiers','Patient IDs, UUIDs and UIDs are text; leading zeros are preserved. Anonymous identities use the same persistent registry as image exports.'],['Identifier mapping','Only the selected cases are included. Anonymous studies are not assumed to belong to the same patient.'],['Review','These are model analysis outputs, pending clinical review.']]}];
}
async function exportResults(window, publications, {registry, sourceFor, dialog, language}) {
  const reply = await dialog.showSaveDialog(window, {title:language === 'en' ? 'Export selected results to Excel' : '선택 결과 Excel 내보내기',
    defaultPath:`EXMO-results-${new Date().toISOString().slice(0,10)}.xlsx`, filters:[{name:'Excel workbook',extensions:['xlsx']}]});
  if (reply.canceled || !reply.filePath) return {action:'cancel'};
  const items = [];
  for (const publication of publications) {
    const source = sourceFor(publication.record, publication);
    items.push({summary:publication.summary, source, identity:await registry.resolve(source)});
  }
  const bytes = workbook(resultSheets(items));
  await fs.writeFile(reply.filePath, bytes);
  const details = {action:'excel',filename:path.basename(reply.filePath),sha256:createHash('sha256').update(bytes).digest('hex')};
  for (const item of items) await registry.recordExport(item.identity, item.source, details);
  return {action:'save',count:items.length};
}
module.exports = {workbook, resultSheets, exportResults};
