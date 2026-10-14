import { Fragment, useRef, useState, type ReactNode } from "react";
import { t, useLanguage } from "./language";
import { groupPatients, type PatientGroup } from "./patient-groups";
import type { ImagingFile } from "./imaging";

export type ReviewStudy = {key: string; label: string; items: ImagingFile[]; summary?: ReactNode};
const ready = (file: ImagingFile) => file.ready;

function GroupSelection({items, selected, busy, onSelect, label, canSelect = ready}: {
  items: ImagingFile[]; selected: string[]; busy: boolean; onSelect: (ids: string[], value: boolean, shift?: boolean) => void; label: string;
  canSelect?: (file: ImagingFile) => boolean;
}) {
  const ids = items.filter(canSelect).map(file => file.id);
  const count = ids.filter(id => selected.includes(id)).length;
  return <input type="checkbox" aria-label={label} checked={ids.length > 0 && count === ids.length}
    ref={input => {if (input) input.indeterminate = count > 0 && count < ids.length;}}
    disabled={busy || !ids.length} onChange={event => onSelect(ids, event.target.checked, !!(event.nativeEvent as MouseEvent).shiftKey)} />;
}

export default function PatientGroupsView({items, selected, busy, onSelect, mode, children, onAssign, analyzedInputs, canSelect = ready, studiesFor, renderStudy}: {
  items: ImagingFile[]; selected: string[]; busy: boolean; onSelect: (ids: string[], value: boolean) => void;
  mode: "input" | "review"; children: (file: ImagingFile, select: (value: boolean, shift?: boolean) => void) => ReactNode; onAssign: (files: ImagingFile[]) => void;
  analyzedInputs?: ReadonlySet<string>;
  canSelect?: (file: ImagingFile) => boolean;
  studiesFor?: (files: ImagingFile[]) => ReviewStudy[];
  renderStudy?: (study: ReviewStudy, renderFile: (file: ImagingFile) => ReactNode) => ReactNode;
}) {
  useLanguage();
  const historyItems = mode === "input" ? items.filter(file => analyzedInputs?.has(file.id)) : [];
  const pendingItems = mode === "input" ? items.filter(file => !analyzedInputs?.has(file.id)) : items;
  const scopedGroups = (files: ImagingFile[], section: string) => groupPatients(files).map(patient => ({...patient,
    key: JSON.stringify([section, patient.key]), dates: patient.dates.map(date => ({...date, key: JSON.stringify([section, date.key])})),
  }));
  const pendingGroups = scopedGroups(pendingItems, "pending"), historyGroups = scopedGroups(historyItems, "history");
  const groups = [...pendingGroups, ...historyGroups];
  const [historyOpen, setHistoryOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [pages, setPages] = useState<Record<string, number>>({});
  const anchor = useRef<{level: "patient" | "date" | "study" | "series"; key: string} | null>(null);
  const toggle = (key: string, patient: boolean) => setCollapsed(old => ({...old, [key]: isOpen(key, patient)}));
  const select = (files: ImagingFile[], label: string) => <GroupSelection items={files} selected={selected} busy={busy} canSelect={canSelect} onSelect={(ids, value) => {anchor.current = null; onSelect(ids, value);}} label={label} />;
  const patientStartsCollapsed = (key: string) => mode === "input" && (historyGroups.some(group => group.key === key)
    ? key !== historyGroups[0]?.key : pendingGroups.length > 8 && key !== pendingGroups[0]?.key);
  const isOpen = (key: string, patient: boolean) => !(collapsed[key] ?? (mode === "input" &&
    (patient ? patientStartsCollapsed(key) : groups.some(p => p.dates.some(d => d.key === key && !d.date && d.items.length > 12)))));
  const studies = (date: {key: string; items: ImagingFile[]}) => (studiesFor?.(date.items) || []).map(study => ({...study, key: JSON.stringify([date.key, study.key])}));
  const choose = (level: "patient" | "date" | "study" | "series", key: string, files: ImagingFile[], value: boolean, shift = false) => {
    if (busy || !files.some(canSelect)) return;
    const visiblePatients = [...(historyOpen ? historyGroups : []), ...pendingGroups];
    const visibleDates = visiblePatients.filter(patient => isOpen(patient.key, true)).flatMap(patient => patient.dates);
    const openDates = visibleDates.filter(date => isOpen(date.key, false));
    const visibleStudies = openDates.flatMap(studies);
    const rows = level === "patient" ? visiblePatients : level === "date" ? visibleDates : level === "study" ? visibleStudies
      : (studiesFor ? visibleStudies.filter(study => isOpen(study.key, false)) : openDates).flatMap(group => group.items.map(file => ({key: file.id, items: [file]})));
    const start = anchor.current?.level === level ? rows.findIndex(row => row.key === anchor.current?.key) : -1;
    const end = rows.findIndex(row => row.key === key);
    const ranged = shift && start >= 0 && end >= 0;
    const affected = ranged ? rows.slice(Math.min(start, end), Math.max(start, end) + 1).flatMap(row => row.items) : files;
    if (!ranged) anchor.current = {level, key};
    onSelect([...new Set(affected.filter(canSelect).map(file => file.id))], ranged ? true : value);
  };
  const renderFile = (file: ImagingFile) => children(file, (value, shift) => choose("series", file.id, [file], value, shift));
  const heading = (key: string, label: string, files: ImagingFile[], patient = false, study = false) => {
    const eligible = files.filter(canSelect), allSelected = eligible.length > 0 && eligible.every(file => selected.includes(file.id));
    const pick = (value: boolean, shift = false) => choose(patient ? "patient" : study ? "study" : "date", key, files, value, shift);
    const count = <span className="group-count">{t("{{value0}}개 영상 · {{value1}}개 선택", {value0: files.length, value1: files.filter(f => selected.includes(f.id)).length})}</span>;
    return <div className={`patient-group-heading ${patient ? "patient-level" : study ? "study-level" : "date-level"}${mode === "input" ? " pickable-group" : ""}`} data-selected={files.some(file => selected.includes(file.id))}
      onClick={event => {if (mode === "input" && !(event.target as Element).closest("button, input")) pick(!allSelected, event.shiftKey);}}>
    <GroupSelection items={files} selected={selected} busy={busy} canSelect={canSelect} onSelect={(_ids, value, shift) => pick(value, shift)} label={t("{{value0}} 그룹 선택", {value0: label})} />
    <button className="group-disclosure" aria-expanded={isOpen(key, patient)} onClick={() => toggle(key, patient)}>
      <span aria-hidden="true">{isOpen(key, patient) ? "▾" : "▸"}</span><strong>{label}</strong>
      {mode === "review" && count}
    </button>
    {mode === "input" ? <button className="group-select-area" disabled={busy || !eligible.length} aria-pressed={allSelected}
      aria-label={t("{{value0}} 그룹 선택", {value0: label})} onClick={event => pick(!allSelected, event.shiftKey)}>
      {count}<span className="group-select-label">{allSelected ? t("선택 해제") : t("케이스 선택")}</span>
    </button> : <button className="text-button" disabled={busy || !files.some(f => f.metadata)}
      onClick={() => onAssign(files.filter(f => f.metadata))}>{t("환자·날짜 지정")}</button>
    }
  </div>;
  };
  const renderGroups = (patientGroups: PatientGroup[]) => patientGroups.map(patient => {
    const failed = patient.items.every(file => !file.metadata && !file.ready);
    const label = failed ? t("가져오기 실패") : patient.patientId ? `${patient.patientId}${patient.name && patient.name !== patient.patientId ? ` · ${patient.name}` : ""}${patient.issuer ? ` · ${patient.issuer}` : ""}` : t("환자 미지정");
    const patientHeader = heading(patient.key, label, patient.items, true);
    return <Fragment key={patient.key}>
      {mode === "input" ? <tr className="patient-header-row"><td colSpan={4}>{patientHeader}</td></tr> : patientHeader}
      {isOpen(patient.key, true) && patient.dates.map(group => {
        if (failed && mode === "input") return <Fragment key={group.key}>{group.items.map(renderFile)}</Fragment>;
        const dateHeader = heading(group.key, group.date || t("촬영일 미지정"), group.items);
        const pageCount = Math.ceil(group.items.length / 4);
        const page = Math.min(pages[group.key] || 0, pageCount - 1);
        return <Fragment key={group.key}>
          {mode === "input" ? <tr className="date-header-row"><td colSpan={4}>{dateHeader}</td></tr> : dateHeader}
          {isOpen(group.key, false) && (studiesFor ? studies(group).map(study => <Fragment key={study.key}>
            {mode === "input" ? <tr className="study-header-row"><td colSpan={4}>{heading(study.key, study.label, study.items, false, true)}{study.summary}</td></tr> : heading(study.key, study.label, study.items, false, true)}
            {isOpen(study.key, false) && (renderStudy && mode === "review" ? renderStudy(study, renderFile) : study.items.map(renderFile))}
          </Fragment>) : mode === "input" ? group.items.map(renderFile) : <section className="review-date-group" data-group-key={group.key}>
            {pageCount > 1 && <nav className="review-pagination" aria-label={t("{{value0}} 검토 페이지", {value0: group.date || t("촬영일 미지정")})}>
              <span>{t("{{value0}}–{{value1}} / {{value2}}개 영상", {value0: page * 4 + 1, value1: Math.min((page + 1) * 4, group.items.length), value2: group.items.length})}</span>
              <button className="clinical-button" disabled={page === 0} onClick={() => setPages(old => ({...old, [group.key]: page - 1}))}>{t("이전 페이지")}</button>
              <span>{page + 1} / {pageCount}</span>
              <button className="clinical-button" disabled={page + 1 >= pageCount} onClick={() => setPages(old => ({...old, [group.key]: page + 1}))}>{t("다음 페이지")}</button>
            </nav>}
            <div className="review-grid">{group.items.slice(page * 4, page * 4 + 4).map(renderFile)}</div>
          </section>)}
        </Fragment>;
      })}
    </Fragment>;
  });
  if (mode === "review") return <div className="grouped-review">{renderGroups(pendingGroups)}</div>;
  return <table className="clinical-table series-table"><colgroup><col style={{width: 80}} /><col /><col style={{width: 72}} /><col style={{width: 108}} /></colgroup><thead><tr>
    <th>{select(items, t("검색된 영상 전체 선택"))}</th><th>{t("환자 / 촬영일 / 시리즈")}</th><th>{t("영상")}</th><th>{t("상태")}</th>
  </tr></thead>
    {!!historyItems.length && <tbody className="analysis-history">
      <tr className="analysis-history-header"><td colSpan={4}>
        <button className="group-disclosure" aria-expanded={historyOpen} onClick={() => setHistoryOpen(open => !open)}>
          <span aria-hidden="true">{historyOpen ? "▾" : "▸"}</span><strong>{t("분석 이력 있음")}</strong>
          <span className="group-count">{t("{{value0}}개 영상 · {{value1}}개 선택", {value0: historyItems.length, value1: historyItems.filter(file => selected.includes(file.id)).length})}</span>
          <span className="history-toggle-label">{historyOpen ? t("목록 접기") : t("목록 펼치기")}</span>
        </button>
        {historyOpen && <p className="history-note">{t("분석 이력이 있는 study · 미분석 시리즈 포함")}</p>}
      </td></tr>
      {historyOpen && renderGroups(historyGroups)}
    </tbody>}
    <tbody className="pending-studies">
      {!!historyItems.length && !!pendingItems.length && <tr className="pending-studies-header"><td colSpan={4}>{t("분석 이력 없음")}</td></tr>}
      {renderGroups(pendingGroups)}
    </tbody>
  </table>;
}
