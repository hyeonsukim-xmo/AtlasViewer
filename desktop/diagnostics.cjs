const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const catalog = require('./diagnostics.json');
const systemCodes = { ENOENT:'FILE_MISSING', ENOSPC:'DISK_FULL', EDQUOT:'DISK_FULL', EACCES:'ACCESS_DENIED', EPERM:'ACCESS_DENIED', EBUSY:'FILE_BUSY', ENAMETOOLONG:'PATH_TOO_LONG', ENOMEM:'MEMORY' };
const stages = { inspect:'입력 확인', extract:'ZIP 압축 해제', prepare:'입력 확인', preview:'영상·Overlay 표시', finalize:'측정·Overlay 준비', mesh:'3D 생성', model_challenge:'분석 권한 확인', run:'Segmentation' };
const exitStages = { logits_validation:'모델 출력 검증', probability_conversion:'확률 변환', probability_validation:'확률 검증' };
function userError(message, code='INPUT_INVALID') { return Object.assign(new Error(message), { publicMessage:message, diagnosticCode:code }); }
function workerError(response) {
  return Object.assign(new Error(response.error || 'Analysis failed'), {
    diagnosticCode: Object.hasOwn(catalog, response.errorCode) ? response.errorCode : undefined,
    publicMessage: response.errorPublic === true || response.errorCode === 'INPUT_INVALID' ? response.error : undefined,
    reference: /^[a-f0-9-]{36}$/.test(response.reference || '') ? response.reference : undefined,
  });
}
function diagnose(error, {stage, code='INTERNAL', caseId, logRoot} = {}) {
  if (error.diagnostic) return error.diagnostic;
  code = code === 'CANCELLED' ? code : systemCodes[error.code] || (code === 'AUTHORIZATION' ? code : error.diagnosticCode !== 'INFERENCE' && Object.hasOwn(catalog, error.diagnosticCode) ? error.diagnosticCode : code);
  if (code === 'AUTHORIZATION') {
    const state = /^(?:신규 분석 권한 없음: )?(REVOKED|EXPIRED|UNACTIVATED)\b/.exec(error.message || '')?.[1];
    code = {REVOKED:'LICENSE_REVOKED',EXPIRED:'LICENSE_EXPIRED',UNACTIVATED:'ACTIVATION_REQUIRED'}[state] || code;
  }
  if (!Object.hasOwn(catalog, code)) code = 'INTERNAL';
  const diagnostic = { code, stage:exitStages[error.processExit?.lastOperation] || stages[stage] || stage || '', reference:error.reference || randomUUID(),
    message:error.publicMessage || catalog[code].message, action:catalog[code].action };
  if (logRoot) {
    const record = { time:new Date().toISOString(), ...diagnostic, caseId, errorType:error.name,
      osCode:error.code, processExit:error.processExit, detail:systemCodes[error.code] ? error.message : undefined };
    try { fs.appendFileSync(path.join(logRoot, 'diagnostics-private.jsonl'), JSON.stringify(record)+'\n'); }
    catch { console.error('Diagnostic log could not be written', diagnostic.reference, diagnostic.code); }
  }
  error.diagnostic = diagnostic;
  return diagnostic;
}
module.exports = { diagnose, workerError, userError, catalog };
