import RemoteOverlayImage from './remote-overlay';
import Publication from './publication';
import { failureText, sceneDiagnostic, type Diagnostic, type Failure } from "./diagnostics";
import { t, useLanguage } from "./language";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import AnatomyScene from "../../app/scene";
import { GROUPS, INITIAL_STATE, inGroup, type SceneState } from "../../app/anatomy";
import ImagePreview from "./image-preview";
import ResultComparison, { type ComparisonActions } from "./result-comparison";
import { xrayApplicable, xrayView, viewLabel } from "./xray-studies";
import {
  number,
  unwrap,
  type AnalysisResult,
  type AnatomicalSide,
  type MetricRow,
} from "./imaging";

const sideName = { left: "Left", right: "Right", unassigned: "미분류" };

function SideValues({ row, primarySide }: { row: MetricRow; primarySide: AnatomicalSide }) {
  useLanguage();
  if (!row.sides) return null;
  const order: AnatomicalSide[] = primarySide === "right" ? ["right", "left"] : ["left", "right"];
  return (
    <div className="bilateral-values">
      {order.map((side) => (
        <div key={side} data-primary={primarySide === side}>
          <span>
            {t(sideName[side])}
            {primarySide === side && t(" · 현재")}
          </span>
          <strong>{number(row.sides![side].count ? row.sides![side].value : null)}</strong>
          {row.sides![side].fat != null && <small>Fat-range {number(row.sides![side].fat)}%</small>}
          {row.sides![side].entropy != null && (
            <small>Entropy {number(row.sides![side].entropy, 3)}</small>
          )}
        </div>
      ))}
      <small
        className="bilateral-difference"
        title={t("|L − R| / mean(L, R) × 100. 양쪽이 검출되고 미분류가 없을 때만 계산합니다.")}
      >
        {row.sides.differencePercent == null ? (
          t("Δ 판정 보류")
        ) : (
          <>
            {t("차이 ")}
            {number(row.sides.differenceCm3)}
            {t(" cm³ · 양측 평균 대비")} {number(row.sides.differencePercent)}%
          </>
        )}
      </small>
      {row.sides.unassigned.count > 0 && (
        <small className="side-unassigned">
          {t("미분류 ")}
          {number(row.sides.unassigned.value)} cm³
        </small>
      )}
    </div>
  );
}

