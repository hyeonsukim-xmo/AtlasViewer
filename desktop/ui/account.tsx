import {useEffect,useState} from 'react';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '../../components/ui/dialog';
import {unwrap,type AccountState,type Enrollment} from './imaging';
import {t,useLanguage} from './language';

function enrollmentState(value:string){
  if(value==='approved')return t('승인 완료');
  if(value==='rejected')return t('등록 거절');
  return t('승인 대기');
}
export default function Account(){
  useLanguage();
  const api=window.exmoDesktop;
  const [open,setOpen]=useState(false),[state,setState]=useState<AccountState>(),[rows,setRows]=useState<Enrollment[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let alive=true;void api.accountStatus?.().then(unwrap).then(v=>{if(alive)setState(v);}).catch(()=>{});return()=>{alive=false;};},[api]);
  async function action(run:()=>Promise<void>){setBusy(true);setError('');try{await run();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  async function refresh(){setState(unwrap(await api.accountRefresh()));setRows(unwrap(await api.accountEnrollments()));}
  const membership=state?.me?.memberships.find(m=>m.orgId===state.workspace?.orgId && m.workspaceId===state.workspace?.workspaceId);
  return <>
    <button className="desktop-demo-link" onClick={()=>setOpen(true)}>{state?.me?.name??t('계정')}</button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="installation-dialog account-dialog">
      <DialogTitle>{t('계정·장비 등록')}</DialogTitle>
      <DialogDescription>{t('계정은 기관 연결과 장비 등록에 사용합니다. 로컬 분석 권한은 장비 라이선스로 확인합니다.')}</DialogDescription>
      {state?.state==='unconfigured'?<p>{t('계정 서버가 아직 설정되지 않았습니다. 서버 연결 후 로그인을 사용할 수 있습니다.')}</p>:state?.state==='storage-unavailable'?<p role="alert">{t('계정 저장소를 열 수 없습니다. 폴더 권한과 디스크 상태를 확인하세요. 로컬 결과 열람은 유지됩니다.')}</p>:<>
        <div className="account-actions">
          <button className="clinical-button" disabled={busy} onClick={()=>void action(async()=>{setState(unwrap(await api.accountLogin()));setRows(unwrap(await api.accountEnrollments()));})}>{state?.me?t('다시 로그인'):t('브라우저에서 로그인')}</button>
          <button className="text-button" disabled={busy||!state||['signed-out','sign-in-required'].includes(state.state)} onClick={()=>void action(refresh)}>{t('갱신')}</button>
          <button className="text-button" onClick={()=>{void api.accountLogout().then(unwrap).then(v=>{setState(v);setRows([]);}).catch(()=>{});}}>{busy?t('로그인 취소·로그아웃'):t('로그아웃')}</button>
        </div>
        {state?.state==='unavailable' && <p role="status">{t('계정 서버에 연결할 수 없습니다. 로컬 분석과 저장된 결과는 계속 사용할 수 있습니다.')}</p>}
        {state?.me && <>
          {state.me.memberships.length>0 && <label className="account-workspace">{t('기관·작업공간')}<select disabled={busy} value={state.workspace?JSON.stringify([state.workspace.orgId,state.workspace.workspaceId]):''} onChange={e=>{if(e.target.value){const [org,id]=JSON.parse(e.target.value);void action(async()=>setState(unwrap(await api.accountWorkspace(org,id))));}}}>
            <option value="">{t('작업공간 선택')}</option>{state.me.memberships.map(m=><option key={m.orgId+'/'+m.workspaceId} value={JSON.stringify([m.orgId,m.workspaceId])} disabled={!!state.deviceOrgId && state.deviceOrgId!==m.orgId}>{m.orgId} · {m.name}</option>)}
          </select></label>}
          {!state.me.operator && !state.me.memberships.length && <p>{t('승인된 기관 소속이 없습니다. 기관 관리자에게 계정 등록을 요청하세요.')}</p>}
          {membership?.roles.includes('device-admin') && <button className="clinical-button" disabled={busy} onClick={()=>void action(async()=>{unwrap(await api.accountEnroll());await refresh();})}>{t('이 PC 등록 요청')}</button>}
          {state.me.operator && <p>{t('EXMO 운영 관리 · 키 정책 승인은 최근 MFA 로그인이 필요합니다.')}</p>}
          {rows.length>0 && <table className="clinical-table"><thead><tr><th>{t('기관·PC')}</th><th>{t('키 정책')}</th><th>{t('솔루션 권한')}</th><th>{t('등록 상태')}</th><th>{t('관리')}</th></tr></thead><tbody>
            {rows.map(row=><tr key={row.id}><td>{row.orgId}<small>{row.installationId}</small></td><td>{row.profile==='customer'?t('YubiKey 필수'):t('내부용 · 키 면제')}<small>{t('PC 전체 적용')}</small></td>
              <td>{row.solutions.length?row.solutions.map(solution=><button key={solution.solutionId} className="text-button account-solution" aria-pressed={solution.state==='active'} disabled={busy||!state.me?.operator||row.state!=='approved'||solution.state==='revoked'||(solution.expiresAt!==null && solution.expiresAt*1000<=Date.now())} onClick={()=>void action(async()=>{unwrap(await api.accountSolution(row.id,row.licenseRevision!,solution.solutionId,solution.state==='active'?'suspended':'active'));await refresh();})}>
                {solution.solutionId.split('.').at(-1)?.toUpperCase()} · {solution.expiresAt!==null && solution.expiresAt*1000<=Date.now()?t('기간 만료'):solution.state==='revoked'?t('권한 회수'):solution.state==='active'?t('사용 허용'):t('사용 중지')}
              </button>):t('권한 준비 대기')}</td>
              <td>{enrollmentState(row.state)}{row.state==='pending' && !row.prepared && <small>{t('서명 승인 준비 필요')}</small>}</td>
              <td className="installation-actions">{state.me?.operator && row.state==='pending' && <>
                <button className="text-button" disabled={busy||!row.prepared} onClick={()=>void action(async()=>{unwrap(await api.accountDecide(row.id,row.revision,row.profile==='customer'?'required':'internal-exempt','approve'));await refresh();})}>{row.profile==='customer'?t('키 필수 승인'):t('내부용 면제 승인')}</button>
                <button className="text-button" disabled={busy} onClick={()=>void action(async()=>{unwrap(await api.accountDecide(row.id,row.revision,row.profile==='customer'?'required':'internal-exempt','reject'));await refresh();})}>{t('거절')}</button>
              </>}{row.state==='approved' && row.installationId===state.installationId && membership?.roles.includes('device-admin') && membership.orgId===row.orgId && membership.workspaceId===row.workspaceId && <button className="text-button" disabled={busy} onClick={()=>void action(async()=>{setState(unwrap(await api.accountActivate(row.id)));})}>{t('이 PC에 승인 적용')}</button>}</td></tr>)}
          </tbody></table>}
          <small>{t('키 정책은 설치본·암호화 모델과 함께 적용됩니다. 고객용의 키 검증을 계정 설정으로 해제할 수 없습니다.')}</small>
        </>}
      </>}
      {busy && <p role="status">{t('계정 요청 처리 중')}</p>}
      {error && <p className="inline-error" role="alert">{t(error)}</p>}
    </DialogContent></Dialog>
  </>;
}
