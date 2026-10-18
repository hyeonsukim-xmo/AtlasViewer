import {useEffect, useState} from 'react';
import {Dialog, DialogContent, DialogTitle, DialogDescription} from '../../components/ui/dialog';
import {unwrap, type Analysis, type InstallationState, type InstallationChoice} from './imaging';
import {failureText} from './diagnostics';
import {t, useLanguage} from './language';

export function installationLabel(state?: string) {
  switch(state){
    case 'ready': return t('설치됨');
    case 'installed': return t('설치됨 · 실행 전 검증');
    case 'verifying': return t('설치 파일 검증 중');
    case 'installing': return t('설치 중');
    case 'repair-required': return t('복구 필요');
    case 'install-failed': return t('설치 변경 실패');
    default: return t('설치 필요');
  }
}
export default function InstallationManager({openRequest=0}:{openRequest?:number}){
  useLanguage();
  const [open,setOpen]=useState(false),[state,setState]=useState<InstallationState>(),[choice,setChoice]=useState<InstallationChoice|null>(null);
  const [selected,setSelected]=useState<Analysis[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(openRequest)setOpen(true);},[openRequest]);
  useEffect(()=>{
    if(!window.exmoDesktop.installations)return;
    let alive=true;
    void window.exmoDesktop.installations().then(unwrap).then(v=>{if(alive)setState(v);}).catch(()=>{});
    const off=window.exmoDesktop.onInstallationsChanged(v=>{if(alive)setState(v);});
    return ()=>{alive=false;off();};
  },[]);
  if(!state?.supported)return null;
  const working=busy||state.busy;
  async function action(run:()=>Promise<InstallationState>){setBusy(true);setError('');try{setState(await run());}catch(e){setError(failureText(e instanceof Error ? e : String(e)));}finally{setBusy(false);}}
  return <>
    <button className="desktop-demo-link" onClick={()=>setOpen(true)}>{t('솔루션 관리')}</button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="installation-dialog">
      <DialogTitle>{t('솔루션 관리')}</DialogTitle>
      <DialogDescription>{t('필요한 분석을 설치하거나 업데이트합니다. 기존 영상과 결과는 유지됩니다.')}</DialogDescription>
      <table className="clinical-table"><thead><tr><th>Modality</th><th>{t('설치 상태')}</th><th>{t('관리')}</th></tr></thead><tbody>
        {state.solutions.map(row=><tr key={row.analysis}><td><strong>{row.analysis==='xray'?'X-ray':row.analysis.toUpperCase()}</strong><small>{row.version||'—'}</small></td>
          <td>{installationLabel(row.state)}{row.total!=null && <progress max={row.total} value={row.completed??0} aria-label={t('설치 진행률')}/>}</td>
          <td className="installation-actions"><button className="text-button" disabled={working||!row.canRollback} onClick={()=>void action(()=>window.exmoDesktop.rollbackSolution(row.analysis).then(unwrap))}>{t('이전 버전')}</button>
          <button className="text-button" disabled={working||!row.installed} onClick={()=>void action(()=>window.exmoDesktop.removeSolution(row.analysis).then(unwrap))}>{t('설치 제거')}</button></td></tr>)}
      </tbody></table>
      <button className="clinical-button" disabled={working} onClick={async()=>{
        setBusy(true);setError('');try{const v=unwrap(await window.exmoDesktop.chooseInstallation());setChoice(v);setSelected(v?.choices.filter(c=>c.authorized).map(c=>c.analysis)??[]);}catch(e){setError(failureText(e instanceof Error ? e : String(e)));}finally{setBusy(false);}
      }}>{t('패키지 폴더 선택')}</button>
      {choice && <fieldset disabled={working} className="installation-choice"><legend>{t('설치할 분석')} · {choice.version}</legend>
        {choice.choices.map(row=><label key={row.analysis}><input type="checkbox" checked={selected.includes(row.analysis)} disabled={!row.authorized} onChange={e=>setSelected(previous=>e.target.checked?[...previous,row.analysis]:previous.filter(n=>n!==row.analysis))}/>
          <strong>{row.analysis==='xray'?'X-ray':row.analysis.toUpperCase()}</strong><span>{(row.bytes/1024**3).toFixed(2)} GB{!row.authorized?' · '+t('승인 필요'):''}</span></label>)}
        <small>{t('공용 Viewer와 공유 실행환경은 한 번만 저장합니다.')}</small>
        <button className="clinical-button primary" disabled={working||selected.length===0} onClick={()=>void action(()=>window.exmoDesktop.installSolutions(choice.id,selected).then(unwrap))}>{t('선택 항목 설치·업데이트')}</button>
      </fieldset>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </DialogContent></Dialog>
  </>;
}