export default function ResultView({
  results,
  onClose,
  onUpdate,
  workspaceError = "",
  heading,
  description,
  comparison,
  remote,
}: {
  results: AnalysisResult[];
  onClose: () => void;
  onUpdate: (result: AnalysisResult) => void;
  workspaceError?: Failure;
  heading?: string;
  description?: string;
  comparison?: ComparisonActions;
  remote?: {meshUrls:Record<string,string>;overlays?:Record<string,import('./imaging').RemoteOverlay>};
}) {
  const language = useLanguage();
  const [active, setActive] = useState<string | null>(results.length === 1 ? results[0].id : null);
  const [requestedMode, setMode] = useState<"overlay" | "3d">(remote && results.some(r=>r.meshBytes)?"3d":"overlay");
  const [state, setState] = useState<SceneState<string>>({ ...INITIAL_STATE, group: "All" });
  const [linkedHover, setLinkedHover] = useState<{viewport: string; id: string} | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [error, setError] = useState<Failure>("");
  const [caseErrors, setCaseErrors] = useState<Record<string, Failure>>({});
  const [sceneErrors, setSceneErrors] = useState<Record<string, Diagnostic | undefined>>({});
  const [sceneRetries, setSceneRetries] = useState<Record<string, number>>({});
  const [changing, setChanging] = useState(false);
  const [table, setTable] = useState<"metrics" | "qc">("metrics");
  const [ttaThreshold, setTtaThreshold] = useState(1.16);
  const needsPreparation = (result: AnalysisResult) =>
    !remote && result.analysis !== "xray" && result.laterality?.method !== "femur_components_lps_v1";
  const [preparing, setPreparing] = useState(() => results.some(needsPreparation));
  const pendingMeshes = results.some(result => result.meshState === "pending");
  const preparationKey = results.map(result => result.id).join(",");
  useEffect(() => {
    let disposed = false;
    if (results.length > 1) setActive(null);
    setPreparing(results.some(needsPreparation));
    void (async () => {
      try {
        for (const result of results.filter(needsPreparation)) {
          try {
          const updated = unwrap(await window.exmoDesktop.variant(result.id, result.variant));
          if (!disposed) onUpdate(updated);
          } catch (e) {
            if (!disposed) setCaseErrors(previous => ({...previous,[result.id]:e as Error}));
          }
        }
      } finally {
        if (!disposed) setPreparing(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [preparationKey]);
  // Overlay visibility starts with all labels; 3D keeps its separate focus/rotation selection.
  const [overlaySelection, setOverlaySelection] = useState<string[] | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const [panelWidth, setPanelWidth] = useState<number>();
  const [panelSize, setPanelSize] = useState({ width: 330, max: 1000 });
  useEffect(() => {
    const host = body.current!;
    const panel = host.querySelector<HTMLElement>(".metrics-panel")!;
    const observer = new ResizeObserver(() => {
      if (host.clientWidth)
        setPanelSize({
          width: Math.round(panel.getBoundingClientRect().width),
          max: Math.max(280, host.clientWidth - 336),
        });
    });
    observer.observe(host);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  function resizePanel(width: number) {
    setPanelWidth(Math.max(280, Math.min(body.current!.clientWidth - 336, width)));
  }
  const primary = results[0];
  const catalog = useMemo(
    () => [...new Map(results.flatMap((r) => r.rows).map((row) => [row.id, row])).values()],
    [results],
  );
  // One selection/layout for every case, including a case where the selected label is absent.
  const sceneState = useMemo(
    () => ({
      ...state,
      isolate: !!state.explode && state.selected.length > 0,
    }),
    [state, results.length],
  );
  const models = useMemo(
    () =>
      new Map(
        results.map((result) => [
          result.id,
          {
            url: remote?.meshUrls[result.id] || `/result/${result.id}.glb?v=${result.variant}&lr=${result.laterality?.method || "legacy"}`,
            bytes: result.meshBytes || 0,
            structures: result.rows.filter((row) => row.present),
            parts: result.parts,
          },
        ]),
      ),
    [results,remote],
  );
  const can3d =
    !preparing && results.some((result) => result.meshBytes && !needsPreparation(result));
  const mode = requestedMode === "3d" && !can3d ? "overlay" : requestedMode;
  const paired = mode === "3d" && results.length === 1 && !!state.explode;
  const assembledState = useMemo(() => ({...state, explode: 0, isolate: false}), [state]);
  const viewports = paired
    ? [{result: primary, key: primary.id, assembled: true},
       {result: primary, key: `${primary.id}:exploded`, assembled: false}]
    : results.map(result => ({result, key: result.id, assembled: !state.explode}));
  useEffect(() => setLinkedHover(null), [paired, mode, preparationKey, state.group, state.reset, state.selected]);
  const selectedIds =
    mode === "overlay" ? (overlaySelection ?? catalog.map((row) => row.id)) : state.selected;
  const allSelected = selectedIds.length === catalog.length;
  const selected = primary.rows.find((r) => selectedIds.includes(r.id));
  function toggleAll() {
    if (mode === "overlay") setOverlaySelection(allSelected ? [] : null);
    else
      setState((s) => ({
        ...s,
        selected: allSelected ? [] : catalog.map((row) => row.id),
        rotate: false,
      }));
  }
  async function changeVariant(result: AnalysisResult, variant: string) {
    if(remote)return;
    setChanging(true);
    setError("");
    setCaseErrors(previous => ({...previous,[result.id]:''}));
    try {
      onUpdate(unwrap(await window.exmoDesktop.variant(result.id, variant)));
    } catch (e) {
      setCaseErrors(previous => ({...previous,[result.id]:e as Error}));
    } finally {
      setChanging(false);
    }
  }
  function select(id: string | null, caseId = primary.id, exploded = !!state.explode) {
    if (mode === "overlay") {
      setOverlaySelection((previous) => {
        if (id == null) return null;
        const ids = previous ?? catalog.map((row) => row.id);
        return ids.includes(id) ? ids.filter((key) => key !== id) : [...ids, id];
      });
      return;
    }
    if (!id) {
      setActive(null);
      setState((s) => ({
        ...s,
        selected: [],
        isolate: false,
        rotate: false,
      }));
      return;
    }
    setActive(caseId);
    setState((s) => {
      return {
        ...s,
        rotate: false,
        group: inGroup(
          catalog.find((row) => row.id === id)!,
          s.group,
        )
          ? s.group
          : "All",
        selected: exploded
          ? s.selected.length === 1 && s.selected[0] === id
            ? []
            : [id]
          : catalog.every((row) => s.selected.includes(row.id))
            ? [id]
            : s.selected.includes(id)
              ? s.selected.filter((key) => key !== id)
              : [...s.selected, id],
      };
    });
  }
  return (
    <section className="result-workspace">
      <header className="workspace-heading">
        <div>
          <button className="clinical-button back-button" onClick={onClose}>
            {t("← 결과 목록으로")}
          </button>
          <h1>
            {heading || (results.length > 1
              ? t("{{value0}}개 검사 비교", { value0: results.length })
              : primary.metadata.caseName)}
          </h1>
          <p>
            {description || (results.length > 1
              ? t("{{value0}} · 구조 이름 기준 비교", { value0: primary.analysis.toUpperCase() })
              : `${primary.metadata.studyDescription || primary.name} · ${primary.analysis.toUpperCase()} · ${primary.variant.toUpperCase()}`)}
          </p>
        </div>
        <div className="result-view-actions">
        {!remote && <Publication results={results} />}
        {comparison && <ResultComparison results={results} actions={comparison} />}
        <div className="control-segment">
          <button aria-pressed={mode === "overlay"} onClick={() => setMode("overlay")}>
            {remote?t('Overlay·측정·QC'):<>Overlay &amp; metrics</>}
          </button>
          <button
            disabled={!can3d}
            aria-pressed={mode === "3d"}
            onClick={() => {
              setMode("3d");
              setState((s) => (s.explode ? { ...s, selected: s.selected.slice(0, 1) } : s));
            }}
          >
            {pendingMeshes ? t("3D 준비 중") : "3D anatomy"}
          </button>
        </div>
        </div>
      </header>
      {(error || workspaceError) && (
        <p className="inline-error" role="alert">
          {failureText(error || workspaceError)}
        </p>
      )}
      {results.filter(result => result.identityDiagnostic).map(result => (
        <p className="inline-error" role="status" key={result.id + ':identity'}>
          {result.metadata.caseName} · {failureText('', result.identityDiagnostic)}
        </p>
      ))}
      {mode === 'overlay' && results.filter(result => ["failed", "interrupted"].includes(result.meshState || "")).map(result => (
        <p className="inline-error" role="status" key={result.id}>
          {result.metadata.caseName} · {result.meshDiagnostic ? failureText('', result.meshDiagnostic)
            : t("3D 준비가 완료되지 않았습니다. 측정값과 Overlay는 사용할 수 있습니다.")}{" "}
          <button className="clinical-button" disabled={changing}
            onClick={() => void changeVariant(result, result.variant)}>{t("3D 다시 준비")}</button>
        </p>
      ))}
      <div
        ref={body}
        className={`result-body ${results.length > 1 ? "comparing" : ""}`}
        style={
          { "--metrics-width": panelWidth == null ? undefined : `${panelWidth}px` } as CSSProperties
        }
      >
        <aside className="metrics-panel">
          <div className="panel-title">
            <div className="control-segment">
              <button aria-pressed={table === "metrics"} onClick={() => setTable("metrics")}>
                {t("측정값")}
              </button>
              <button aria-pressed={table === "qc"} onClick={() => setTable("qc")}>
                {t("QC·후처리")}
              </button>
            </div>
          </div>
          <div className="metric-note">
            {primary.analysis === "xray"
              ? t("Projection area · 체적 환산 없음")
              : t("촬영 범위 내 체적 · 환자 기준 좌우")}{" "}
            · {primary.unit}
            <span>
              {" "}
              ·{" "}
              {allSelected
                ? t("전체 구조 선택")
                : t("{{value0}}개 구조 선택", { value0: selectedIds.length })}
            </span>
          </div>
          {primary.analysis === "mri" && table === "qc" && (
            <label className="qc-threshold">
              {t("TTA 검토 기준")}
              <input
                aria-label={t("TTA 검토 기준 %")}
                type="number"
                min={0}
                max={100}
                step={0.01}
                value={ttaThreshold}
                onChange={(e) => {
                  if (e.target.value !== "" && e.target.validity.valid)
                    setTtaThreshold(Number(e.target.value));
                }}
              />{" "}
              %
            </label>
          )}
          {(changing || preparing) && (
            <p className="metric-note" role="status">
              {preparing ? t("좌우 측정·3D 준비 중") : t("결과 variant 준비 중")}
            </p>
          )}
          <div className="metric-scroll">
            <table className={`clinical-table metric-table ${table === "qc" ? "qc-table" : ""}`}>
              <thead>
                <tr>
                  <th scope="col">
                    {table === "metrics" ? (
                      <label className="metric-name">
                        <input
                          type="checkbox"
                          aria-label={t("전체 구조 선택")}
                          checked={allSelected}
                          ref={(input) => {
                            if (input) input.indeterminate = !allSelected && selectedIds.length > 0;
                          }}
                          onChange={toggleAll}
                        />
                        Structure
                      </label>
                    ) : (
                      t("QC / 처리")
                    )}
                  </th>
                  {results.map((result) => (
                    <th scope="col" key={result.id}>
                      <strong className="metric-case-name" title={result.metadata.caseName}>
                        {result.metadata.caseName}
                        {result.analysis === "xray" && xrayView(result) && <small>{viewLabel(xrayView(result)!)}</small>}
                      </strong>
                      {result.analysis === "mri" && !remote ? (
                        <select
                          aria-label={t("{{value0}} MRI 결과 variant", {
                            value0: result.metadata.caseName,
                          })}
                          disabled={changing || preparing}
                          value={result.variant}
                          onChange={(e) => void changeVariant(result, e.target.value)}
                        >
                          <option value="raw">Raw</option>
                          <option value="pp500">PP500</option>
                          <option value="strong">{t("강화 후보")}</option>
                        </select>
                      ) : (
                        <small>{remote?`${result.variant.toUpperCase()} · `:''}{result.unit}</small>
                      )}
                      {result.qc.ttaDisagreement != null &&
                        result.qc.ttaDisagreement * 100 > ttaThreshold && (
                          <button className="qc-review" onClick={() => setTable("qc")}>
                            {t("검토 필요")}
                          </button>
                        )}
                      {table === "metrics" && result.analysis !== "xray" && (
                        <small>
                          {result.unit} / {result.analysis === "ct" ? "Fat-range %" : "Entropy"}
                        </small>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              {table === "metrics" ? (
                <tbody>
                  {catalog.map((row) => (
                    <tr
                      key={row.id}
                      data-structure={row.id}
                      aria-selected={selectedIds.includes(row.id)}
                      onClick={() => select(row.id)}
                    >
                      <td>
                        <button
                          className="metric-name"
                          type="button"
                          aria-label={t("{{value0}} 선택", { value0: row.name })}
                          aria-pressed={selectedIds.includes(row.id)}
                        >
                          <span className="class-dot" style={{ background: row.color }} />
                          {row.name}
                        </button>
                      </td>
                      {results.map((result) => {
                        const own = result.rows.find((r) => r.id === row.id);
                        return (
                          <td key={result.id}>
                            <strong>{result.analysis === "xray" && (!own || !xrayApplicable(result, own)) ? t("해당 없음") : number(own?.value)}</strong>
                            {result.analysis === "ct" && (
                              <small title="Fat-range %">{number(own?.fat)}</small>
                            )}
                            {result.analysis === "mri" && (
                              <small title="Entropy">{number(own?.entropy, 3)}</small>
                            )}
                            {own?.rawValue != null && result.variant !== "raw" && (
                              <small
                                className="pp-difference"
                                title={t("Raw {{value0}} {{value1}} · 제거 {{value2}} {{value3}}", {
                                  value0: number(own.rawValue),
                                  value1: result.unit,
                                  value2: number(own.rawValue - own.value),
                                  value3: result.unit,
                                })}
                              >
                                {t("제거 ")}
                                {number(own.rawValue - own.value)}
                              </small>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              ) : (
                <tbody>
                  {primary.analysis !== "xray" && (
                    <tr>
                      <td>{t("좌우 분류")}</td>
                      {results.map((result) => (
                        <td key={result.id}>
                          {t(result.laterality?.reason) || (result.laterality?t('자동 좌우 분류 · 검토 필요'):t("좌우 정보 준비 전"))}
                          {result.laterality && (
                            <small>
                              {t("미분류 ")}
                              {number(result.laterality.unassignedCm3)} cm³
                            </small>
                          )}
                          {result.rows
                            .filter((row) => row.sides?.unassigned.count)
                            .map((row) => (
                              <p key={row.id}>
                                {row.name} · {number(row.sides!.unassigned.value)}
                                {t(" cm³ 판정 보류")}
                              </p>
                            ))}
                        </td>
                      ))}
                    </tr>
                  )}
                  <tr>
                    <td>TTA</td>
                    {results.map((r) => (
                      <td key={r.id}>{r.qc.tta}</td>
                    ))}
                  </tr>
                  {!remote && <tr>
                    <td>{t("처리 시간")}</td>
                    {results.map((r) => (
                      <td key={r.id}>{number(r.seconds, 0)} s</td>
                    ))}
                  </tr>}
                  {results.some(result => result.compute) && (
                    <tr>
                      <td>{t("CT 계산 장치")}</td>
                      {results.map(result => (
                        <td key={result.id}>
                          {result.compute ? t("추론 {{value0}} · 합성 {{value1}}", {
                            value0: result.compute.device.startsWith("cuda") ? "GPU" : "CPU",
                            value1: result.compute.accumulation.startsWith("cuda") ? "GPU" : "CPU",
                          }) : "—"}
                          {result.compute?.accumulation_reason && <small>{t("GPU 메모리 제한으로 CPU 합성")}</small>}
                        </td>
                      ))}
                    </tr>
                  )}
                  {results.some(result => result.timings) && (
                    <>
                      {[
                        [t("측정·Overlay 열람까지"), (r: AnalysisResult) => r.timings?.ready],
                        [t("입력 확인·변환 (대기 포함)"), (r: AnalysisResult) => r.timings?.input],
                        [t("엔진 초기화·통신"), (r: AnalysisResult) => r.timings?.modelProcess == null ? undefined : Math.max(0, r.timings.modelProcess - r.seconds)],
                        [t("모델 로딩"), (r: AnalysisResult) => r.timings?.model?.model_loading],
                        [t("전처리"), (r: AnalysisResult) => r.timings?.model?.preprocessing],
                        [t("입력 GPU 전송"), (r: AnalysisResult) => r.timings?.model?.input_upload],
                        [t("추론"), (r: AnalysisResult) => r.timings?.model?.inference],
                        [t("추론·리샘플링 (LAT)"), (r: AnalysisResult) => r.timings?.model?.inference_with_resampling],
                        [t("원본 좌표 복원"), (r: AnalysisResult) => r.timings?.model?.native_restore],
                        [t("후처리"), (r: AnalysisResult) => r.timings?.model?.postprocessing],
                        [t("모델 측정"), (r: AnalysisResult) => r.timings?.model?.measurement],
                        [t("QC·엔트로피 계산"), (r: AnalysisResult) => r.timings?.model?.qc],
                        [t("Overlay 이미지 생성"), (r: AnalysisResult) => r.timings?.model?.overlay_generation],
                        [t("Slicer 메타데이터 생성"), (r: AnalysisResult) => r.timings?.model?.export_metadata],
                        [t("결과 파일 저장·복사"), (r: AnalysisResult) => r.timings?.model?.save],
                        [t("해시·재읽기 검증"), (r: AnalysisResult) => r.timings?.model?.verification],
                        [t("결과 저장·검증"), (r: AnalysisResult) => r.timings?.model?.export],
                        [t("기타 모델 처리"), (r: AnalysisResult) => r.timings?.model?.other],
                        [t("Logits 유한값 검사"), (r: AnalysisResult) => r.timings?.model?.logits_validation],
                        [t("확률 변환"), (r: AnalysisResult) => r.timings?.model?.probability_conversion],
                        [t("확률 검증"), (r: AnalysisResult) => r.timings?.model?.probability_validation],
                        [t("라벨 동일성 검사"), (r: AnalysisResult) => r.timings?.model?.label_validation],
                        [t("Ontology 해시"), (r: AnalysisResult) => r.timings?.model?.ontology_identity],
                        [t("소스 코드 해시"), (r: AnalysisResult) => r.timings?.model?.code_identity],
                        [t("실행환경 버전 조회"), (r: AnalysisResult) => r.timings?.model?.environment_identity],
                        [t("JSON·CSV 기록"), (r: AnalysisResult) => r.timings?.model?.metadata_write],
                        [t("라벨 데이터 해시"), (r: AnalysisResult) => r.timings?.model?.payload_hash],
                        [t("메모리 정리"), (r: AnalysisResult) => r.timings?.model?.cleanup],
                        [t("측정·Overlay 준비"), (r: AnalysisResult) => r.timings?.metricsOverlay],
                        [t("설치 파일 검증"), (r: AnalysisResult) => r.timings?.runtimeVerification],
                        [t("3D 생성"), (r: AnalysisResult) => r.timings?.mesh],
                        [t("메모리·GPU·CPU·결과 준비 대기"), (r: AnalysisResult) => r.timings?.ready == null ? undefined :
                          (r.timings.admissionWait || 0) + (r.timings.gpuWait || 0) + (r.timings.resultWait || 0) + (r.timings.model?.cpu_wait || 0)],
                        [t("3D 대기"), (r: AnalysisResult) => r.timings?.meshWait],
                      ].map(([label, value]) => {
                        const read = value as (r: AnalysisResult) => number | undefined;
                        if (!results.some(r => read(r) != null)) return null;
                        return <tr key={label as string}><td>{label as string}</td>
                          {results.map(r => <td key={r.id}>{number(read(r), 2)} s</td>)}
                        </tr>;
                      })}
                    </>
                  )}
                  {primary.analysis === "mri" && (
                    <>
                      <tr>
                        <td>TTA disagreement</td>
                        {results.map((r) => (
                          <td key={r.id}>
                            {number(
                              r.qc.ttaDisagreement == null ? null : r.qc.ttaDisagreement * 100,
                              4,
                            )}
                            %
                            {r.qc.ttaDisagreement != null &&
                              r.qc.ttaDisagreement * 100 > ttaThreshold && (
                                <>
                                  <small className="qc-review">
                                    {ttaThreshold}
                                    {t("% 초과")}
                                  </small>
                                  {!remote && <button
                                    className="clinical-button"
                                    disabled={changing || preparing || r.variant === "strong"}
                                    onClick={() => void changeVariant(r, "strong")}
                                  >
                                    {t("강화 후보 비교")}
                                  </button>}
                                </>
                              )}
                          </td>
                        ))}
                      </tr>
                      <tr>
                        <td>Foreground entropy</td>
                        {results.map((r) => (
                          <td key={r.id}>{number(r.qc.entropy, 3)}</td>
                        ))}
                      </tr>
                      <tr>
                        <td>{t("후처리")}</td>
                        {results.map((r) => (
                          <td key={r.id}>
                            {r.variant === "raw"
                              ? t("없음")
                              : r.variant === "pp500"
                                ? t("500 mm³ 미만 제거")
                                : t("PP500 + 근육별 최대 2성분")}
                          </td>
                        ))}
                      </tr>
                      <tr>
                        <td>{t("Raw 대비 제거량")}</td>
                        {results.map((r) => (
                          <td key={r.id}>
                            {r.qc.postprocessing ? (
                              <>
                                {number(r.qc.postprocessing.removedCm3)} cm³
                                <small>
                                  {number(r.qc.postprocessing.removedPercent, 2)}% ·{" "}
                                  {number(r.qc.postprocessing.changedVoxels, 0)} voxels
                                </small>
                              </>
                            ) : (
                              "—"
                            )}
                          </td>
                        ))}
                      </tr>
                    </>
                  )}
                  <tr>
                    <td>Component QC</td>
                    {results.map((r) => (
                      <td key={r.id}>
                        {r.qc.flags.length
                          ? r.qc.flags.map((flag) => {
                              const match = /^class_(\d+)_more_than_two_large_components$/.exec(
                                flag,
                              );
                              return (
                                <p key={flag}>
                                  {match
                                    ? t("{{value0}} · 1 cm³ 초과 성분 > 2", {
                                        value0:
                                          r.rows.find((row) => row.label === Number(match[1]))
                                            ?.name || match[1],
                                      })
                                    : t(flag)}
                                </p>
                              );
                            })
                          : t("해당 경고 없음")}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td>{t("미검출 구조")}</td>
                    {results.map((r) => (
                      <td key={r.id}>
                        {r.rows
                          .filter((row) => !row.present && (r.analysis !== "xray" || xrayApplicable(r, row)))
                          .map((row) => row.name)
                          .join(", ") || t("없음")}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td>{t("예상 외 label")}</td>
                    {results.map((r) => (
                      <td key={r.id}>{r.qc.unexpected.join(", ") || t("없음")}</td>
                    ))}
                  </tr>
                </tbody>
              )}
            </table>
          </div>
          <details className="qc-details">
            <summary>{t("측정·후처리 기준")}</summary>
            {results.some(result => result.timings) && <p>
              {t("단계별 벽시계 시간입니다. 3D는 결과 공개 후 처리되며, 동시 작업 시간은 단순 합산하지 않습니다. —는 미측정입니다.")}
            </p>}
            <p>
              {primary.analysis === "ct"
                ? t("Fat-range: −190 ~ −30 HU 범위 voxel 비율. 임상 지방침윤율·PDFF와 다릅니다.")
                : primary.analysis === "mri"
                  ? t(
                      "Water-only 모델은 지방침윤을 계산하지 않습니다. Entropy는 검토 지표이며 보정된 신뢰도가 아닙니다.",
                    )
                  : t(
                      "촬영 방향 점수는 분류 모델 점수입니다. Segmentation 정확도·근육 지방침윤율이 아닙니다.",
                    )}
            </p>
            {primary.analysis === "mri" && (
              <>
                <p>
                  {t(
                    "강화 후보: 6-connectivity에서 500 mm³ 미만 성분을 제거하고 근육 label 1–23은 큰 성분을 최대 2개 유지합니다. 몸통·뼈 label 24–28에는 개수 제한을 적용하지 않습니다.",
                  )}
                </p>
                <p>
                  {t(
                    "분리된 정상 근육 일부도 제거될 수 있는 검토용 후보입니다. Raw 대비 체적·Overlay를 확인하세요. TTA 검토 기준은 사용자 설정이며 후처리로 원래 TTA disagreement가 바뀌지 않습니다.",
                  )}
                </p>
              </>
            )}
            <p>{t("모델 산출물 · 임상 검토 전")}</p>
            {primary.analysis !== "xray" && (
              <p>
                {t(
                  "좌우 체적은 원본 voxel 기준이며 Left + Right + 미분류 = 합계입니다. Δ = |L − R|, Δ% = |L − R| / mean(L, R) × 100. 한쪽 미검출·미분류가 있으면 차이를 확정하지 않습니다. 촬영 범위가 다른 검사끼리 체적을 직접 해석할 때 주의하세요.",
                )}
              </p>
            )}
          </details>
        </aside>
        <div
          className="metrics-resizer"
          role="separator"
          tabIndex={0}
          aria-label={t("측정 패널 너비")}
          aria-orientation="vertical"
          aria-valuemin={280}
          aria-valuemax={panelSize.max}
          aria-valuenow={panelSize.width}
          aria-valuetext={`${panelSize.width} px`}
          title={t("드래그하여 너비 조절 · 두 번 클릭하면 기본 너비")}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.focus();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { pointer: e.pointerId, x: e.clientX, width: panelSize.width };
            e.currentTarget.dataset.dragging = "true";
          }}
          onPointerMove={(e) => {
            if (drag.current?.pointer === e.pointerId)
              resizePanel(drag.current.width + e.clientX - drag.current.x);
          }}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onLostPointerCapture={(e) => {
            drag.current = null;
            delete e.currentTarget.dataset.dragging;
          }}
          onDoubleClick={() => setPanelWidth(undefined)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              resizePanel(panelSize.width + (e.key === "ArrowRight" ? 20 : -20));
            }
          }}
        />
        <div className="result-imaging">
          {mode === "3d" && (
            <div className="render-toolbar">
              <div className="control-segment">
                {(["front", "back", "side", "three-quarter"] as const).map((view, i) => (
                  <button
                    key={view}
                    aria-pressed={state.view === view}
                    onClick={() => setState((s) => ({ ...s, view, rotate: false }))}
                  >
                    {["Front", "Back", "Side", "3/4"][i]}
                  </button>
                ))}
              </div>
              <button
                className="clinical-button"
                aria-pressed={!!state.explode}
                onClick={() => {
                  setActive(null);
                  setState((s) => ({
                    ...s,
                    explode: s.explode ? 0 : 1,
                    selected: [],
                    isolate: false,
                  }));
                }}
              >
                {state.explode ? "Assemble" : "Explode anatomy"}
              </button>
              <select
                aria-label={t("구조 그룹")}
                value={state.group}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    group: e.target.value as SceneState["group"],
                    selected: s.explode ? [] : s.selected,
                  }))
                }
              >
                {GROUPS.map((group) => (
                  <option key={group}>{group}</option>
                ))}
              </select>
              <select
                aria-label={t("색상 preset")}
                value={state.colorPreset}
                onChange={(e) =>
                  setState((s) => ({
                    ...s,
                    colorPreset: e.target.value as SceneState["colorPreset"],
                  }))
                }
              >
                <option value="class">Class colors</option>
                <option value="anatomical">Muscle colors</option>
              </select>
              <button
                className="text-button"
                onClick={() => {
                  setState((s) => ({ ...INITIAL_STATE, group: "All", reset: s.reset + 1 }));
                }}
              >
                Reset
              </button>
            </div>
          )}
          <div className={`case-canvases count-${viewports.length}`}>
            {viewports.map(({result, key, assembled}) => {
              const chosen = result.rows.filter((r) => selectedIds.includes(r.id) && (result.analysis !== "xray" || xrayApplicable(result, r)));
              const sceneKey = `${key}:${result.variant}:${result.meshBytes}`;
              const sceneError = sceneErrors[sceneKey];
              return (
                <div
                  className="case-canvas"
                  key={key}
                  data-result-id={result.id}
                  data-layout={mode === "3d" ? assembled ? "assembled" : "exploded" : "overlay"}
                  data-active={active === result.id}
                >
                  {comparison && results.length > 1 && <div className="comparison-case-action">{result.id === primary.id
                    ? <span>{t("기준 영상")}</span> : <button className="text-button comparison-remove"
                    onClick={() => {comparison.onRemove(result.id); if (active === result.id) setActive(null);}}
                    aria-label={t("{{value0}} 비교에서 제외", {value0: result.metadata.caseName})}>{t("비교에서 제외")}</button>}</div>}
                  <button className="case-title" onClick={() => setActive(result.id)}>
                    {paired && <span className="viewport-layout">{t(assembled ? "전체 형태" : "분해 형태")}</span>}
                    <strong>{result.metadata.caseName}</strong>
                    <span>
                      {result.route || result.analysis.toUpperCase()} ·{" "}
                      {result.variant.toUpperCase()} ·{" "}
                      {result.metadata.studyDate || result.metadata.seriesDescription}
                    </span>
                    {selectedIds.length > 0 && !allSelected && (
                      <span>
                        {result.analysis === "xray" && !chosen.length ? t("해당 없음") : selectedIds.length === 1
                          ? t("{{value0}} · {{value1}} {{value2}}", {
                              value0: selected?.name || chosen[0]?.name || t("선택 구조"),
                              value1: number(chosen[0]?.value),
                              value2: result.unit,
                            })
                          : t("{{value0}}개 구조 선택", { value0: selectedIds.length })}
                        {!(result.analysis === "xray" && !chosen.length) && !chosen.some((row) => row.present) && t(" · 미검출 / 판정 보류")}
                      </span>
                    )}
                  </button>
                  {caseErrors[result.id] && <p className="inline-error" role="alert">{failureText(caseErrors[result.id])}</p>}
                  {mode === "overlay" && remote ? <RemoteOverlayImage overlay={remote.overlays?.[result.id]} /> : mode === "overlay" ? (
                    <ImagePreview
                      key={result.id}
                      revision={`${result.variant}:${result.laterality?.method || "legacy"}`}
                      analysis={result.analysis}
                      id={result.id}
                      result
                      analysisRevision={result.analysisRevision}
                      classIds={allSelected ? null : chosen.map((row) => row.label)}
                    />
                  ) : !result.meshBytes || needsPreparation(result) ? (
                    <div className="inline-error" role="status">{remote?(result.meshState==='pending'?t('3D 후속 전송 대기'):t('해당 결과에는 게시된 3D가 없습니다.')):result.meshDiagnostic
                      ? failureText('', result.meshDiagnostic) : t("3D 준비가 완료되지 않았습니다. 측정값과 Overlay는 사용할 수 있습니다.")}
                      {!remote && ['failed','interrupted'].includes(result.meshState || '') && <p><button className="clinical-button" disabled={changing}
                        onClick={() => void changeVariant(result, result.variant)}>{t("3D 다시 준비")}</button></p>}
                    </div>
                  ) : (
                    <div className="result-scene">
                      <AnatomyScene<string>
                        key={`${sceneKey}:${sceneRetries[sceneKey] || 0}`}
                        model={models.get(result.id)}
                        state={paired && assembled ? assembledState : sceneState}
                        highlightedId={paired ? linkedHover?.id : undefined}
                        onHover={paired ? id => setLinkedHover(previous => id
                          ? {viewport: key, id}
                          : previous?.viewport === key ? null : previous) : undefined}
                        caseOpacity={
                          !state.selected.length && !state.explode && active && active !== result.id
                            ? 0.18
                            : 1
                        }
                        onSelect={(id) => select(id, result.id, !assembled)}
                        onProgress={(value) => setProgress((p) => ({ ...p, [key]: value }))}
                        onError={(_message, issue) => {
                          const failure = sceneDiagnostic(issue?.code, issue?.reference);
                          setSceneErrors(previous => ({...previous,[sceneKey]:failure}));
                          if(!remote)void window.exmoDesktop.sceneFailure(result.id, failure.code, failure.reference).catch(() => {});
                        }}
                        onInteract={() => {}}
                        onImageMenu={remote?undefined:image => {
                          setError("");
                          void window.exmoDesktop.imageMenu({image,
                            filename: `${result.analysis.toUpperCase()}_${result.metadata.studyDate || "undated"}_3D_${assembled ? "assembled" : "exploded"}_${state.view}.png`,
                            source: {kind:"result",id:result.id},
                            language,
                          }).then(unwrap).catch(error => setError(error));
                        }}
                        renderMeasurement={(structure, hoveredSide) => {
                          const row = result.rows.find((r) => r.id === structure.id)!;
                          if (row.sides)
                            return (
                              <div className="actual-laterality">
                                <p>
                                  {hoveredSide == null
                                    ? t("좌우 판정 보류 영역")
                                    : t("환자 {{value0}} · 분할 체적", {
                                        value0: t(hoveredSide === "left" ? "좌측" : "우측"),
                                      })}{" "}
                                  · cm³
                                </p>
                                <SideValues row={row} primarySide={hoveredSide || "unassigned"} />
                              </div>
                            );
                          return (
                            <dl className="actual-measurement">
                              <dt>Volume</dt>
                              <dd>{number(row.value)} cm³</dd>
                              {row.fat != null && (
                                <>
                                  <dt>Fat-range</dt>
                                  <dd>{number(row.fat)}%</dd>
                                </>
                              )}
                              <dt>Side</dt>
                              <dd>{t("좌우 미분리")}</dd>
                            </dl>
                          );
                        }}
                      />
                      {sceneError && <div className="scene-error" role="alert">
                        <p>{failureText('', sceneError)}</p>
                        <button className="clinical-button" onClick={() => {
                          setSceneErrors(previous => ({...previous,[sceneKey]:undefined}));
                          setProgress(previous => ({...previous,[key]:0}));
                          setSceneRetries(previous => ({...previous,[sceneKey]:(previous[sceneKey] || 0)+1}));
                        }}>{t("뷰 다시 열기")}</button>
                      </div>}
                      {!sceneError && (progress[key] ?? 0) < 100 && (
                        <div className="scene-loading">
                          {t("3D 준비 ")}
                          {progress[key] || 0}%
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {mode === "3d" && (
            <footer className="render-hint">
              <span>
                {remote?t('좌클릭 선택 · 드래그 회전 · 휠 확대 · 휠 버튼 이동'):t("좌클릭 선택 · 좌클릭 드래그 회전 · 휠 확대 · 휠 버튼 드래그 이동 · 우클릭 이미지 복사·저장")}
              </span>
              <label>
                Surrounding opacity
                <input
                  aria-label="Surrounding opacity"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={state.contextOpacity}
                  onChange={(e) =>
                    setState((s) => ({ ...s, contextOpacity: Number(e.target.value) }))
                  }
                />
              </label>
            </footer>
          )}
        </div>
      </div>
    </section>
  );
}
