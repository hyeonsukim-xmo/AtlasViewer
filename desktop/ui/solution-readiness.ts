import type {LicenseStatus,ModelStatus} from './imaging';
export function solutionAction(id:string,license:LicenseStatus|undefined,status:ModelStatus|undefined){
  if(!license||!status)return 'checking';
  if(license.profile!=='development' && (!['VALID','GRACE'].includes(license.state) || license.solutions && !license.solutions.some(s=>s.solutionId===id && s.state==='active')))return 'license';
  if(status.installation && !['ready','installed'].includes(status.installation))return 'install';
  return 'open';
}
