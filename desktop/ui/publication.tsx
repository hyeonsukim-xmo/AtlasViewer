import {useEffect,useState} from 'react';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '../../components/ui/dialog';
import {unwrap,type AccountState,type AnalysisResult,type SyncState,type Reply} from './imaging';
import {t,useLanguage} from './language';

function label(state:string){
  switch(state){
    case 'queued':return t('게시 대기');case 'preparing':return t('전송 사본 준비');case 'uploading':return t('전송 중');
    case 'verifying':return t('서버 검증 중');case 'published':return t('게시 완료');case 'cancelled':return t('게시 취소됨');
    case 'needs_login':return t('게시한 계정·작업공간으로 로그인');case 'needs_permission':return t('게시 권한 확인 필요');
    case 'quota_blocked':return t('서버 저장 공간 부족');case 'waiting_network':return t('연결 복구 대기');default:return t('게시 실패');
  }
}
function errorText(code:string){
  if(code==='PUBLICATION_ATTACHMENT_CONFLICT')return t('서버의 표시 사본이 변경되었습니다. 이 전송을 취소한 뒤 최종 사본을 다시 검토해 게시하세요.');
  if(code==='PUBLICATION_OVERLAY_UNSUPPORTED')return t('서버가 대표 이미지 게시를 지원하지 않습니다. 서버 업데이트 후 재시도하세요.');
  if(code==='PUBLICATION_ORIGIN_APPROVAL_REQUIRED')return t('기관 데이터 관리자가 이 결과 저장소의 소속을 승인해야 합니다.');
  if(code==='PUBLICATION_SIGN_IN')return t('계정에서 로그인하고 게시할 기관·작업공간을 선택하세요.');
  if(code==='PUBLICATION_DELETED')return t('서버에서 삭제된 결과입니다. 재게시할 수 없습니다.');
  if(code==='PUBLICATION_TARGET_MISMATCH')return t('다른 작업공간에 이미 게시된 결과입니다. 자동으로 이전하지 않습니다.');
  if(code==='PUBLICATION_DEVICE')return t('이 기관에 승인된 PC에서 게시할 수 있습니다.');
  if(code==='PUBLICATION_ARTIFACT_INVALID')return t('암호화 파일과 측정값 검증에 실패했습니다. 로컬 결과는 보존되어 있습니다.');
  return t('게시 요청을 완료하지 못했습니다. 계정·권한·서버 연결을 확인하세요.');
}
export default function Publication({results=[]}:{results?:AnalysisResult[]}){
  useLanguage();const api=window.exmoDesktop;
  const [open,setOpen]=useState(false),[status,setStatus]=useState<SyncState>(),[account,setAccount]=useState<AccountState>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const refs=results.map(r=>({id:r.id,revision:r.analysisRevision!}));
  async function refresh(){const [s,a]=await Promise.all([api.syncStatus().then(unwrap),api.accountStatus().then(unwrap)]);setStatus(s);setAccount(a);}
  useEffect(()=>{if(!open)return;let alive=true;const run=()=>void Promise.all([api.syncStatus().then(unwrap),api.accountStatus().then(unwrap)]).then(([s,a])=>{if(alive){setStatus(s);setAccount(a);}}).catch(()=>{if(alive)setError('PUBLICATION_REQUEST_FAILED');});run();const timer=setInterval(run,2000);return()=>{alive=false;clearInterval(timer);};},[open,api]);
  async function action(run:()=>Promise<Reply<unknown>>){setBusy(true);setError('');try{unwrap(await run());await refresh();}catch(e){setError(e instanceof Error?e.message:'PUBLICATION_REQUEST_FAILED');}finally{setBusy(false);}}
  const member=account?.me?.memberships.find(m=>m.orgId===account.workspace?.orgId && m.workspaceId===account.workspace?.workspaceId);
  return <>
    <button className={results.length?'clinical-button':'desktop-demo-link'} onClick={()=>setOpen(true)}>{results.length?t('서버에 게시'):t('전송 현황')}</button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="installation-dialog publication-dialog">
      <DialogTitle>{t('결과 게시·전송')}</DialogTitle>
      <DialogDescription>{t('측정·QC와 암호화된 Mask를 게시하고, 준비된 3D를 추가합니다. 대표 Overlay는 각 영상에서 최종 사본 확인 후 별도로 게시합니다.')}</DialogDescription>
      {!status?.configured?<p>{t('계정 서버가 아직 설정되지 않았습니다. 서버 연결 후 로그인을 사용할 수 있습니다.')}</p>:<>
        <p>{account?.workspace?`${account.workspace.orgId} · ${account.workspace.workspaceId}`:t('계정에서 로그인하고 게시할 기관·작업공간을 선택하세요.')}</p>
        {results.length>0 && <div className="account-actions">
          <button className="clinical-button" disabled={busy||!member?.roles.includes('analyst')||results.some(r=>!r.analysisRevision)} onClick={()=>void action(()=>api.syncEnqueue(refs))}>{t('현재 결과 게시')} · {results.length}</button>
          {member?.roles.includes('data-admin') && <button className="text-button" disabled={busy||!refs[0]?.revision} onClick={()=>void action(()=>api.syncApproveOrigin(refs[0]))}>{t('이 저장소를 현재 기관 소속으로 승인')}</button>}
        </div>}
        <small>{t('서버에는 식별번호 대신 결과 ID로 등록됩니다. 게시 대상은 고정되며 로그아웃·계정 변경 시 전송을 보류합니다.')}</small>
        {status && status.jobs.length>0?<table className="clinical-table"><thead><tr><th>{t('결과')}</th><th>{t('작업공간')}</th><th>{t('전송 상태')}</th><th>{t('관리')}</th></tr></thead><tbody>
          {status.jobs.map(job=><tr key={job.id}><td>{job.name}<small>{job.cloudResultId??job.resultId}</small></td><td>{job.orgId}<small>{job.workspaceId}</small></td><td>{label(job.state)}
            {job.state==='uploading' && <small>{job.kind==='mesh'?'3D':job.kind==='overlay'?'Overlay':'Mask'} · {job.uploaded}/{job.total}</small>}
            {job.overlayState==='pending' && <small>{t('대표 Overlay 전송 대기')}</small>}
            {job.meshState==='pending' && <small>{t('3D 후속 전송 대기')}</small>}
            {job.error && <small title={job.error}>{errorText(job.error)} · {job.error}</small>}</td>
            <td>{!['cancelled','published','preparing','uploading','verifying'].includes(job.state) && job.error!=='PUBLICATION_ATTACHMENT_CONFLICT' && <button className="text-button" disabled={busy} onClick={()=>void action(()=>api.syncRetry(job.id))}>{t('재시도')}</button>}
              {job.state!=='cancelled' && (job.state!=='published'||job.overlayState==='pending') && <button className="text-button" disabled={busy} onClick={()=>void action(()=>api.syncCancel(job.id))}>{t('취소')}</button>}</td></tr>)}
        </tbody></table>:<p>{t('게시 대기 중인 결과가 없습니다.')}</p>}
      </>}
      {status?.storageError && <p role="alert">{t('전송 저장소를 읽을 수 없습니다. 원본과 로컬 분석 결과는 유지됩니다. 디스크·권한·Windows 계정을 확인하세요.')}</p>}
      {error && <p role="alert" className="inline-error">{errorText(error)} · {error}</p>}
    </DialogContent></Dialog>
  </>;
}
