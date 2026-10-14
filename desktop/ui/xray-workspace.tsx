import { useEffect, useRef, useState } from "react";
import { t, useLanguage, localeTag } from "./language";
import PatientGroupsView from "./patient-groups-view";
import { seriesLabel } from "./patient-groups";
import ImagePreview from "./image-preview";
import ResultView from "./result-view";
import {
  number,
  unwrap,
  type ImagingFile,
  type AnalysisResult,
  type Job,
  type ModelStatus,
  type ImportProgress,
} from "./imaging";
import {
  groupXrays,
  xrayResultFor,
  xrayHistory,
  comparisonView,
  pendingXrayInputs,
  studyIdentity,
  studyKey,
  xrayView,
  XRAY_VIEWS,
  viewLabel,
  type StudyItem,
  type XrayView,
  type XrayStudy,
} from "./xray-studies";

type Props = {
  files: ImagingFile[];
  results: AnalysisResult[];
  job: Job | null;
  model?: ModelStatus;
  busy: boolean;
  importing: boolean;
  importProgress: ImportProgress | null;
  error: string;
  visible: boolean;
  initialResult?: string;
  device: string;
  setDevice: (value: string) => void;
  onAdd: (folder?: boolean) => void;
  onRun: (ids: string[]) => void;
  onCancel: () => void;
  onClear: () => void;
  onBack: () => void;
  onReload: () => Promise<void>;
  onUpdate: (result: AnalysisResult) => void;
};
function studyTitle(group: XrayStudy<StudyItem>) {
  const m = studyIdentity(group.metadata);
  return [m?.patientId || group.metadata?.caseName || group.items[0].name, m?.studyDate]
    .filter(Boolean)
    .join(" · ");
}
function studySubtitle(group: XrayStudy<StudyItem>) {
  return [
    studyIdentity(group.metadata)?.patientIssuer || group.metadata?.institutionName,
    group.metadata?.studyDescription,
  ]
    .filter(Boolean)
    .join(" · ");
}
function choose<T extends StudyItem>(items: T[], value?: string): T | undefined {
  return items.find((item) => item.id === value) || items[0];
}
function versionLabel(item: StudyItem) {
  return [
    item.metadata?.seriesDescription || item.name,
    item.metadata?.acquisitionTime,
    item.metadata?.studyUid?.slice(-8),
    item.id.slice(-6),
  ]
    .filter(Boolean)
    .join(" · ");
}
export default function XrayWorkspace(p: Props) {
  useLanguage();
  const [step, setStep] = useState<"input" | "review" | "results">("input");
  const [selected, setSelected] = useState<string[]>([]);
  const [runSelected, setRunSelected] = useState<string[]>([]);
  const [rerunIds, setRerunIds] = useState<string[]>([]);
  const [assignmentIds, setAssignmentIds] = useState<string[] | null>(null);
  useEffect(() => {
    const exists = (id: string) => p.files.some(file => file.id === id);
    setSelected(old => old.filter(exists));
    setRunSelected(old => old.filter(exists));
    setRerunIds(old => old.filter(exists));
  }, [p.files]);
  const [query, setQuery] = useState("");
  const [previewId, setPreviewId] = useState("");
  const preview =
    p.files.find((file) => file.id === previewId) || p.files.find((file) => file.metadata);
  const [compared, setCompared] = useState<string[]>([]);
  const [opened, setOpened] = useState<string[]>([]);
  const [angle, setAngle] = useState<XrayView>("AP");
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [localError, setLocalError] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [patientId, setPatientId] = useState("");
  const [patientIssuer, setPatientIssuer] = useState("");
  const [studyDate, setStudyDate] = useState("");
  const busy = p.busy || saving;
  const normalizedFiles = p.files.map(file => file.metadata?.studyAssignment
    ? {...file, metadata: {...file.metadata, ...file.metadata.studyAssignment}} : file);
  const history = xrayHistory(normalizedFiles, p.results);
  const studiesFor = (files: ImagingFile[]) => groupXrays(files).map((group, index) => ({
    ...group, label: (group.metadata?.studyDescription || t("촬영 정보 미지정")).slice(0, 80) + " · " + (index + 1),
    summary: <div className="xray-study-summary">{statusStrip(group)}</div>,
  }));
  const resultGroups = groupXrays(p.results);
  const latestResults = [...p.results].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const resultFor = (file: ImagingFile) =>
    xrayResultFor(file, latestResults);
  const runningJob = p.job?.analysis === "xray" && p.job.state === "running" ? p.job : null;
  const stateOf = (file: ImagingFile) => {
    const active = runningJob?.active?.find((task) => task.id === file.id);
    if (active) return active.lane === "waiting" ? t("대기") : t("분석 중");
    if (resultFor(file)) return t("완료");
    if (p.job?.analysis === "xray" && p.job.failed.some((f) => f.id === file.id))
      return t("분석 실패");
    if (!xrayView(file)) return t("방향 확인 필요");
    if (!file.ready) return t("입력 검토 필요");
    return (step === "review" ? runSelected : selected).includes(file.id) ? t("선택됨") : t("분석 대기");
  };
  const toggle = (ids: string[], value: boolean) => {
    setSelected(old => value ? [...new Set([...old, ...ids])] : old.filter(id => !ids.includes(id)));
    if (!value) {
      setRunSelected(old => old.filter(id => !ids.includes(id)));
      setRerunIds(old => old.filter(id => !ids.includes(id)));
    }
  };
  const toggleRun = (ids: string[], value: boolean) => setRunSelected(old =>
    value ? [...new Set([...old, ...ids])] : old.filter(id => !ids.includes(id)));
  const canRun = (file: ImagingFile) => !!(file.ready && xrayView(file) && (!resultFor(file) || rerunIds.includes(file.id)));
  const reviewFiles = normalizedFiles.filter(file => selected.includes(file.id));
  const candidates = reviewFiles.filter(file => canRun(file) && runSelected.includes(file.id));
  const requestAssignment = (files: ImagingFile[]) => {
    setAssignmentIds(files.map(file => file.id));
    setEditing(true);
  };
  const openResult = (result: AnalysisResult) => {
    setVersions(old => ({...old, [studyKey(result) + xrayView(result)]: result.id}));
    setOpened([studyKey(result)]);
  };
  const startRun = (ids: string[]) => {
    p.onRun(ids);
    setRunSelected(old => old.filter(id => !ids.includes(id)));
    setRerunIds(old => old.filter(id => !ids.includes(id)));
  };
  const handledInitial = useRef("");
  useEffect(() => {
    if (!p.visible) {
      handledInitial.current = "";
      return;
    }
    if (!p.initialResult || handledInitial.current === p.initialResult) return;
    const result = p.results.find((result) => result.id === p.initialResult);
    if (result) {
      handledInitial.current = p.initialResult;
      setOpened([studyKey(result)]);
      setStep("results");
    }
  }, [p.initialResult, p.results, p.visible]);
  function statusStrip(group: XrayStudy<ImagingFile>) {
    return (
      <div className="xray-view-status">
        {XRAY_VIEWS.map((view) => {
          const items = group.items.filter((item) => xrayView(item) === view);
          return (
            <span key={view}>
              <b>{viewLabel(view)}</b> ·{" "}
              {items.length
                ? [...new Set(items.map(stateOf))].join(" / ") +
                  (items.length > 1 ? " (" + items.length + ")" : "")
                : t("미등록")}
            </span>
          );
        })}
        {group.items.some((item) => !xrayView(item)) && <span>{t("방향 확인 필요")}</span>}
      </div>
    );
  }
  function selector<T extends StudyItem>(key: string, items: T[]) {
    return (
      items.length > 1 && (
        <select
          aria-label={t("같은 방향의 영상 전환")}
          value={choose(items, versions[key])!.id}
          onChange={(event) => setVersions((old) => ({ ...old, [key]: event.target.value }))}
        >
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {versionLabel(item)}
            </option>
          ))}
        </select>
      )
    );
  }
  async function assignStudy() {
    const ids = assignmentIds ?? (
      step === "results"
        ? resultGroups
            .filter((g) => compared.includes(g.key))
            .flatMap((g) => g.items.map((r) => r.inputId))
        : selected);
    setSaving(true);
    setLocalError("");
    try {
      unwrap(
        await window.exmoDesktop.assignXrayStudy([...new Set(ids)], {
          patientId,
          patientIssuer,
          studyDate,
        }),
      );
      await p.onReload();
      setEditing(false);
      setCompared([]);
      setOpened([]);
    } catch (error) {
      setLocalError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const openGroups = resultGroups
    .filter((group) => opened.includes(group.key))
    .sort((a, b) => opened.indexOf(a.key) - opened.indexOf(b.key));
  if (openGroups.length) {
    const comparing = opened.length > 1;
    const slots = openGroups.flatMap((group) =>
      (comparing ? [angle] : XRAY_VIEWS).map((view) => {
        const items = latestResults.filter(
          (result) => studyKey(result) === group.key && xrayView(result) === view,
        );
        const key = group.key + view;
        return { key, group, view, items, result: choose(items, versions[key]) };
      }),
    );
    const displayed = slots.flatMap((slot) => (slot.result ? [slot.result] : []));
    return (
      <div className="xray-result-workspace">
        <div className="xray-result-controls">
          {comparing && (
            <div className="control-segment">
              {XRAY_VIEWS.map((view) => (
                <button key={view} aria-pressed={angle === view} onClick={() => setAngle(view)}>
                  {viewLabel(view)}
                </button>
              ))}
            </div>
          )}
          {slots.map((slot) => (
            <div key={slot.key} className="xray-result-slot">
              <strong>
                {comparing ? studyTitle(slot.group) + " · " : ""}
                {viewLabel(slot.view)}
              </strong>
              <span>
                {slot.result
                  ? t("완료")
                  : comparing
                    ? t("비교 영상 없음")
                    : (() => {
                        const file = p.files.find(
                          (file) =>
                            studyKey(file) === slot.group.key && xrayView(file) === slot.view,
                        );
                        return file ? stateOf(file) : t("미등록");
                      })()}
              </span>
              {selector(slot.key, slot.items)}
            </div>
          ))}
        </div>
        {displayed.length ? (
          <ResultView
            key={displayed.map((r) => r.id).join(",")}
            results={displayed}
            heading={comparing ? t("촬영 비교") : studyTitle(openGroups[0])}
            description={
              comparing
                ? t("같은 방향의 촬영끼리 비교합니다.")
                : t("LT · AP · RT — 등록된 영상만 표시합니다.")
            }
            workspaceError={p.error}
            onClose={() => setOpened([])}
            onUpdate={p.onUpdate}
          />
        ) : (
          <section className="clinical-empty">
            <button className="clinical-button" onClick={() => setOpened([])}>
              {t("← 결과 목록으로")}
            </button>
            <p>{t("비교 영상 없음")}</p>
          </section>
        )}
      </div>
    );
  }
  const visibleFiles = normalizedFiles.filter(file => [
    file.metadata?.patientId, file.metadata?.patientIssuer, file.metadata?.institutionName,
    file.metadata?.studyDate, file.metadata?.studyDate?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
    file.metadata?.studyDescription, file.metadata?.seriesDescription, file.name,
  ].join(" ").toLowerCase().includes(query.toLowerCase()));
  return (
    <section className="thigh-workspace xray-workspace">
      <header className="workspace-heading">
        <div>
          <button className="clinical-button back-button" onClick={p.onBack}>
            {t("← 분석 선택으로")}
          </button>
          <h1>
            X-ray <span>Thigh muscle estimation</span>
          </h1>
          <p>{t("환자·촬영일별 검토 · LT / AP / RT")}</p>
        </div>
        <span>{p.model?.estimationAvailable ? t("엔진 연결됨") : t("엔진 확인 중")}</span>
      </header>
      <div className="workflow-tabs" role="tablist" aria-label={t("분석 단계")}>
        {(["input", "review", "results"] as const).map((value, index) => (
          <button
            key={value}
            role="tab"
            aria-selected={step === value}
            onClick={() => {
              setStep(value);
              setEditing(false);
            }}
          >
            {[t("영상·Series"), t("선택 영상 검토"), t("분석 결과")][index]}
            <span>{[p.files.length, selected.length, resultGroups.length][index]}</span>
          </button>
        ))}
      </div>
      {(p.error || localError) && (
        <p role="alert" className="inline-error">
          {t(localError || p.error)}
        </p>
      )}
      {p.importing && (
        <div className="job-status" role="status">
          {t(p.importProgress?.phase === "extract" ? "ZIP 압축 해제 중" : "영상과 metadata 확인 중")} {p.importProgress?.completed} / {p.importProgress?.total}
          {p.importProgress?.current && <span> · {p.importProgress.current}</span>}
        </div>
      )}
      {runningJob && (
        <div className="job-status" role="status">
          <div>
            <strong>
              {t("전체 처리 {{value0}} / {{value1}} · 성공 {{value2}} · 실패 {{value3}}", {
                value0: runningJob.completed.length + runningJob.failed.length,
                value1: runningJob.total,
                value2: runningJob.completed.length,
                value3: runningJob.failed.length,
              })}
            </strong>
            {runningJob.active?.map((task) => (
              <span key={task.id}>
                {task.name} · {t(task.stage)} {task.progress == null ? "" : task.progress + "%"}
              </span>
            ))}
          </div>
          <button className="clinical-button" onClick={p.onCancel}>
            {t("실행 취소")}
          </button>
        </div>
      )}
      {p.job?.analysis === "xray" && p.job.failed.length > 0 && (
        <div className="inline-error">
          {p.job.failed.map((file) => (
            <p key={file.id}>
              {file.name} · {t(file.error)}
            </p>
          ))}
          <button
            className="clinical-button"
            disabled={
              busy ||
              !pendingXrayInputs(p.files, p.results, p.job.failed.map(file => file.id)).length
            }
            onClick={() =>
              p.onRun(
                pendingXrayInputs(
                  p.files,
                  p.results,
                  p.job!.failed.map((f) => f.id),
                ).map((f) => f.id),
              )
            }
          >
            {t("실패한 영상만 재시도")}
          </button>
        </div>
      )}
      <div className="workspace-actions">
        {step === "input" && (
          <>
            <input
              className="clinical-search"
              aria-label={t("Series 검색")}
              placeholder={t("환자번호 / 촬영일 / Series 검색")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button className="text-button" disabled={busy || !p.files.length} onClick={p.onClear}>
              {t("목록 비우기")}
            </button>
            <button
              className="clinical-button"
              disabled={busy || !p.model?.reviewAvailable}
              onClick={() => p.onAdd(true)}
            >
              {t("DICOM 폴더")}
            </button>
            <button
              className="clinical-button primary"
              disabled={busy || !p.model?.reviewAvailable}
              onClick={() => p.onAdd()}
            >
              {t("영상 추가")}
            </button>
          </>
        )}
        {step !== "review" && (
          <button
            className="clinical-button"
            disabled={busy || (step === "results" ? !compared.length : !selected.length)}
            onClick={() => {setAssignmentIds(null); setEditing(!editing);}}
          >
            {t("선택 영상의 촬영 정보 지정")}
          </button>
        )}
        {step === "results" && (
          <button
            className="clinical-button"
            disabled={compared.length < 2}
            onClick={() => {
              setAngle(
                comparisonView(resultGroups.filter((group) => compared.includes(group.key))),
              );
              setOpened(compared);
            }}
          >
            {t("선택 검사 비교 (")}
            {compared.length}/3)
          </button>
        )}
      </div>
      {editing && (
        <form
          className="xray-study-form"
          onSubmit={(event) => {
            event.preventDefault();
            void assignStudy();
          }}
        >
          <p>{t("선택 영상들을 입력한 환자·촬영일로 묶습니다. 기존 영상과 결과는 보존됩니다.")}</p>
          <label>
            {t("기관 / 환자번호 발급기관")}
            <input
              required
              maxLength={120}
              value={patientIssuer}
              onChange={(e) => setPatientIssuer(e.target.value)}
            />
          </label>
          <label>
            {t("환자번호")}
            <input
              required
              maxLength={120}
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
            />
          </label>
          <label>
            {t("촬영일")}
            <input
              required
              type="date"
              value={studyDate}
              onChange={(e) => setStudyDate(e.target.value)}
            />
          </label>
          <button className="clinical-button" disabled={busy} type="submit">
            {t("적용")}
          </button>
          <button
            className="text-button"
            type="button"
            disabled={saving}
            onClick={() => setEditing(false)}
          >
            {t("취소")}
          </button>
        </form>
      )}
      {step === "input" && (
        <div className="xray-input-layout">
          <div className="results-list xray-study-list">
            <PatientGroupsView items={visibleFiles} selected={selected} busy={busy} onSelect={toggle}
              mode="input" onAssign={requestAssignment} analyzedInputs={history} studiesFor={studiesFor}
              canSelect={file => !!file.metadata}>
              {(file, pick) => <tr key={file.id} className="xray-file-row openable-row" data-input-id={file.id}
                aria-selected={selected.includes(file.id)} tabIndex={busy || !file.metadata ? -1 : 0}
                onMouseEnter={() => setPreviewId(file.id)} onFocus={() => setPreviewId(file.id)}
                onClick={event => {if (!busy && file.metadata) pick(!selected.includes(file.id), event.shiftKey);}}
                onKeyDown={event => {if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) {
                  event.preventDefault(); if (!busy && file.metadata) pick(!selected.includes(file.id), event.shiftKey);
                }}}>
                <td><input type="checkbox" disabled={busy || !file.metadata} checked={selected.includes(file.id)}
                  aria-label={t("{{value0}} 분석 선택", {value0: seriesLabel(file)})} onClick={event => event.stopPropagation()}
                  onChange={event => pick(event.target.checked, !!(event.nativeEvent as MouseEvent).shiftKey)} /></td>
                <td title={file.name}><strong>{seriesLabel(file)}</strong>
                  {file.error && <small className="inline-error">{t(file.error)}</small>}</td>
                <td>{xrayView(file) ? viewLabel(xrayView(file)!) : "—"}</td>
                <td>{stateOf(file)}</td>
              </tr>}
            </PatientGroupsView>
            {!visibleFiles.length && <div className="clinical-empty">{t("등록된 영상이 없습니다")}</div>}
          </div>
          <aside className="series-preview-panel">
            {preview?.metadata ? (
              <>
                <div className="panel-title">
                  <strong title={preview.name}>{seriesLabel(preview)}</strong>
                  <span>
                    {xrayView(preview) ? viewLabel(xrayView(preview)!) : t("방향 확인 필요")}
                  </span>
                </div>
                <ImagePreview key={preview.id} analysis="xray" id={preview.id} />
                {preview.error && <p className="inline-error">{t(preview.error)}</p>}
                {preview.warnings.map((warning) => (
                  <p className="muted-note" key={warning}>
                    {t(warning)}
                  </p>
                ))}
                {preview.classification && (
                  <details className="qc-details">
                    <summary>{t("촬영 방향 분류 상세")}</summary>
                    <p>
                      {preview.classification.predicted_label} ·{" "}
                      {number(preview.classification.confidence * 100)}%
                    </p>
                    <p>{t("분류 점수이며 segmentation 정확도가 아닙니다.")}</p>
                  </details>
                )}
              </>
            ) : (
              <div className="clinical-empty">{t("등록된 영상이 없습니다")}</div>
            )}
          </aside>
        </div>
      )}
      {step === "review" && <>
        <div className="review-pagination">
          <span>{t("검토 {{value0}}개 · 분석 선택 {{value1}}개 · 실행 가능 {{value2}}개", {
            value0: reviewFiles.length, value1: reviewFiles.filter(file => runSelected.includes(file.id)).length, value2: candidates.length,
          })}</span>
          <button className="clinical-button" disabled={busy || !reviewFiles.some(canRun)}
            onClick={() => toggleRun(reviewFiles.filter(canRun).map(file => file.id), true)}>{t("분석 가능한 영상 전체 선택")}</button>
          <button className="text-button" disabled={busy || !runSelected.length}
            onClick={() => setRunSelected([])}>{t("선택 해제")}</button>
          {reviewFiles.some(file => !xrayView(file)) && <span>{t("방향 확인 필요")} · {reviewFiles.filter(file => !xrayView(file)).length}</span>}
        </div>
        <PatientGroupsView key="xray-review" items={reviewFiles} selected={runSelected} busy={busy}
          onSelect={toggleRun} mode="review" onAssign={requestAssignment} canSelect={canRun} studiesFor={studiesFor}
          renderStudy={(study, renderFile) => <section className="xray-study-review" key={study.key}>
            {statusStrip({...study, metadata: study.items[0]?.metadata})}
            <div className="xray-projections">
              {XRAY_VIEWS.map(view => {
                const files = study.items.filter(file => xrayView(file) === view);
                return <div className="xray-direction-column" key={view} data-view={view}>
                  <h3>{viewLabel(view)}</h3>
                  {files.length ? files.map(renderFile) : <div className="xray-missing-view">{t("검토 영상 없음")}</div>}
                </div>;
              })}
              {study.items.some(file => !xrayView(file)) && <div className="xray-unconfirmed">
                <h3>{t("방향 확인 필요")}</h3>{study.items.filter(file => !xrayView(file)).map(renderFile)}
              </div>}
            </div>
          </section>}>
          {(file, pick) => {
            const result = resultFor(file), checked = runSelected.includes(file.id);
            return <article className="review-case" key={file.id} data-input-id={file.id} data-selected={checked}
              onContextMenu={event => {event.preventDefault(); if (!busy) pick(false);}}>
              <div className="panel-title">
                <label className="xray-run-pick"><input type="checkbox" disabled={busy || !canRun(file)} checked={checked}
                  aria-label={t("{{value0}} 분석 선택", {value0: seriesLabel(file)})}
                  onChange={event => pick(event.target.checked, !!(event.nativeEvent as MouseEvent).shiftKey)} />
                  <strong title={file.name}>{seriesLabel(file)}</strong></label>
                <span>{stateOf(file)}</span>
              </div>
              {file.metadata ? <LazyXrayPreview id={file.id} /> : <p>{t("입력 검토 필요")}</p>}
              <div className="review-case-details">
                {file.error && <p className="inline-error">{t(file.error)}</p>}
                {file.warnings.map(warning => <p className="muted-note" key={warning}>{t(warning)}</p>)}
                {result && <div className="xray-completed-actions">
                  <button className="clinical-button" onClick={() => openResult(result)}>{t("결과 열기")}</button>
                  <button className="text-button" disabled={busy || !file.ready || !xrayView(file)} onClick={() => {
                    const armed = rerunIds.includes(file.id);
                    setRerunIds(old => armed ? old.filter(id => id !== file.id) : [...old, file.id]);
                    toggleRun([file.id], !armed);
                  }}>{rerunIds.includes(file.id) ? t("재분석 선택 취소") : t("재분석 선택")}</button>
                </div>}
              </div>
            </article>;
          }}
        </PatientGroupsView>
        {!reviewFiles.length && <div className="clinical-empty">{t("검토할 영상이 없습니다")}</div>}
      </>}
      {step === "results" && (
        <div className="results-list">
          <table className="clinical-table">
            <thead>
              <tr>
                <th>{t("비교")}</th>
                <th>{t("환자 / 촬영일")}</th>
                <th>LT / AP / RT</th>
                <th>{t("분석 일시")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {resultGroups.map((group) => {
                const checked = compared.includes(group.key);
                const disabled = !checked && compared.length >= 3;
                const toggleGroup = () => {
                  if (!disabled)
                    setCompared((old) =>
                      checked ? old.filter((key) => key !== group.key) : [...old, group.key],
                    );
                };
                return (
                  <tr
                    key={group.key}
                    className="openable-row"
                    aria-selected={checked}
                    onClick={toggleGroup}
                    tabIndex={disabled ? -1 : 0}
                    onKeyDown={(e) => {
                      if (e.target === e.currentTarget && ["Enter", " "].includes(e.key)) {
                        e.preventDefault();
                        toggleGroup();
                      }
                    }}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        aria-label={t("{{value0}} 비교", { value0: studyTitle(group) })}
                        onClick={(e) => e.stopPropagation()}
                        onChange={toggleGroup}
                      />
                    </td>
                    <td>
                      <strong>{studyTitle(group)}</strong>
                      <small>{studySubtitle(group)}</small>
                    </td>
                    <td>
                      <div className="xray-view-status">
                        {XRAY_VIEWS.map((view) => {
                          const count = new Set(
                            group.items
                              .filter((item) => xrayView(item) === view)
                              .map((item) => item.inputId),
                          ).size;
                          const pending = p.files.filter(
                            (file) =>
                              studyKey(file) === group.key &&
                              xrayView(file) === view &&
                              !resultFor(file),
                          );
                          return (
                            <span key={view}>
                              <b>{viewLabel(view)}</b> ·{" "}
                              {count
                                ? t("완료") + " (" + count + ")"
                                : pending.length
                                  ? stateOf(pending[0])
                                  : t("미등록")}
                              {count > 0 &&
                                pending.length > 0 &&
                                " / " + [...new Set(pending.map(stateOf))].join(" / ")}
                            </span>
                          );
                        })}
                      </div>
                    </td>
                    <td>
                      {new Date(
                        group.items.reduce(
                          (latest, item) => (item.createdAt > latest ? item.createdAt : latest),
                          "",
                        ),
                      ).toLocaleString(localeTag())}
                    </td>
                    <td>
                      <button
                        className="clinical-button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpened([group.key]);
                        }}
                      >
                        {t("결과 열기")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!resultGroups.length && (
            <div className="clinical-empty">{t("완료된 분석이 없습니다")}</div>
          )}
        </div>
      )}
      {step !== "results" && (
        <footer className="workspace-bottom">
          <span>
            {step === "input" ? t("{{value0}}개 영상 선택", {value0: selected.length}) :
              t("검토 {{value0}}개 · 실행 가능 {{value1}}개", {value0: reviewFiles.length, value1: candidates.length})}
          </span>
          {step === "input" ? (
            <button
              className="clinical-button primary"
              disabled={!selected.length || busy}
              onClick={() => {
                setStep("review");
              }}
            >
              {t("선택 영상 검토")}
            </button>
          ) : (
            <>
              <select
                aria-label={t("추론 장치")}
                disabled={busy}
                value={p.device}
                onChange={(e) => p.setDevice(e.target.value)}
              >
                <option value="cuda:0">GPU</option>
                <option value="cpu">CPU</option>
              </select>
              <button
                className="clinical-button primary"
                disabled={busy || !candidates.length || !p.model?.estimationAvailable}
                onClick={() => startRun(candidates.map((file) => file.id))}
              >
                {t("선택 영상 분석 ({{value0}}개)", { value0: candidates.length })}
              </button>
            </>
          )}
        </footer>
      )}
    </section>
  );
}
function LazyXrayPreview({id}: {id: string}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!window.IntersectionObserver) {setVisible(true); return;}
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {setVisible(true); observer.disconnect();}
    }, {root: node.closest(".grouped-review"), rootMargin: "300px"});
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <div className="xray-lazy-preview" ref={ref}>
    {visible ? <ImagePreview analysis="xray" id={id} compact /> : <div className="clinical-empty">{t("영상 미리보기")}</div>}
  </div>;
}
