import {useRef,useState} from 'react';
import type {RemoteSummary} from '../../desktop/ui/imaging';
import {remoteGroups,remoteStudy} from '../../desktop/ui/remote-selection';
import {t} from '../../desktop/ui/language';

export const resultTitle=(row:RemoteSummary)=>`Case ${(row.context?.caseId||row.resultId).slice(0,8)}`;
export default function ResultList({rows,busy,onOpen,onRefresh}:{rows:RemoteSummary[];busy:boolean;onOpen:(rows:RemoteSummary[],compare?:boolean)=>void;onRefresh:()=>void}){
  const [selection,setSelection]=useState<string[]>([]),[mode,setMode]=useState(false),[query,setQuery]=useState(''),[error,setError]=useState('');
  const selectionRef=useRef(selection);selectionRef.current=selection;
  const selected=rows.filter(row=>selection.includes(row.resultId));
  function toggle(row:RemoteSummary){
    setError('');
    const ids=selectionRef.current.filter(id=>rows.some(r=>r.resultId===id));
    if(ids.includes(row.resultId))selectionRef.current=ids.filter(id=>id!==row.resultId);
    else if(ids.length<3)selectionRef.current=[...ids,row.resultId];
    else {setError(t('최대 3개까지 선택할 수 있습니다. 선택한 행을 다시 누르면 해제됩니다.'));return;}
    setSelection(selectionRef.current);
  }
  // Filter whole studies, so searching AP cannot silently hide the companion lateral views.
  const groups=remoteGroups(rows).filter(group=>group.items.some(row=>[resultTitle(row),row.context?.studyId,row.resultId,row.analysis,row.route,row.variant].join(' ').toLowerCase().includes(query.toLowerCase())));
  return <section className="viewer-results">
    <header><div><h1 tabIndex={-1}>{t('서버 결과')}</h1><p>{t('게시된 고정 결과 · 읽기 전용')}</p></div>
      <input aria-label={t('서버 결과 검색')} placeholder={t('서버 결과 검색')} value={query} onChange={e=>setQuery(e.target.value)}/>
      <button className="clinical-button" onClick={onRefresh} disabled={busy}>{t('새로고침')}</button></header>
    <div className="remote-toolbar">
      <button className="clinical-button" aria-pressed={mode} onClick={()=>setMode(!mode)}>{t('비교 선택')} · {selected.length}/3</button>
      {mode&&<><button className="clinical-button" disabled={busy||selected.length<2} onClick={()=>onOpen(selected,true)}>{t('수치 비교')}</button>
        <button className="clinical-button" disabled={busy||selected.length<2} onClick={()=>onOpen(selected)}>{t('나란히 열람')}</button>
        <button className="text-button" disabled={!selected.length} onClick={()=>{selectionRef.current=[];setSelection([]);setError('');}}>{t('선택 해제')}</button></>}
    </div>
    {error&&<p role="alert" className="inline-error">{error}</p>}
    <p className="metric-note">{t('최신 게시 결과 200건 · 서버 식별자는 가명입니다. 원본 환자명과 촬영일은 전송하지 않습니다.')}</p>
    <div className="viewer-table"><table><thead><tr>{mode&&<th>{t('선택')}</th>}<th>Case / Study</th><th>Modality</th><th>{t('결과')}</th><th>Overlay / 3D</th></tr></thead><tbody>
      {groups.flatMap(group=>{
        const study=remoteStudy(group.items);
        return [group.study&&<tr className="viewer-study" key={group.key}><td colSpan={mode?5:4}>
          <strong>{resultTitle(group.items[0])} · Study {group.items[0].context!.studyId.slice(0,8)}</strong><span> · LT → AP → RT</span>
          <button className="clinical-button" disabled={busy||study.ambiguous} onClick={()=>onOpen(group.items)}>{t('촬영 묶음 열기')}</button>
          {study.missing.length>0&&<small>{study.missing.map(v=>v.replace('LAT_','')).join(' / ')} · {t('미게시')}</small>}
          {study.ambiguous&&<small>{t('같은 방향의 결과가 여러 개이거나 방향이 불명확합니다. 비교 선택에서 직접 고르세요.')}</small>}
        </td></tr>,...group.items.map(row=><tr key={row.resultId} data-remote-id={row.resultId} tabIndex={0} aria-selected={mode?selection.includes(row.resultId):undefined}
          aria-label={`${resultTitle(row)} ${row.analysis.toUpperCase()} ${row.route||''}`}
          onClick={()=>!busy&&(mode?toggle(row):onOpen([row]))}
          onKeyDown={e=>{if(e.target===e.currentTarget&&['Enter',' '].includes(e.key)){e.preventDefault();if(!busy)mode?toggle(row):onOpen([row]);}}}>
          {mode&&<td><input type="checkbox" aria-label={t('{{value0}} 선택',{value0:resultTitle(row)})} checked={selection.includes(row.resultId)} disabled={busy} onClick={e=>e.stopPropagation()} onChange={()=>toggle(row)}/></td>}
          <td><strong>{resultTitle(row)}</strong><small>{row.context?`Study ${row.context.studyId.slice(0,8)}`:t('Study 미연결')}</small></td>
          <td>{row.analysis.toUpperCase()} {row.route?.replaceAll('_','-')}</td><td>{row.variant.toUpperCase()} · {row.unit}<small>{row.resultId.slice(0,8)}</small></td>
          <td>{row.overlayState==='ready'?'Overlay':'—'} / {row.meshState==='ready'?'3D':row.meshState==='pending'?t('준비 중'):'—'}</td>
        </tr>)];
      })}
    </tbody></table></div>
    {!groups.length&&<p className="clinical-empty">{t('표시할 서버 결과가 없습니다.')}</p>}
  </section>;
}
