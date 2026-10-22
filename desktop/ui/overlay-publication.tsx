import {useEffect,useRef,useState} from 'react';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '../../components/ui/dialog';
import {unwrap,type OverlayDraft,type PublicationRef,type PreviewOptions,type Redaction} from './imaging';
import {useAccountState} from './account-state';
import {t,useLanguage} from './language';

export default function OverlayPublication({reference,options,disabled}:{reference:PublicationRef;options:Required<PreviewOptions>;disabled:boolean}){
  useLanguage();const api=window.exmoDesktop,account=useAccountState();
  const [open,setOpen]=useState(false),[draft,setDraft]=useState<OverlayDraft>(),[final,setFinal]=useState<OverlayDraft>();
  const [rects,setRects]=useState<Redaction[]>([]),[box,setBox]=useState<Redaction>({x:0,y:0,width:30,height:20});
  const [checked,setChecked]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState(false),[loaded,setLoaded]=useState(false);
  const [zoom,setZoom]=useState(1);
  const drag=useRef<{x:number;y:number}|null>(null),draftId=useRef<string|null>(null),epoch=useRef(0);
  const member=account?.me?.memberships.find(m=>m.orgId===account.workspace?.orgId&&m.workspaceId===account.workspace?.workspaceId);
  const binding=JSON.stringify([account?.state,account?.me?.subject,account?.workspace,member?.roles]);
  function close(){epoch.current++;setOpen(false);setDraft(undefined);setFinal(undefined);setChecked(false);drag.current=null;if(draftId.current)void api.overlayDiscard(draftId.current);draftId.current=null;}
  useEffect(()=>{close();return()=>{epoch.current++;if(draftId.current)void api.overlayDiscard(draftId.current);};},[binding,reference.id,reference.revision]);
  async function create(){
    const generation=++epoch.current;setOpen(true);setBusy(true);setError('');setDone(false);setRects([]);setChecked(false);setFinal(undefined);setZoom(1);
    try{const value=unwrap(await api.overlayCreate(reference,options));if(generation!==epoch.current){void api.overlayDiscard(value.id);return;}draftId.current=value.id;setDraft(value);}
    catch(e){if(generation===epoch.current)setError(e instanceof Error?e.message:'PUBLICATION_REQUEST_FAILED');}
    finally{if(generation===epoch.current)setBusy(false);}
  }
  async function act(approve=false){
    if(!draft)return;const generation=epoch.current;setBusy(true);setError('');
    try{if(approve&&final&&checked&&loaded){unwrap(await api.overlayApprove(final.id,final.sha256));if(generation===epoch.current){setDone(true);draftId.current=null;}}
      else{const value=unwrap(await api.overlayRedact(draft.id,rects));if(generation===epoch.current){setLoaded(false);setFinal(value);setChecked(false);}}}
    catch(e){if(generation===epoch.current)setError(e instanceof Error?e.message:'PUBLICATION_REQUEST_FAILED');}
    finally{if(generation===epoch.current)setBusy(false);}
  }
  function add(r:Redaction){if(!draft||rects.length>=64)return;if(Object.values(r).every(Number.isInteger)&&r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.x+r.width<=draft.width&&r.y+r.height<=draft.height)setRects([...rects,r]);}
  const point=(e:React.PointerEvent<HTMLDivElement>)=>{const r=e.currentTarget.getBoundingClientRect();return {x:Math.max(0,Math.min(draft!.width,Math.round((e.clientX-r.left)*draft!.width/r.width))),y:Math.max(0,Math.min(draft!.height,Math.round((e.clientY-r.top)*draft!.height/r.height)))};};
  return <>
    <button className="text-button" disabled={disabled||!member?.roles.includes('analyst')} title={t('로그인한 게시 권한 계정으로 현재 슬라이스의 표시 사본을 검토합니다.')} onClick={()=>void create()}>{t('대표 Overlay 게시')}</button>
    <Dialog open={open} onOpenChange={value=>{if(!value)close();}}><DialogContent closeLabel={t('닫기')} className="installation-dialog overlay-review-dialog">
      <DialogTitle>{final?t('최종 게시 사본 확인'):t('대표 Overlay · 개인정보 검토')}</DialogTitle>
      <DialogDescription>{t('결과별 대표 이미지 한 장을 게시합니다. 이름·환자번호 등 식별 영역을 가린 뒤 최종 사본을 확인하세요. 원본과 분석 결과는 변경하지 않습니다.')}</DialogDescription>
      <p className="metric-note">{account?.workspace?.orgId} · {account?.workspace?.workspaceId}</p>
      {done?<p role="status">{t('승인된 사본을 전송 대기열에 추가했습니다. 전송 현황에서 진행 상태를 확인하세요.')}</p>:draft&&<>
        <p className="metric-note">{draft.capture.view} · {draft.capture.index+1}/{draft.capture.count} · Overlay {Math.round(draft.capture.opacity*100)}% · {t('대표 이미지 · 전체 슬라이스 아님')}</p>
        <label className="overlay-zoom">{t('확대')}<input aria-label={t('게시 사본 확대')} type="range" min="1" max="4" step="0.25" value={zoom} onChange={e=>setZoom(Number(e.target.value))}/>{zoom}×</label>
        <div className="overlay-review-viewport"><div className="overlay-review-image" onPointerDown={e=>{if(final||busy||e.button!==0)return;e.preventDefault();drag.current=point(e);e.currentTarget.setPointerCapture(e.pointerId);}}
          onPointerUp={e=>{if(!drag.current)return;const start=drag.current,end=point(e);drag.current=null;add({x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(end.x-start.x),height:Math.abs(end.y-start.y)});if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}
          onPointerCancel={()=>{drag.current=null;}} onLostPointerCapture={()=>{drag.current=null;}}>
          <img key={final?'final:'+final.sha256:'edit'} style={{height:`${48*zoom}vh`}} src={(final??draft).image} alt={final?t('최종 게시 사본'):t('개인정보 가림 영역 편집')} draggable={false} onLoad={()=>setLoaded(true)} onError={()=>{setLoaded(false);setChecked(false);setError('PUBLICATION_IMAGE_INVALID');}}/>
          {!final&&<svg viewBox={`0 0 ${draft.width} ${draft.height}`} aria-hidden="true">{rects.map((r,i)=><rect key={i} {...r} fill="black" stroke="#aaa1c8" strokeWidth="1"/>)}</svg>}
        </div></div>
        {!final?<>
          <p className="metric-note">{t('이미지 위를 드래그해 가릴 영역을 추가하세요. 좌표 입력으로도 추가할 수 있습니다.')}</p>
          <div className="overlay-redaction-fields">{(['x','y','width','height'] as const).map(key=><label key={key}>{key}<input type="number" min={key==='x'||key==='y'?0:1} max={key==='x'||key==='width'?draft.width:draft.height} value={box[key]} onChange={e=>setBox({...box,[key]:Number(e.target.value)})}/></label>)}
            <button className="clinical-button" disabled={busy||rects.length>=64} onClick={()=>add(box)}>{t('가림 영역 추가')}</button>
            <button className="text-button" disabled={!rects.length||busy} onClick={()=>setRects(rects.slice(0,-1))}>{t('마지막 가림 취소')}</button></div>
          <button className="clinical-button" disabled={busy} onClick={()=>void act()}>{t('최종 사본 검토')}</button>
        </>:<>
          <label className="overlay-approval"><input type="checkbox" checked={checked} disabled={busy||!loaded} onChange={e=>setChecked(e.target.checked)}/>{t('위 최종 사본에서 허용되지 않은 식별정보가 제거되었음을 확인했습니다.')}</label>
          <div className="account-actions"><button className="clinical-button" disabled={busy||!checked||!loaded} onClick={()=>void act(true)}>{t('확인한 사본과 결과 게시')}</button><button className="text-button" disabled={busy} onClick={()=>{setFinal(undefined);setChecked(false);}}>{t('가림 수정')}</button></div>
          <small className="overlay-hash">SHA-256 · {final.sha256}</small>
        </>}
      </>}
      {busy&&<p role="status">{t('표시 사본 준비 중')}</p>}
      {error&&<p className="inline-error" role="alert">{error==='PUBLICATION_OVERLAY_PENDING'?t('이 결과의 대표 이미지가 전송 중입니다. 완료 후 다시 게시하세요.'):t('게시 사본을 준비하지 못했습니다. 계정·게시 권한·결과 상태를 확인한 뒤 다시 시도하세요.')} · {error}</p>}
    </DialogContent></Dialog>
  </>;
}
