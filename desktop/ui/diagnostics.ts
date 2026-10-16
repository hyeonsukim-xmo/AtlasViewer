import catalog from '../diagnostics.json';
import { t } from './language';

export type Diagnostic = {code:string; stage:string; reference:string; message:string; action:string};
export type Failure = string | Error;
export function failureText(error: Failure, diagnostic?: Diagnostic): string {
  const issue = diagnostic || (error instanceof Error ? (error as Error & {diagnostic?:Diagnostic}).diagnostic : undefined);
  if (!issue) return t(error instanceof Error ? error.message : error);
  return `${t(issue.stage)} · ${issue.code}\n${t(issue.message)}\n${t(issue.action)}\n${t('진단 번호')}: ${issue.reference}`;
}
export function sceneDiagnostic(code='MESH_READ', reference: string=crypto.randomUUID()): Diagnostic {
  if (!Object.hasOwn(catalog, code)) code = 'MESH_READ';
  const entry = catalog[code as keyof typeof catalog] || catalog.MESH_READ;
  return {code, reference, stage:t('3D 표시'), ...entry};
}
