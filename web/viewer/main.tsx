import {createRoot} from 'react-dom/client';
import {useEffect,useMemo,useRef,useState} from 'react';
import ResultView from '../../desktop/ui/result-view';
import {remoteResult} from '../../desktop/ui/remote-contract';
import type {RemoteSummary,RemoteDetail} from '../../desktop/ui/imaging';
import LanguageSelect from '../../desktop/ui/language-select';
import {t,useLanguage} from '../../desktop/ui/language';
import '../../app/globals.css';
import '../../desktop/ui/workspace.css';
import './viewer.css';

type Session={signedIn:boolean;csrf:string;subject:string|null;memberships:{orgId:string;workspaceId:string;name:string}[];workspace:{orgId:string;workspaceId:string}|null;scopeKey:string|null};
const title=(r:RemoteSummary)=>`Case ${(r.context?.caseId||r.resultId).slice(0,8)}`;
async function request<T>(url:string,session?:Session,body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(url,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',signal,
    headers:{...(session?.scopeKey?{'X-EXMO-Workspace':session.scopeKey}:{}),...(body===undefined?{}:{'Content-Type':'application/json','X-EXMO-CSRF':session!.csrf})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error),{status:response.status});return value;
}
function Viewer(){
  useLanguage();
  const [session,setSession]=useState<Session|null>(null),[rows,setRows]=useState<RemoteSummary[]>([]),[opened,setOpened]=useState<RemoteDetail|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[query,setQuery]=useState('');
  const epoch=useRef(0),current=useRef<Session|null>(null),detail=useRef<RemoteDetail|null>(null),controller=useRef<AbortController|null>(null);
  const mutating=useRef(false),refreshNumber=useRef(0);
  const channel=useRef<BroadcastChannel|null>(null),list=useRef<HTMLHeadingElement>(null);
  function clear(){epoch.current++;controller.current?.abort();controller.current=null;detail.current=null;setOpened(null);setRows([]);setQuery('');setBusy(false);}
  function failed(e:unknown){if(e instanceof DOMException && e.name==='AbortError')return;clear();setError(t('서버 연결 또는 접근 권한을 확인한 뒤 다시 로그인하거나 새로고침하세요.')+(e instanceof Error && /^[A-Z_]+$/.test(e.message)?` (${e.message})`:''));}
  async function refresh(){
    if(mutating.current)return;let version=epoch.current;const sequence=++refreshNumber.current;
    try{
      const next=await request<Session>('/api/session');if(version!==epoch.current||sequence!==refreshNumber.current)return;
      if(next.scopeKey!==current.current?.scopeKey || next.subject!==current.current?.subject)clear();
      current.current=next;setSession(next);version=epoch.current;
      if(next.signedIn && next.scopeKey){
        const values=await request<RemoteSummary[]>('/api/results',next);if(version!==epoch.current||sequence!==refreshNumber.current)return;setRows(values);
        if(detail.current){const row=values.find(r=>r.resultId===detail.current!.resultId);
          if(!row){detail.current=null;setOpened(null);}else if(row.attachmentRevision!==detail.current.attachmentRevision)await open(row,next);
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
  async function open(row:RemoteSummary,s=current.current){
    if(!s)return;controller.current?.abort();controller.current=new AbortController();const signal=controller.current.signal,version=++epoch.current;
    detail.current=null;setOpened(null);setBusy(true);setError('');
    try{const value=await request<RemoteDetail>('/api/results/'+encodeURIComponent(row.resultId),s,undefined,signal);
      if(version!==epoch.current)return;detail.current=value;setOpened(value);
    }catch(e){if(version===epoch.current)failed(e);}finally{if(version===epoch.current)setBusy(false);}
  }
  const selected=session?.memberships.findIndex(m=>m.orgId===session.workspace?.orgId && m.workspaceId===session.workspace?.workspaceId)??-1;
  const visible=rows.filter(r=>`${title(r)} ${r.context?.studyId||''} ${r.analysis} ${r.route||''}`.toLowerCase().includes(query.toLowerCase()));
  // Session polling must not recreate the model and restart its download/GPU resources.
  const view=useMemo(()=>opened?{results:[remoteResult(opened,title(opened))],remote:{meshUrls:opened.meshUrl?{[opened.resultId]:opened.meshUrl}:{},overlays:opened.overlay?{[opened.resultId]:opened.overlay}:{}}}:null,[opened]);
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
      : opened && view ? <div className="viewer-detail"><p className="remote-disclosure">{t('게시된 고정 결과 · 읽기 전용')}</p>
        <ResultView key={opened.resultId+':'+opened.attachmentRevision} results={view.results} onClose={()=>{controller.current?.abort();epoch.current++;detail.current=null;setOpened(null);setTimeout(()=>list.current?.focus(),0);}} onUpdate={()=>{}}
          heading={title(opened)} description={t('서버에 게시된 측정값과 QC · 원본 영상 없음')}
          remote={view.remote}/></div>
      : <section className="viewer-results"><header><div><h1 ref={list} tabIndex={-1}>{t('서버 결과')}</h1><p>{t('게시된 고정 결과 · 읽기 전용')}</p></div>
        <input aria-label={t('서버 결과 검색')} placeholder={t('서버 결과 검색')} value={query} onChange={e=>setQuery(e.target.value)}/><button className="clinical-button" onClick={()=>void refresh()} disabled={busy}>{t('새로고침')}</button></header>
        <div className="viewer-table"><table><thead><tr><th>Case / Study</th><th>Modality</th><th>{t('결과')}</th><th>Overlay / 3D</th></tr></thead><tbody>{visible.map(row=><tr key={row.resultId} tabIndex={0} role="button" aria-label={`${title(row)} ${row.analysis.toUpperCase()} ${row.route||''}`} onClick={()=>void open(row)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();void open(row);}}}>
          <td><strong>{title(row)}</strong><small>{row.context?`Study ${row.context.studyId.slice(0,8)}`:'—'}</small></td><td>{row.analysis.toUpperCase()} {row.route?.replaceAll('_','-')}</td><td>{row.variant.toUpperCase()} · {row.unit}</td>
          <td>{row.overlayState==='ready'?'Overlay':'—'} / {row.meshState==='ready'?'3D':row.meshState==='pending'?t('준비 중'):'—'}</td></tr>)}</tbody></table></div>
        {!visible.length && <p className="clinical-empty">{t('표시할 서버 결과가 없습니다.')}</p>}
      </section>}
    {busy && <p className="viewer-loading" role="status">{t('서버 결과 확인 중')}</p>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Viewer/>);
