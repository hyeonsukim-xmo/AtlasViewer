import { t, useLanguage, localeTag } from "./language";
import { useEffect, useRef, useState } from "react";
import ImagePreview from "./image-preview";
import ResultView from "./result-view";
import {
  number,
  unwrap,
  type Analysis,
  type AnalysisResult,
  type ImagingFile,
  type Job,
  type ModelStatus,
} from "./imaging";
export type { Analysis } from "./imaging";

export default function ThighWorkspace({
  analysis,
  name,
  visible,
  onBack,
  initialResult,
}: {
  analysis: Analysis;
  name: string;
  visible: boolean;
  onBack: () => void;
  initialResult?: string;
}) {
  const language = useLanguage();
  const [model, setModel] = useState<ModelStatus>();
  const [files, setFiles] = useState<ImagingFile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [active, setActive] = useState("");
  const [hovered, setHovered] = useState("");
  const [step, setStep] = useState<"input" | "review" | "results">("input");
  const [results, setResults] = useState<AnalysisResult[]>([]);
  const [opened, setOpened] = useState<string[]>([]);
  const [compared, setCompared] = useState<string[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [device, setDevice] = useState("cuda:0");
  const receivedCompletion = useRef("");
  const running = job?.state === "running";
  const busy = changing || running;
  const current = files.find((file) => file.id === (hovered || active));
  const chosen = files.filter((file) => selected.includes(file.id));
  const canRun =
    chosen.length > 0 &&
    chosen.every((file) => file.ready && (!file.confirmation || confirmed.includes(file.id)));
  const filtered = files.filter((file) =>
    [
      file.name,
      file.metadata?.caseName,
      file.metadata?.studyDescription,
      file.metadata?.seriesDescription,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  useEffect(() => {
    if (!visible) return;
    let stale = false;
    void Promise.all([
      window.exmoDesktop.status(analysis).then(unwrap),
      window.exmoDesktop.list(analysis).then(unwrap),
      window.exmoDesktop.results(analysis).then(unwrap),
    ]).then(
      ([status, inputs, previous]) => {
        if (stale) return;
        setModel(status);
        setFiles(inputs);
        setResults(previous);
        setActive((old) => old || inputs[0]?.id || "");
        if (initialResult && previous.some((result) => result.id === initialResult)) {
          setOpened([initialResult]);
          setStep("results");
        }
      },
      (e: Error) => {
        if (!stale) setError(e.message);
      },
    );
    return () => {
      stale = true;
    };
  }, [analysis, visible, initialResult]);
  useEffect(() => {
    if (!visible && !running) return;
    let stale = false;
    const refresh = async () => {
      try {
        const next = unwrap(await window.exmoDesktop.job());
        if (stale) return;
        setJob((previous) =>
          previous &&
          next &&
          previous.id === next.id &&
          previous.state === next.state &&
          previous.current === next.current &&
          previous.stage === next.stage &&
          previous.progress === next.progress &&
          previous.completed.length === next.completed.length &&
          previous.failed.length === next.failed.length
            ? previous
            : next,
        );
        const key = next ? `${next.id}:${next.state}:${next.completed.length}` : "";
        if (
          next?.analysis === analysis &&
          next.state !== "running" &&
          receivedCompletion.current !== key
        ) {
          receivedCompletion.current = key;
          const completed = unwrap(await window.exmoDesktop.results(analysis));
          if (!stale) setResults(completed);
        }
      } catch (e) {
        if (!stale) setError((e as Error).message);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1200);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [analysis, visible, running]);
  function include(id: string, value: boolean) {
    setSelected((old) => (value ? [...new Set([...old, id])] : old.filter((key) => key !== id)));
  }
  function comparisonBlocked(result: AnalysisResult, ids = compared) {
    return (
      !ids.includes(result.id) &&
      (ids.length >= 3 ||
        (analysis === "xray" &&
          ids.length > 0 &&
          (results.find((row) => row.id === ids[0])?.route === "AP") !== (result.route === "AP")))
    );
  }
  function toggleComparison(result: AnalysisResult) {
    setCompared((old) =>
      comparisonBlocked(result, old)
        ? old
        : old.includes(result.id)
          ? old.filter((id) => id !== result.id)
          : [...old, result.id],
    );
  }
  async function add(folder = false) {
    setChanging(true);
    setError("");
    try {
      const added = unwrap(await window.exmoDesktop.chooseFiles(analysis, folder, language));
      setFiles((old) => [...old, ...added]);
      if (added.length) {
        setActive(added[0].id);
        setSelected((old) => [
          ...old,
          ...added.filter((file) => file.ready).map((file) => file.id),
        ]);
        setStep("input");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChanging(false);
    }
  }
  async function run() {
    setChanging(true);
    setError("");
    try {
      setJob(unwrap(await window.exmoDesktop.run(analysis, selected, confirmed, device)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChanging(false);
    }
  }
  async function clear() {
    setChanging(true);
    setError("");
    try {
      unwrap(await window.exmoDesktop.clear(analysis));
      setFiles([]);
      setSelected([]);
      setConfirmed([]);
      setActive("");
      setStep("input");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChanging(false);
    }
  }
  async function cancel() {
    setChanging(true);
    try {
      unwrap(await window.exmoDesktop.cancel(job!.analysis));
      setJob(unwrap(await window.exmoDesktop.job()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChanging(false);
    }
  }
  const displayResults = opened
    .map((id) => results.find((result) => result.id === id))
    .filter((result): result is AnalysisResult => !!result);
  if (displayResults.length)
    return (
      <ResultView
        key={opened.join()}
        results={displayResults}
        onClose={() => {
          setOpened([]);
          setStep("results");
        }}
        onUpdate={(result) =>
          setResults((old) => old.map((row) => (row.id === result.id ? result : row)))
        }
      />
    );
  return (
    <section className="thigh-workspace">
      <header className="workspace-heading">
        <div>
          <button className="clinical-button back-button" onClick={onBack}>
            {t("← 분석 선택으로")}
          </button>
          <h1>
            {name} <span>Thigh muscle estimation</span>
          </h1>
          <p>
            {analysis === "ct"
              ? t("3D CT · HU 기반 근육 체적 분석")
              : analysis === "mri"
                ? t("3D MRI Water · 근육 체적 분석")
                : t("AP / LAT-LT / LAT-RT · 근육 투영 면적 분석")}
          </p>
        </div>
        <span className="engine-state">
          {model?.estimationAvailable
            ? t("엔진 연결됨 · {{value0}}", { value0: model.device })
            : t("엔진 확인 중")}
        </span>
      </header>
      <div className="workflow-tabs" role="tablist" aria-label={t("분석 단계")}>
        {(["input", "review", "results"] as const).map((value, i) => (
          <button
            key={value}
            role="tab"
            aria-selected={step === value}
            onClick={() => setStep(value)}
          >
            {[t("영상·Series"), t("선택 영상 검토"), t("분석 결과")][i]}
            <span>{[files.length, selected.length, results.length][i]}</span>
          </button>
        ))}
        <span className="workflow-context">{name} / Lower extremity</span>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {t(error)}
        </p>
      )}
      {running && (
        <div className="job-status" role="status">
          <div>
            <strong>
              {job.analysis.toUpperCase()} · {t(job.stage)}
            </strong>
            <span>
              {job.current} · {job.completed.length + job.failed.length} / {job.total}
            </span>
          </div>
          <progress max={100} value={job.progress ?? undefined} />
          <button className="clinical-button" disabled={changing} onClick={() => void cancel()}>
            {t("실행 취소")}
          </button>
        </div>
      )}
      {!running && job?.analysis === analysis && job.failed.length > 0 && (
        <div className="inline-error" role="alert">
          {job.failed.map((file) => (
            <p key={file.id}>
              {file.name} · {t(file.error)}
            </p>
          ))}
        </div>
      )}
      {step === "input" && (
        <>
          <div className="workspace-actions">
            <input
              className="clinical-search"
              aria-label={t("Series 검색")}
              placeholder={t("Case / Study / Series 검색")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              className="text-button"
              disabled={busy || !files.length}
              onClick={() => void clear()}
            >
              {t("목록 비우기")}
            </button>
            <button
              className="clinical-button"
              disabled={busy || !model?.reviewAvailable}
              onClick={() => void add(true)}
            >
              {t("DICOM 폴더")}
            </button>
            <button
              className="clinical-button primary"
              disabled={busy || !model?.reviewAvailable}
              onClick={() => void add()}
            >
              {t("영상 추가")}
            </button>
          </div>
          <div className="input-layout">
            <div className="series-panel">
              <div className="series-scroll">
                <table className="clinical-table series-table">
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          aria-label={t("분석 가능한 영상 전체 선택")}
                          checked={
                            files.length > 0 &&
                            files
                              .filter((file) => file.ready)
                              .every((file) => selected.includes(file.id))
                          }
                          disabled={busy || !files.some((file) => file.ready)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? files.filter((file) => file.ready).map((file) => file.id)
                                : [],
                            )
                          }
                        />
                      </th>
                      <th>Case / Series description</th>
                      <th>{t("영상")}</th>
                      <th>{t("상태")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((file) => (
                      <tr
                        key={file.id}
                        aria-selected={file.id === active}
                        onMouseEnter={() => setHovered(file.id)}
                        onMouseLeave={() => setHovered("")}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (!busy) include(file.id, false);
                        }}
                      >
                        <td>
                          <input
                            type="checkbox"
                            aria-label={t("{{value0}} 분석 선택", { value0: file.name })}
                            checked={selected.includes(file.id)}
                            disabled={busy || !file.ready}
                            onChange={(e) => include(file.id, e.target.checked)}
                          />
                        </td>
                        <td>
                          <button
                            className="series-name"
                            onFocus={() => setHovered(file.id)}
                            onBlur={() => setHovered("")}
                            onClick={() => {
                              setActive(file.id);
                              setHovered("");
                            }}
                          >
                            <strong>{file.metadata?.caseName || file.name}</strong>
                            <span>{file.metadata?.seriesDescription || file.name}</span>
                            <small>
                              {file.metadata?.studyDescription || t("Study description 없음")}
                            </small>
                          </button>
                        </td>
                        <td>
                          {file.metadata?.format || "—"}
                          <small>{file.metadata ? `${file.metadata.slices} slice` : ""}</small>
                        </td>
                        <td>
                          <span className={file.ready ? "status-ready" : "status-review"}>
                            {file.classification?.predicted_label ||
                              (file.ready ? t("입력 확인됨") : t("검토 필요"))}
                          </span>
                          {file.confirmation && (
                            <small>
                              {file.confirmation === "hu"
                                ? t("HU 확인 필요")
                                : t("Water 확인 필요")}
                            </small>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!files.length && (
                  <div className="clinical-empty">
                    <strong>
                      {changing ? t("영상과 metadata 확인 중") : t("등록된 영상이 없습니다")}
                    </strong>
                    <p>
                      {analysis === "mri"
                        ? t("Water sequence의 DICOM series 또는 3D NRRD·NIfTI를 추가하세요.")
                        : analysis === "ct"
                          ? t("DICOM series 또는 mm geometry가 포함된 3D NRRD·NIfTI를 추가하세요.")
                          : t("X-ray DICOM·NRRD를 추가하면 촬영 방향을 확인합니다.")}
                    </p>
                  </div>
                )}
              </div>
            </div>
            <aside className="series-preview-panel">
              {current?.metadata ? (
                <>
                  <div className="panel-title">
                    <strong>{current.metadata.seriesDescription}</strong>
                    <span>{hovered ? "Hover preview" : t("선택 영상")}</span>
                  </div>
                  <ImagePreview key={current.id} analysis={analysis} id={current.id} />
                  <div className="metadata-strip">
                    <span>{current.metadata.size.join(" × ")}</span>
                    <span>{current.metadata.spacing.map((n) => number(n, 3)).join(" × ")} mm</span>
                  </div>
                  {current.error && <p className="inline-error">{t(current.error)}</p>}
                  {current.warnings?.map((warning) => (
                    <p className="muted-note" key={warning}>
                      {t(warning)}
                    </p>
                  ))}
                  {current.classification && (
                    <details className="qc-details">
                      <summary>{t("촬영 방향 분류 상세")}</summary>
                      <p>
                        {current.classification.predicted_label} ·{" "}
                        {number(current.classification.confidence * 100)}%
                      </p>
                      <p>{t("분류 점수이며 segmentation 정확도가 아닙니다.")}</p>
                    </details>
                  )}
                </>
              ) : (
                <div className="clinical-empty">
                  <span>Series preview</span>
                  <p>
                    {t(current?.error) ||
                      t("목록에 마우스를 올려 영상을 확인하고, 클릭해 고정합니다.")}
                  </p>
                </div>
              )}
            </aside>
          </div>
          <footer className="workspace-bottom">
            <span>
              {selected.length}
              {t("개 분석 선택 ")}
              {changing && t("· 영상 가져오는 중")}
            </span>
            <button
              className="clinical-button primary"
              disabled={!selected.length || busy}
              onClick={() => setStep("review")}
            >
              {t("선택 영상 검토")}
            </button>
          </footer>
        </>
      )}
      {step === "review" && (
        <>
          <div className="review-grid">
            {chosen.map((file) => (
              <article
                className="review-case"
                key={file.id}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!busy) include(file.id, false);
                }}
              >
                <div className="panel-title">
                  <div>
                    <strong>{file.metadata?.caseName || file.name}</strong>
                    <span>
                      {file.metadata?.studyDescription || file.metadata?.seriesDescription}
                    </span>
                  </div>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => include(file.id, false)}
                  >
                    {t("제외")}
                  </button>
                </div>
                <ImagePreview analysis={analysis} id={file.id} compact />
                <div className="review-case-details">
                  {file.metadata?.seriesDescription}
                  <small>
                    {file.metadata?.size.join(" × ")} ·{" "}
                    {file.metadata?.spacing.map((n) => number(n, 2)).join(" × ")} mm
                  </small>
                  {file.confirmation && (
                    <label className="input-confirmation">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={confirmed.includes(file.id)}
                        onChange={(e) =>
                          setConfirmed((old) =>
                            e.target.checked
                              ? [...old, file.id]
                              : old.filter((id) => id !== file.id),
                          )
                        }
                      />
                      {file.confirmation === "hu"
                        ? t("이 영상의 voxel 값이 HU 단위임을 확인했습니다.")
                        : t("이 영상이 Water sequence임을 확인했습니다.")}
                    </label>
                  )}
                </div>
              </article>
            ))}
            {!chosen.length && (
              <div className="clinical-empty">
                <strong>{t("검토할 영상이 없습니다")}</strong>
                <p>{t("영상·Series 탭에서 분석 대상을 선택하세요.")}</p>
              </div>
            )}
          </div>
          <footer className="workspace-bottom">
            <span>
              {chosen.length}
              {t("개 검사 · 우클릭으로 분석 선택 해제")}
            </span>
            {analysis !== "ct" && (
              <select
                aria-label={t("추론 장치")}
                value={device}
                disabled={busy}
                onChange={(e) => setDevice(e.target.value)}
              >
                <option value="cuda:0">GPU</option>
                <option value="cpu">CPU</option>
              </select>
            )}
            <button
              className="clinical-button primary"
              disabled={busy || !canRun || !model?.estimationAvailable}
              onClick={() => void run()}
            >
              {t("Segmentation 실행")}
            </button>
          </footer>
        </>
      )}
      {step === "results" && (
        <>
          <div className="workspace-actions">
            <span>
              {results.length}
              {t("개 완료된 검사")}
            </span>
            <button
              className="clinical-button"
              disabled={compared.length < 2}
              onClick={() => setOpened(compared)}
            >
              {t("선택 검사 비교 (")}
              {compared.length}/3)
            </button>
          </div>
          <div className="results-list">
            <table className="clinical-table">
              <thead>
                <tr>
                  <th>{t("비교")}</th>
                  <th>Case / Study</th>
                  <th>Series</th>
                  <th>{t("결과")}</th>
                  <th>{t("분석 일시")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {results.map((result) => (
                  <tr
                    key={result.id}
                    className="openable-row"
                    aria-selected={compared.includes(result.id)}
                    onClick={() => toggleComparison(result)}
                  >
                    <td>
                      <input
                        aria-label={t("{{value0}} 비교", { value0: result.name })}
                        type="checkbox"
                        checked={compared.includes(result.id)}
                        disabled={comparisonBlocked(result)}
                        title={t("동일한 class 구성의 결과끼리 최대 3개 비교")}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleComparison(result)}
                      />
                    </td>
                    <td>
                      <strong>{result.metadata.caseName}</strong>
                      <small>{result.metadata.studyDescription || "—"}</small>
                    </td>
                    <td>{result.metadata.seriesDescription}</td>
                    <td>
                      {result.rows.length} structures · {result.unit}
                      <small>
                        {result.variant.toUpperCase()}
                        {t(" · 임상 검토 전")}
                      </small>
                    </td>
                    <td>{new Date(result.createdAt).toLocaleString(localeTag())}</td>
                    <td>
                      <button
                        className="clinical-button"
                        aria-label={t("{{value0}} 결과 열기", { value0: result.metadata.caseName })}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpened([result.id]);
                        }}
                      >
                        {t("결과 열기")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!results.length && (
              <div className="clinical-empty">
                <strong>{t("완료된 분석이 없습니다")}</strong>
                <p>{t("분석 완료 후 실제 측정값·Overlay·3D 결과가 저장됩니다.")}</p>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
