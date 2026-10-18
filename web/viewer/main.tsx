import {createRoot} from 'react-dom/client';
import {useEffect,useMemo,useRef,useState} from 'react';
import ResultView from '../../desktop/ui/result-view';
import {comparisonIssue,remoteResult} from '../../desktop/ui/remote-contract';
import ResultList,{resultTitle as title} from './result-list';
import type {RemoteSummary,RemoteDetail} from '../../desktop/ui/imaging';
import LanguageSelect from '../../desktop/ui/language-select';
import {t,useLanguage} from '../../desktop/ui/language';
import '../../app/globals.css';
import '../../desktop/ui/workspace.css';
import './viewer.css';

type Session={signedIn:boolean;csrf:string;subject:string|null;memberships:{orgId:string;workspaceId:string;name:string}[];workspace:{orgId:string;workspaceId:string}|null;scopeKey:string|null};
async function request<T>(url:string,session?:Session,body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(url,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',signal,
    headers:{...(session?.scopeKey?{'X-EXMO-Workspace':session.scopeKey}:{}),...(body===undefined?{}:{'Content-Type':'application/json','X-EXMO-CSRF':session!.csrf})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error),{status:response.status});return value;
}
function Viewer(){
  useLanguage();
  const [session,setSession]=useState<Session|null>(null),[rows,setRows]=useState<RemoteSummary[]>([]),[opened,setOpened]=useState<RemoteDetail[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[reference,setReference]=useState(false);
  const epoch=useRef(0),current=useRef<Session|null>(null),detail=useRef<RemoteDetail[]>([]),controller=useRef<AbortController|null>(null),quantitative=useRef(false);
  const mutating=useRef(false),refreshNumber=useRef(0);
  const channel=useRef<BroadcastChannel|null>(null);
  function close(){epoch.current++;controller.current?.abort();controller.current=null;detail.current=[];setOpened([]);setBusy(false);requestAnimationFrame(()=>document.querySelector<HTMLElement>('.viewer-results h1')?.focus());}
  function clear(){close();setRows([]);}
  function failed(e:unknown){if(e instanceof DOMException && e.name==='AbortError')return;clear();setError(t('서버 연결 또는 접근 권한을 확인한 뒤 다시 로그인하거나 새로고침하세요.')+(e instanceof Error && /^[A-Z_]+$/.test(e.message)?` (${e.message})`:''));}
  async function refresh(){
    if(mutating.current)return;let version=epoch.current;const sequence=++refreshNumber.current;
    try{
      const next=await request<Session>('/api/session');if(version!==epoch.current||sequence!==refreshNumber.current)return;
      if(next.scopeKey!==current.current?.scopeKey || next.subject!==current.current?.subject)clear();
      current.current=next;setSession(next);version=epoch.current;
      if(next.signedIn && next.scopeKey){
        const values=await request<RemoteSummary[]>('/api/results',next);if(version!==epoch.current||sequence!==refreshNumber.current)return;setRows(values);
        if(detail.current.length){
          if(detail.current.some(old=>!values.some(r=>r.resultId===old.resultId)))close();
          else if(detail.current.some(old=>values.find(r=>r.resultId===old.resultId)?.attachmentRevision!==old.attachmentRevision))await open(detail.current,quantitative.current,next);
        }
      }
      if(new URL(location.href).searchParams.has('auth')){history.replaceState(null,'','/');setError(t('로그인을 완료하지 못했습니다. 다시 로그인하세요.'));}else setError('');
    }catch(e){if(version===epoch.current&&sequence===refreshNumber.current){current.current=null;setSession(null);failed(e);}}
  }
  useEffect(()=>{
    void refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh();},15000);
    const focus=()=>{if(!document.hidden)void refresh();},hide=()=>{clear();current.current=null;setSession(null);};
    window.addEventListener('pageshow',focus);window.addEventListener('pagehide',hide);document.addEventListener('visibilitychange',focus);
    channel.current=new BroadcastChannel('exmo-viewer-session');channel.current.onmessage=()=>{clear();current.current=null;setSession(null);void refresh();};
    return ()=>{clearInterval(timer);controller.current?.abort();channel.current?.close();window.removeEventListener('pageshow',focus);window.removeEventListener('pagehide',hide);document.removeEventListener('visibilitychange',focus);};
  },[]);
  async function action(kind:'login'|'logout'|'workspace',body:unknown={}){
    const s=current.current;if(!s||mutating.current)return;mutating.current=true;clear();setBusy(true);setError('');
    try{
      if(kind==='login'){const value=await request<{location:string}>('/auth/login',s,{});window.location.assign(value.location);return;}
      await request(kind==='logout'?'/auth/logout':'/api/workspace',s,body);
      current.current=null;setSession(null);channel.current?.postMessage('changed');mutating.current=false;await refresh();
    }catch(e){failed(e);}finally{mutating.current=false;setBusy(false);}
  }
  async function open(items:RemoteSummary[],compare=false,s=current.current){
    if(!s||!items.length||items.length>3)return;controller.current?.abort();controller.current=new AbortController();const signal=controller.current.signal,version=++epoch.current;
    detail.current=[];setOpened([]);setBusy(true);setError('');
    try{const values=await Promise.all(items.map(row=>request<RemoteDetail>('/api/results/'+encodeURIComponent(row.resultId),s,undefined,signal)));
      if(version!==epoch.current)return;
      const issue=compare?comparisonIssue(values):null;
      if(issue){setError(issue==='quantity'?t('측정 종류 또는 단위가 달라 수치 비교할 수 없습니다.'):issue==='ontology'?t('구조 정의가 달라 수치 비교할 수 없습니다.'):issue==='method'?t('측정 방법 또는 촬영 방향이 달라 수치 비교할 수 없습니다.'):t('동일 촬영 범위가 확인되지 않았습니다. 나란히 열람만 가능합니다.'));return;}
      quantitative.current=compare;setReference(!compare&&values.length>1);detail.current=values;setOpened(values);
    }catch(e){if(version===epoch.current)failed(e);}finally{if(version===epoch.current)setBusy(false);}
  }
  const selected=session?.memberships.findIndex(m=>m.orgId===session.workspace?.orgId && m.workspaceId===session.workspace?.workspaceId)??-1;
  // Session polling must not recreate the model and restart its download/GPU resources.
  const view=useMemo(()=>({results:opened.map(row=>remoteResult(row,title(row))),remote:{meshUrls:Object.fromEntries(opened.filter(r=>r.meshUrl).map(r=>[r.resultId,r.meshUrl!])),overlays:Object.fromEntries(opened.filter(r=>r.overlay).map(r=>[r.resultId,r.overlay!]))}}),[opened]);
  return <main className="desktop-shell web-viewer">
    <header className="viewer-nav"><strong>EXMO <span>Results Viewer</span></strong><span className="viewer-readonly">{t('읽기 전용')}</span>
      {session?.signedIn && <label className="viewer-workspace"><span>{t('작업공간')}</span><select aria-label={t('작업공간')} value={selected} disabled={busy} onChange={e=>{const m=session.memberships[Number(e.target.value)];if(m)void action('workspace',{orgId:m.orgId,workspaceId:m.workspaceId});}}>
        <option value={-1} disabled>{t('작업공간 선택')}</option>{session.memberships.map((m,i)=><option key={`${m.orgId}/${m.workspaceId}`} value={i}>{m.name} · {m.orgId}</option>)}</select></label>}
      <LanguageSelect/>{session?.signedIn && <button className="clinical-button" disabled={busy} onClick={()=>void action('logout')}>{t('로그아웃')}</button>}
    </header>
    {error && <div className="viewer-error" role="alert">{error} <button className="clinical-button" onClick={()=>void refresh()}>{t('새로고침')}</button></div>}
    {!session?.signedIn ? <section className="viewer-signin"><h1>{t('서버 결과 열람')}</h1><p>{t('계정에 허용된 기관·작업공간의 측정값, QC, 대표 Overlay와 3D를 확인합니다.')}</p>
      <button className="clinical-button" disabled={!session||busy} onClick={()=>void action('login')}>{t('로그인')}</button></section>
      : !session.scopeKey ? <section className="viewer-signin"><h1>{t('작업공간 선택')}</h1><p>{session.memberships.length?t('상단에서 열람할 작업공간을 선택하세요.'):t('열람 권한이 있는 작업공간이 없습니다. 기관 관리자에게 문의하세요.')}</p></section>
      : <><div className="viewer-browse" hidden={opened.length>0}><ResultList key={session.scopeKey} rows={rows} busy={busy} onOpen={(items,compare)=>void open(items,compare)} onRefresh={()=>void refresh()}/></div>
      {opened.length>0&&<div className="viewer-detail"><p className="remote-disclosure" role="status">{reference?t('나란히 열람 · 촬영 범위와 측정 조건의 동일성을 보증하지 않습니다.'):t('게시된 고정 결과 · 읽기 전용')}</p>
        <ResultView key={opened.map(r=>r.resultId+':'+r.attachmentRevision).join(',')} results={view.results} onClose={close} onUpdate={()=>{}}
          heading={opened.length===1?title(opened[0]):reference?t('나란히 열람'):t('수치 비교')} description={t('서버에 게시된 측정값과 QC · 원본 영상 없음')}
          remote={view.remote}/></div>}</>}
    {busy && <p className="viewer-loading" role="status">{t('서버 결과 확인 중')}</p>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Viewer/>);
