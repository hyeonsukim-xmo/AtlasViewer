const { userError } = require('./diagnostics.cjs');

// Built-in adapters only. A catalog entry never supplies executable code or model authority.
const solutions = Object.freeze([
  {id:'exmo.thigh.ct', analysis:'ct', workflowId:'thigh-ct-v1', name:'CT',
    protocol:'3D CT · HU', output:'Volume · HU fat-range · 3D', input:'DICOM / NRRD / NIfTI',
    routes:['ct'], runtimes:['ct']},
  {id:'exmo.thigh.mri', analysis:'mri', workflowId:'thigh-mri-water-v1', name:'MRI',
    protocol:'3D Water sequence', output:'Volume · TTA / QC · 3D', input:'DICOM / NRRD / NIfTI',
    routes:['mri'], runtimes:['ct','mri']},
  {id:'exmo.lower-extremity.xray', analysis:'xray', workflowId:'lower-extremity-projection-v1', name:'X-ray',
    protocol:'AP / LAT-LT / LAT-RT', output:'Projection area · Overlay', input:'NRRD · DICOM 방향 확인',
    routes:['AP','LAT_LT','LAT_RT'], runtimes:['ct','ap','lat']},
].map(item => Object.freeze({...item, routes:Object.freeze(item.routes), runtimes:Object.freeze(item.runtimes)})));
// shortcut: One built-in workflow per modality; a second also needs a solution-scoped dispatcher, not just a v3 entitlement.
if (new Set(solutions.map(item => item.analysis)).size !== solutions.length)
  throw new Error('Multiple workflows for one modality require solution-scoped execution authorization.');

function resolveSolution(value) {
  const solution = solutions.find(item => item.id === value || item.analysis === value);
  if (!solution) throw userError('지원하지 않는 분석 솔루션입니다. 앱 버전과 분석 작업을 확인하세요.');
  return solution;
}
function solutionFields(record) {
  const solution = resolveSolution(record.solutionId === undefined ? record.analysis : record.solutionId);
  if (record.analysis !== solution.analysis || (record.workflowId !== undefined && record.workflowId !== solution.workflowId) ||
      (record.resultSchema !== undefined && record.resultSchema !== 'exmo.analysis-result.v1'))
    throw userError('결과의 솔루션과 분석 경로가 일치하지 않습니다.');
  return {solutionId:solution.id, workflowId:solution.workflowId};
}
function matchesSolution(record, scope) {
  try {return solutionFields(record).solutionId === resolveSolution(scope).id;} catch {return false;}
}
module.exports = {solutions, resolveSolution, solutionFields, matchesSolution};
