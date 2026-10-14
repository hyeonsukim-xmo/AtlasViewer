import { useEffect, useRef, useState } from "react";
import { t, useLanguage } from "./language";
import { patientIdentifier } from "./patient-groups";
import { unwrap, type Analysis, type ImagingFile } from "./imaging";

export default function PatientAssignment({analysis, files, onClose, onSaved}: {
  analysis: Analysis; files: ImagingFile[]; onClose: () => void; onSaved: () => Promise<void>;
}) {
  useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const common = (field: "patientId" | "patientIssuer") => {
    const values = new Set(files.map(file => patientIdentifier(file.metadata?.[field])));
    return values.size === 1 ? [...values][0] : "";
  };
  const [patientId, setPatientId] = useState(() => common("patientId"));
  const [issuer, setIssuer] = useState(() => common("patientIssuer"));
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {dialog.current?.showModal();}, []);
  async function save(reset = false) {
    setSaving(true); setError("");
    try {
      unwrap(await window.exmoDesktop.assignPatientStudy(analysis, files.map(file => file.id), reset ? null : {
        patientId, patientIssuer: issuer, studyDate: date,
      }));
      await onSaved(); onClose();
    } catch (error) {setError((error as Error).message);}
    finally {setSaving(false);}
  }
  return <dialog ref={dialog} className="comparison-dialog patient-assignment" aria-labelledby="patient-assignment-title"
    onCancel={event => {if (saving) event.preventDefault(); else onClose();}}>
    <form onSubmit={event => {event.preventDefault(); void save();}}>
      <header><h2 id="patient-assignment-title">{t("환자·날짜 지정")}</h2>
        <button type="button" className="clinical-button" disabled={saving} onClick={onClose}>{t("닫기")}</button></header>
      <p>{t("선택한 {{value0}}개 영상에 적용합니다. 같은 환자의 영상인지 확인하세요.", {value0: files.length})}</p>
      <label>{t("병록번호 또는 관리용 환자 ID")}<input autoFocus required maxLength={120} value={patientId} disabled={saving} onChange={e => setPatientId(e.target.value)} /></label>
      <label>{t("기관 또는 데이터셋 이름")}<input required maxLength={120} value={issuer} disabled={saving} onChange={e => setIssuer(e.target.value)} /></label>
      <label>{t("촬영일 변경 (선택)")}<input type="date" value={date} disabled={saving} onChange={e => setDate(e.target.value)} /></label>
      <p>{t("촬영일을 비워두면 각 영상의 기존 날짜를 유지합니다. 원본 파일은 변경하지 않습니다.")}</p>
      {error && <p className="inline-error" role="alert">{t(error)}</p>}
      <footer><button type="button" className="text-button" disabled={saving || !files.some(file => file.metadata?.patientAssigned)} onClick={() => void save(true)}>{t("원본 환자 정보로 복원")}</button>
        <button className="clinical-button primary" disabled={saving}>{saving ? t("저장 중") : t("적용")}</button></footer>
    </form>
  </dialog>;
}
