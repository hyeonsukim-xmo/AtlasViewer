import {useEffect,useState} from 'react';
import type {RemoteOverlay} from './imaging';
import {t} from './language';
export default function RemoteOverlayImage({overlay}:{overlay?:RemoteOverlay}){
  const [error,setError]=useState(false);useEffect(()=>setError(false),[overlay?.url]);
  if(!overlay?.url)return <div className="clinical-empty remote-preview-note"><strong>{t('게시된 측정·QC 결과')}</strong><span>{t('승인된 대표 Overlay가 없습니다. 원본 슬라이스 열람은 제공하지 않습니다.')}</span></div>;
  return <div className="remote-overlay">
    <p className="metric-note">{t('대표 이미지 · 전체 슬라이스 아님')} · {overlay.capture.view} · {overlay.capture.index+1}/{overlay.capture.count} · Overlay {Math.round(overlay.capture.opacity*100)}%</p>
    {error?<p role="alert">{t('대표 이미지를 불러오지 못했습니다. 서버 결과를 새로고침하세요.')}</p>:<div className="medical-image"><img src={overlay.url} alt={t('게시된 대표 Overlay')} onError={()=>setError(true)} draggable={false}/>{overlay.capture.orientation.map((side,i)=><span key={i} className={`orientation orientation-${i}`}>{side}</span>)}</div>}
    <p className="metric-note">{overlay.privacyReview.redacted?t('식별 영역 제거 사본'):t('식별정보 검토 완료 사본')} · {t('게시된 고정 이미지 · 구조 선택과 무관')}</p>
  </div>;
}
