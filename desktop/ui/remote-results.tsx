import {useEffect,useRef,useState} from 'react';
import {t,useLanguage} from './language';
import {unwrap,type AnalysisResult,type RemoteDetail,type RemoteSummary} from './imaging';
import {useAccountState} from './account-state';
import {comparisonIssue,remoteResult} from './remote-contract';
import ResultView from './result-view';

function issueText(issue:string|null){
  switch(issue){
    case 'count':return t('비교할 결과를 2~3개 선택하세요.');
    case 'quantity':return t('측정 종류 또는 단위가 달라 수치 비교할 수 없습니다.');
    case 'ontology':return t('구조 정의가 달라 수치 비교할 수 없습니다.');
    case 'method':return t('측정 방법 또는 촬영 방향이 달라 수치 비교할 수 없습니다.');
    case 'coverage':return t('동일 촬영 범위가 확인되지 않았습니다. 나란히 열람만 가능합니다.');
    default:return '';
  }
}
function errorText(code:string){
  if(code==='PUBLICATION_SIGN_IN')return t('서버 결과를 보려면 로그인하고 작업공간을 선택하세요.');
  if(code==='PUBLICATION_PERMISSION'||code==='PUBLICATION_DEVICE')return t('이 기관의 결과 열람 권한 또는 PC 승인을 확인하세요.');
  if(code==='PUBLICATION_NOT_FOUND'||code==='PUBLICATION_DELETED')return t('삭제되었거나 열람할 수 없는 결과입니다.');
  return t('서버 결과를 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.');
}
export default function RemoteResults({local,onAccount,onHome}:{local:AnalysisResult[];onAccount:()=>void;onHome:()=>void}){
  useLanguage();const account=useAccountState(),api=window.exmoDesktop;
  const binding=JSON.stringify([account?.state,account?.me?.subject,account?.workspace,account?.me?.memberships]);
  const [rows,setRows]=useState<RemoteSummary[]>([]),[names,setNames]=useState<Record<string,string>>({});
  const [selected,setSelected]=useState<string[]>([]),[mode,setMode]=useState(false),[query,setQuery]=useState('');
  const [details,setDetails]=useState<RemoteDetail[]>([]),[opened,setOpened]=useState<RemoteDetail[]>([]),[reference,setReference]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[selectionError,setSelectionError]=useState('');
  const epoch=useRef(0),viewEpoch=useRef(0),returnFocus=useRef<HTMLElement|null>(null),openedRef=useRef(opened);openedRef.current=opened;
  const ready=account?.state==='signed-in' && !!account.workspace;
  const member=account?.me?.memberships.find(m=>m.orgId===account.workspace?.orgId && m.workspaceId===account.workspace?.workspaceId);
  const title=(r:RemoteSummary)=>names[r.resultId]||`Case ${(r.context?.caseId||r.resultId).slice(0,8)}`;
  function clear(){viewEpoch.current++;openedRef.current=[];setRows([]);setSelected([]);setDetails([]);setOpened([]);setNames({});void api.remoteClose();}
  async function refresh(){
    const current=epoch.current;
    try{
      const value=unwrap(await api.remoteList());if(current!==epoch.current)return;
      setRows(value);setError('');
      setSelected(old=>old.filter(id=>value.some(r=>r.resultId===id)));
      if(openedRef.current.some(old=>!value.some(r=>r.resultId===old.resultId)||value.find(r=>r.resultId===old.resultId)?.attachmentRevision!==old.attachmentRevision)){
        const view=viewEpoch.current,updated=unwrap(await api.remoteRead(openedRef.current.map(r=>r.resultId)));
        if(current===epoch.current && view===viewEpoch.current)setOpened(updated);
      }
      const reply=await api.syncStatus();if(current!==epoch.current||!reply.ok)return;const transfer=reply.value;
      setNames(Object.fromEntries(transfer.jobs.filter(j=>j.orgId===account?.workspace?.orgId && j.workspaceId===account?.workspace?.workspaceId && j.cloudResultId)
        .flatMap(j=>{const own=local.find(r=>r.id===j.resultId);return own?[[j.cloudResultId!,own.metadata.caseName]]:[];})));
    }catch(e){if(e instanceof Error && e.message==='PUBLICATION_REQUEST_SUPERSEDED')return;if(current===epoch.current){clear();setError(e instanceof Error?e.message:'PUBLICATION_NETWORK');}}
  }
  useEffect(()=>{
    epoch.current++;clear();setError('');setBusy(false);
    if(!ready)return;
    void refresh();const timer=setInterval(()=>void refresh(),15000);
    return()=>{epoch.current++;clearInterval(timer);void api.remoteClose();};
  },[binding]);
  useEffect(()=>{
    if(selected.length<2){setDetails([]);return;}
    let alive=true;void api.remoteRead(selected,false).then(unwrap).then(v=>{if(alive)setDetails(v);}).catch(e=>{if(alive){setDetails([]);setSelectionError(errorText(e.message));}});
    return()=>{alive=false;};
  },[selected.join(','),binding]);
  function toggle(id:string){
    setSelectionError('');
    if(selected.includes(id))setSelected(selected.filter(x=>x!==id));
    else if(selected.length<3)setSelected([...selected,id]);
    else setSelectionError(t('최대 3개까지 선택할 수 있습니다. 선택한 행을 다시 누르면 해제됩니다.'));
  }
  async function show(ids:string[],compare=false){
    if(!ids.length)return;const current=epoch.current,view=++viewEpoch.current;returnFocus.current=document.activeElement as HTMLElement;
    setBusy(true);setError('');setSelectionError('');
    try{
      const value=unwrap(await api.remoteRead(ids));if(current!==epoch.current || view!==viewEpoch.current)return;
      const issue=compare?comparisonIssue(value):null;
      if(issue){setSelectionError(issueText(issue));return;}
      setReference(!compare && value.length>1);setOpened(value);
    }catch(e){if(current===epoch.current && view===viewEpoch.current){setOpened([]);setError(e instanceof Error?e.message:'PUBLICATION_NETWORK');}}
    finally{if(current===epoch.current && view===viewEpoch.current)setBusy(false);}
  }
  function close(){viewEpoch.current++;openedRef.current=[];setOpened([]);setBusy(false);void api.remoteClose();requestAnimationFrame(()=>returnFocus.current?.focus());}
  useEffect(()=>{if(opened.length)requestAnimationFrame(()=>document.querySelector<HTMLButtonElement>('.remote-detail .back-button')?.focus());},[opened.length]);
  const filtered=rows.filter(r=>[title(r),r.context?.studyId,r.resultId,r.analysis,r.route,r.variant].join(' ').toLowerCase().includes(query.toLowerCase()));
  const groups=[...new Map(filtered.map(r=>[r.analysis==='xray' && r.context?`xray:${r.context.studyId}`:r.resultId,[] as RemoteSummary[]])).keys()].map(key=>({key,items:filtered.filter(r=>(r.analysis==='xray' && r.context?`xray:${r.context.studyId}`:r.resultId)===key)}));
  const rank=(r:RemoteSummary)=>['LAT_LT','AP','LAT_RT'].indexOf(r.route?.replaceAll('-','_')??'');
  const compatible=details.length===selected.length && selected.every(id=>details.some(r=>r.resultId===id))?comparisonIssue(details):'count';
  return <section className="remote-workspace">
    <div className="remote-browse" hidden={opened.length>0}>
    <header className="workspace-heading"><div><button className="clinical-button back-button" onClick={onHome}>{t('← 분석 작업으로')}</button><h1>{t('서버 결과')}</h1>
      <p>{member?`${member.orgId} · ${member.name}`:t('기관·작업공간')} · {t('읽기 전용')}</p></div>
      <div className="account-actions"><button className="clinical-button" onClick={onAccount}>{ready?t('계정·작업공간'):t('로그인')}</button>
        <button className="clinical-button" disabled={!ready||busy} onClick={()=>void refresh()}>{t('새로고침')}</button></div></header>
    {error && <p className="inline-error" role="alert">{errorText(error)} · {error}</p>}
    {!ready?<div className="clinical-empty"><p>{account?.state==='unconfigured'?t('계정 서버가 아직 설정되지 않았습니다. 서버 연결 후 로그인을 사용할 수 있습니다.'):t('서버 결과를 보려면 로그인하고 작업공간을 선택하세요.')}</p><p>{t('로컬 분석과 저장된 결과는 계속 사용할 수 있습니다.')}</p></div>:<>
      <div className="remote-toolbar"><input className="comparison-search" value={query} aria-label={t('서버 결과 검색')} placeholder={t('케이스·Study·결과 ID 검색')} onChange={e=>setQuery(e.target.value)}/>
        <button className="clinical-button" aria-pressed={mode} onClick={()=>setMode(!mode)}>{t('비교 선택')} · {selected.length}/3</button>
        {mode && <><button className="clinical-button" disabled={busy||selected.length<2||!!compatible} onClick={()=>void show(selected,true)}>{t('수치 비교')}</button>
          <button className="clinical-button" disabled={busy||selected.length<2} onClick={()=>void show(selected)}>{t('나란히 열람')}</button>
          <button className="text-button" disabled={!selected.length} onClick={()=>{setSelected([]);setSelectionError('');}}>{t('선택 해제')}</button></>}
      </div>
      {mode && selected.length>1 && compatible && <p role="status" className="metric-note">{issueText(compatible)}</p>}
      {selectionError && <p role="alert" className="inline-error">{selectionError}</p>}
      <p className="metric-note">{t('최신 게시 결과 200건 · 서버 식별자는 가명입니다. 원본 환자명과 촬영일은 전송하지 않습니다.')}</p>
      <div className="catalog-section remote-list"><table className="clinical-table"><thead><tr>{mode && <th>{t('선택')}</th>}<th>Case / Study</th><th>Modality / View</th><th>{t('결과')}</th><th>3D</th><th/></tr></thead><tbody>
        {groups.flatMap(group=>{
          const items=group.items.toSorted((a,b)=>rank(a)-rank(b));
          const missing=['LAT_LT','AP','LAT_RT'].filter(route=>!items.some(r=>r.route?.replaceAll('-','_')===route));
          return [items[0].analysis==='xray' && items[0].context && <tr className="remote-study" key={group.key+':study'}><td colSpan={mode?6:5}><strong>Study {items[0].context?.studyId.slice(0,8)}</strong><span> · LT / AP / RT</span>
            <button className="text-button" disabled={busy} onClick={()=>void show(['LAT_LT','AP','LAT_RT'].flatMap(route=>{const row=items.find(r=>r.route?.replaceAll('-','_')===route);return row?[row.resultId]:[];}))}>{t('촬영 묶음 열기')}</button>
            {missing.length>0 && <small>{missing.map(route=>route.replace('LAT_','')).join(' / ')} · {t('미게시')}</small>}</td></tr>,
            ...items.map(row=><tr key={row.resultId} data-remote-id={row.resultId} tabIndex={0} className="openable-row" aria-selected={mode?selected.includes(row.resultId):undefined}
              onClick={()=>mode?toggle(row.resultId):void show([row.resultId])} onKeyDown={e=>{if(e.target===e.currentTarget && ['Enter',' '].includes(e.key)){e.preventDefault();mode?toggle(row.resultId):void show([row.resultId]);}}}>
              {mode && <td><input type="checkbox" aria-label={t('{{value0}} 선택',{value0:title(row)})} checked={selected.includes(row.resultId)} onClick={e=>e.stopPropagation()} onChange={()=>toggle(row.resultId)}/></td>}
              <td><strong>{title(row)}</strong><small>{row.context?'Study '+row.context.studyId.slice(0,8):t('Study 미연결')}</small></td><td>{row.analysis.toUpperCase()}<small>{row.route?.replace('LAT_','')||'3D'}</small></td>
              <td>{row.variant.toUpperCase()} · {row.unit}<small>{row.resultId.slice(0,8)}</small></td><td>{row.meshState==='ready'?t('준비 완료'):row.meshState==='pending'?t('3D 후속 전송 대기'):t('해당 없음')}</td>
              <td><button className="clinical-button" disabled={busy} onClick={e=>{e.stopPropagation();void show([row.resultId]);}}>{t('결과 열기')}</button></td></tr>)];
        })}
      </tbody></table>{!rows.length && <div className="clinical-empty">{t('게시된 결과가 없습니다.')}</div>}</div>
    </>}
    {busy && <p role="status">{t('서버 결과 확인 중')}</p>}
    </div>
    {ready && opened.length>0 && <div className="remote-detail" role="region" aria-label={t('서버 결과 열람')}>
      <p className="remote-disclosure" role="status">{reference?t('나란히 열람 · 촬영 범위와 측정 조건의 동일성을 보증하지 않습니다.'):t('게시된 고정 결과 · 읽기 전용')}
        {opened.some(r=>!r.content.provenance.recipeDigest) && <> · {t('과거 모델·처리 버전 미기록')}</>}</p>
      <ResultView results={opened.map(row=>remoteResult(row,title(row)))} onClose={close} onUpdate={()=>{}} heading={opened.length>1?(reference?t('나란히 열람'):t('수치 비교')):title(opened[0])}
        description={t('서버에 게시된 측정값과 QC · 원본 영상 없음')} remote={{overlays:Object.fromEntries(opened.filter(r=>r.overlay).map(r=>[r.resultId,r.overlay!])),meshUrls:Object.fromEntries(opened.filter(r=>r.meshUrl).map(r=>[r.resultId,r.meshUrl!]))}}/>
    </div>}
  </section>;
}
