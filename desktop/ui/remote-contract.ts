import type {AnalysisResult,RemoteDetail} from './imaging';
export function comparisonIssue(rows:RemoteDetail[]):'count'|'quantity'|'ontology'|'method'|'coverage'|null{
  if(rows.length<2||rows.length>3)return 'count';
  const first=rows[0];
  const ontology=(r:RemoteDetail)=>JSON.stringify(r.content.rows.map(v=>[v.label,v.id,v.name]).sort((a,b)=>String(a[1]).localeCompare(String(b[1]))));
  for(const row of rows.slice(1)){
    if(row.unit!==first.unit || (row.analysis==='xray')!==(first.analysis==='xray'))return 'quantity';
    if(ontology(row)!==ontology(first))return 'ontology';
    if(row.content.workflowId!==first.content.workflowId || row.route?.replaceAll('-','_')!==first.route?.replaceAll('-','_'))return 'method';
    // Native volume is not proof of complete anatomic coverage. Only the same acquisition is established in V1.
    if(!first.context?.acquisitionId || row.context?.acquisitionId!==first.context.acquisitionId || JSON.stringify(row.content.geometry)!==JSON.stringify(first.content.geometry))return 'coverage';
  }
  return null;
}
export function remoteResult(row:RemoteDetail,name:string):AnalysisResult{
  const v=row.content;
  return {id:row.resultId,inputId:'',analysis:v.analysis,solutionId:v.solutionId,workflowId:v.workflowId,name,
    metadata:{format:'published',caseName:name,studyDescription:row.context?'Study '+row.context.studyId.slice(0,8):'',seriesDescription:v.route||v.workflowId,size:v.geometry.size,spacing:v.geometry.spacing,slices:v.geometry.size[2]},
    rows:v.rows,unit:v.unit,variant:v.variant,route:v.route,meshBytes:row.meshBytes,meshState:row.meshState,
    laterality:v.laterality?{...v.laterality,reason:''}:null,
    parts:v.parts.map(p=>{const row=v.rows.find(r=>r.id===p.structureId)!;return {...p,name:row.name,color:row.color,group:row.group};}),
    qc:v.qc,seconds:0,createdAt:''};
}
