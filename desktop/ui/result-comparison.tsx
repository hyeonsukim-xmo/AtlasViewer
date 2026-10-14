import { useRef, useState } from "react";
import { t, useLanguage, localeTag } from "./language";
import type { AnalysisResult } from "./imaging";

export type ComparisonActions = {
  available: AnalysisResult[];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
};

export default function ResultComparison({results, actions}: {results: AnalysisResult[]; actions: ComparisonActions}) {
  useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const eligible = actions.available.filter(row => row.analysis === results[0].analysis && !results.some(open => open.id === row.id));
  const candidates = eligible.filter(row => [row.metadata.caseName, row.metadata.patientId, row.metadata.studyDate,
    row.metadata.studyDescription, row.metadata.seriesDescription, row.name].join(" ").toLowerCase().includes(query.toLowerCase()));
  return <>
    <button className="clinical-button" disabled={results.length >= 3 || !eligible.length}
      onClick={() => {setQuery(""); dialog.current?.showModal();}}>
      {t("비교 영상 추가 ({{value0}}/3)", {value0: results.length})}
    </button>
    <dialog ref={dialog} className="comparison-dialog" aria-labelledby="comparison-title" onClick={event => {
      if (event.target === event.currentTarget) {
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close();
      }
    }}>
      <header><div><h2 id="comparison-title">{t("비교 영상 추가")}</h2>
        <p>{t("현재 결과를 포함해 최대 3개까지 비교합니다.")}</p></div>
        <button className="clinical-button" onClick={() => dialog.current?.close()}>{t("닫기")}</button></header>
      <input autoFocus className="comparison-search" aria-label={t("비교 결과 검색")} placeholder={t("환자·촬영일·시리즈 검색")}
        value={query} onChange={event => setQuery(event.target.value)} />
      <div className="comparison-candidates">
        {candidates.map(row => <article key={row.id} data-result-id={row.id}>
          <div><strong>{row.metadata.caseName}</strong>
            <span>{row.metadata.patientId && `${row.metadata.patientId} · `}{row.metadata.studyDate || "—"} · {row.variant.toUpperCase()}</span>
            <span>{row.metadata.studyDescription}</span><span>{row.metadata.seriesDescription || row.name}</span>
            <small>{t("분석 일시")}: {new Date(row.createdAt).toLocaleString(localeTag())}</small></div>
          <button className="clinical-button" disabled={results.length >= 3} onClick={() => {
            actions.onAdd(row.id);
            if (results.length >= 2) dialog.current?.close();
          }}>{t("추가")}</button>
        </article>)}
        {!candidates.length && <p>{t("추가할 비교 결과가 없습니다.")}</p>}
      </div>
    </dialog>
  </>;
}
