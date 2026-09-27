import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import AnatomyScene from "../../app/scene";
import { GROUPS, INITIAL_STATE, inGroup, type SceneState } from "../../app/anatomy";
import ImagePreview from "./image-preview";
import {
  number,
  unwrap,
  type AnalysisResult,
  type AnatomicalSide,
  type MetricRow,
} from "./imaging";

const sideName = { left: "Left", right: "Right", unassigned: "미분류" };

function SideValues({ row, primarySide }: { row: MetricRow; primarySide: AnatomicalSide }) {
  if (!row.sides) return null;
  const order: AnatomicalSide[] = primarySide === "right" ? ["right", "left"] : ["left", "right"];
  return (
    <div className="bilateral-values">
      {order.map((side) => (
        <div key={side} data-primary={primarySide === side}>
          <span>
            {sideName[side]}
            {primarySide === side && " · 현재"}
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
        title="|L − R| / mean(L, R) × 100. 양쪽이 검출되고 미분류가 없을 때만 계산합니다."
      >
        {row.sides.differencePercent == null ? (
          "Δ 판정 보류"
        ) : (
          <>
            차이 {number(row.sides.differenceCm3)} cm³ · 양측 평균 대비{" "}
            {number(row.sides.differencePercent)}%
          </>
        )}
      </small>
      {row.sides.unassigned.count > 0 && (
        <small className="side-unassigned">미분류 {number(row.sides.unassigned.value)} cm³</small>
      )}
    </div>
  );
}

export default function ResultView({
  results,
  onClose,
  onUpdate,
}: {
  results: AnalysisResult[];
  onClose: () => void;
  onUpdate: (result: AnalysisResult) => void;
}) {
  const [active, setActive] = useState<string | null>(results.length === 1 ? results[0].id : null);
  const [requestedMode, setMode] = useState<"overlay" | "3d">("overlay");
  const [state, setState] = useState<SceneState<string>>({ ...INITIAL_STATE, group: "All" });
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [changing, setChanging] = useState(false);
  const [table, setTable] = useState<"metrics" | "qc">("metrics");
  const [ttaThreshold, setTtaThreshold] = useState(1.16);
  const needsPreparation = (result: AnalysisResult) =>
    result.analysis !== "xray" && result.laterality?.method !== "femur_components_lps_v1";
  const [preparing, setPreparing] = useState(() => results.some(needsPreparation));
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        for (const result of results.filter(needsPreparation)) {
          const updated = unwrap(await window.exmoDesktop.variant(result.id, result.variant));
          if (!disposed) onUpdate(updated);
        }
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      } finally {
        if (!disposed) setPreparing(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);
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
      isolate: results.length > 1 && !!state.explode && state.selected.length > 0,
    }),
    [state, results.length],
  );
  const models = useMemo(
    () =>
      new Map(
        results.map((result) => [
          result.id,
          {
            url: `/result/${result.id}.glb?v=${result.variant}&lr=${result.laterality?.method || "legacy"}`,
            bytes: result.meshBytes || 0,
            structures: result.rows.filter((row) => row.present),
            parts: result.parts,
          },
        ]),
      ),
    [results],
  );
  const can3d =
    !preparing && results.every((result) => result.meshBytes && !needsPreparation(result));
  const mode = requestedMode === "3d" && !can3d ? "overlay" : requestedMode;
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
    setChanging(true);
    setError("");
    try {
      onUpdate(unwrap(await window.exmoDesktop.variant(result.id, variant)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChanging(false);
    }
  }
  function select(id: string | null, caseId = primary.id) {
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
        selected: s.explode
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
            ← 결과 목록으로
          </button>
          <h1>
            {results.length > 1 ? `${results.length}개 검사 비교` : primary.metadata.caseName}
          </h1>
          <p>
            {results.length > 1
              ? `${primary.analysis.toUpperCase()} · 구조 이름 기준 비교`
              : `${primary.metadata.studyDescription || primary.name} · ${primary.analysis.toUpperCase()} · ${primary.variant.toUpperCase()}`}
          </p>
        </div>
        <div className="control-segment">
          <button aria-pressed={mode === "overlay"} onClick={() => setMode("overlay")}>
            Overlay &amp; metrics
          </button>
          <button
            disabled={!can3d}
            aria-pressed={mode === "3d"}
            onClick={() => {
              setMode("3d");
              setState((s) => (s.explode ? { ...s, selected: s.selected.slice(0, 1) } : s));
            }}
          >
            3D anatomy
          </button>
        </div>
      </header>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
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
                측정값
              </button>
              <button aria-pressed={table === "qc"} onClick={() => setTable("qc")}>
                QC·후처리
              </button>
            </div>
          </div>
          <div className="metric-note">
            {primary.analysis === "xray"
              ? "Projection area · 체적 환산 없음"
              : "촬영 범위 내 체적 · 환자 기준 좌우"}{" "}
            · {primary.unit}
            <span> · {allSelected ? "전체 구조 선택" : `${selectedIds.length}개 구조 선택`}</span>
          </div>
          {primary.analysis === "mri" && table === "qc" && (
            <label className="qc-threshold">
              TTA 검토 기준
              <input
                aria-label="TTA 검토 기준 %"
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
              {preparing ? "좌우 측정·3D 준비 중" : "결과 variant 준비 중"}
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
                          aria-label="전체 구조 선택"
                          checked={allSelected}
                          ref={(input) => {
                            if (input) input.indeterminate = !allSelected && selectedIds.length > 0;
                          }}
                          onChange={toggleAll}
                        />
                        Structure
                      </label>
                    ) : (
                      "QC / 처리"
                    )}
                  </th>
                  {results.map((result) => (
                    <th scope="col" key={result.id}>
                      <strong className="metric-case-name" title={result.metadata.caseName}>
                        {result.metadata.caseName}
                      </strong>
                      {result.analysis === "mri" ? (
                        <select
                          aria-label={`${result.metadata.caseName} MRI 결과 variant`}
                          disabled={changing || preparing}
                          value={result.variant}
                          onChange={(e) => void changeVariant(result, e.target.value)}
                        >
                          <option value="raw">Raw</option>
                          <option value="pp500">PP500</option>
                          <option value="strong">강화 후보</option>
                        </select>
                      ) : (
                        <small>{result.unit}</small>
                      )}
                      {result.qc.ttaDisagreement != null &&
                        result.qc.ttaDisagreement * 100 > ttaThreshold && (
                          <button className="qc-review" onClick={() => setTable("qc")}>
                            검토 필요
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
                          aria-label={`${row.name} 선택`}
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
                            <strong>{number(own?.value)}</strong>
                            {result.analysis === "ct" && (
                              <small title="Fat-range %">{number(own?.fat)}</small>
                            )}
                            {result.analysis === "mri" && (
                              <small title="Entropy">{number(own?.entropy, 3)}</small>
                            )}
                            {own?.rawValue != null && result.variant !== "raw" && (
                              <small
                                className="pp-difference"
                                title={`Raw ${number(own.rawValue)} ${result.unit} · 제거 ${number(own.rawValue - own.value)} ${result.unit}`}
                              >
                                제거 {number(own.rawValue - own.value)}
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
                      <td>좌우 분류</td>
                      {results.map((result) => (
                        <td key={result.id}>
                          {result.laterality?.reason || "좌우 정보 준비 전"}
                          {result.laterality && (
                            <small>미분류 {number(result.laterality.unassignedCm3)} cm³</small>
                          )}
                          {result.rows
                            .filter((row) => row.sides?.unassigned.count)
                            .map((row) => (
                              <p key={row.id}>
                                {row.name} · {number(row.sides!.unassigned.value)} cm³ 판정 보류
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
                  <tr>
                    <td>처리 시간</td>
                    {results.map((r) => (
                      <td key={r.id}>{number(r.seconds, 0)} s</td>
                    ))}
                  </tr>
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
                                  <small className="qc-review">{ttaThreshold}% 초과</small>
                                  <button
                                    className="clinical-button"
                                    disabled={changing || preparing || r.variant === "strong"}
                                    onClick={() => void changeVariant(r, "strong")}
                                  >
                                    강화 후보 비교
                                  </button>
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
                        <td>후처리</td>
                        {results.map((r) => (
                          <td key={r.id}>
                            {r.variant === "raw"
                              ? "없음"
                              : r.variant === "pp500"
                                ? "500 mm³ 미만 제거"
                                : "PP500 + 근육별 최대 2성분"}
                          </td>
                        ))}
                      </tr>
                      <tr>
                        <td>Raw 대비 제거량</td>
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
                                    ? `${r.rows.find((row) => row.label === Number(match[1]))?.name || match[1]} · 1 cm³ 초과 성분 > 2`
                                    : flag}
                                </p>
                              );
                            })
                          : "해당 경고 없음"}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td>미검출 구조</td>
                    {results.map((r) => (
                      <td key={r.id}>
                        {r.rows
                          .filter((row) => !row.present)
                          .map((row) => row.name)
                          .join(", ") || "없음"}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td>예상 외 label</td>
                    {results.map((r) => (
                      <td key={r.id}>{r.qc.unexpected.join(", ") || "없음"}</td>
                    ))}
                  </tr>
                </tbody>
              )}
            </table>
          </div>
          <details className="qc-details">
            <summary>측정·후처리 기준</summary>
            <p>
              {primary.analysis === "ct"
                ? "Fat-range: −190 ~ −30 HU 범위 voxel 비율. 임상 지방침윤율·PDFF와 다릅니다."
                : primary.analysis === "mri"
                  ? "Water-only 모델은 지방침윤을 계산하지 않습니다. Entropy는 검토 지표이며 보정된 신뢰도가 아닙니다."
                  : "촬영 방향 점수는 분류 모델 점수입니다. Segmentation 정확도·근육 지방침윤율이 아닙니다."}
            </p>
            {primary.analysis === "mri" && (
              <>
                <p>
                  강화 후보: 6-connectivity에서 500 mm³ 미만 성분을 제거하고 근육 label 1–23은 큰
                  성분을 최대 2개 유지합니다. 몸통·뼈 label 24–28에는 개수 제한을 적용하지 않습니다.
                </p>
                <p>
                  분리된 정상 근육 일부도 제거될 수 있는 검토용 후보입니다. Raw 대비 체적·Overlay를
                  확인하세요. TTA 검토 기준은 사용자 설정이며 후처리로 원래 TTA disagreement가
                  바뀌지 않습니다.
                </p>
              </>
            )}
            <p>모델 산출물 · 임상 검토 전</p>
            {primary.analysis !== "xray" && (
              <p>
                좌우 체적은 원본 voxel 기준이며 Left + Right + 미분류 = 합계입니다. Δ = |L − R|, Δ%
                = |L − R| / mean(L, R) × 100. 한쪽 미검출·미분류가 있으면 차이를 확정하지 않습니다.
                촬영 범위가 다른 검사끼리 체적을 직접 해석할 때 주의하세요.
              </p>
            )}
          </details>
        </aside>
        <div
          className="metrics-resizer"
          role="separator"
          tabIndex={0}
          aria-label="측정 패널 너비"
          aria-orientation="vertical"
          aria-valuemin={280}
          aria-valuemax={panelSize.max}
          aria-valuenow={panelSize.width}
          aria-valuetext={`${panelSize.width} px`}
          title="드래그하여 너비 조절 · 두 번 클릭하면 기본 너비"
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
                aria-label="구조 그룹"
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
                aria-label="색상 preset"
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
          <div className={`case-canvases count-${results.length}`}>
            {results.map((result) => {
              const chosen = result.rows.filter((r) => selectedIds.includes(r.id));
              return (
                <div
                  className="case-canvas"
                  key={result.id}
                  data-result-id={result.id}
                  data-active={active === result.id}
                >
                  <button className="case-title" onClick={() => setActive(result.id)}>
                    <strong>{result.metadata.caseName}</strong>
                    <span>
                      {result.route || result.analysis.toUpperCase()} ·{" "}
                      {result.variant.toUpperCase()} ·{" "}
                      {result.metadata.studyDate || result.metadata.seriesDescription}
                    </span>
                    {selectedIds.length > 0 && !allSelected && (
                      <span>
                        {selectedIds.length === 1
                          ? `${selected?.name || chosen[0]?.name || "선택 구조"} · ${number(chosen[0]?.value)} ${result.unit}`
                          : `${selectedIds.length}개 구조 선택`}
                        {!chosen.some((row) => row.present) && " · 미검출 / 판정 보류"}
                      </span>
                    )}
                  </button>
                  {mode === "overlay" ? (
                    <ImagePreview
                      key={result.id}
                      revision={`${result.variant}:${result.laterality?.method || "legacy"}`}
                      analysis={result.analysis}
                      id={result.id}
                      result
                      classIds={allSelected ? null : chosen.map((row) => row.label)}
                    />
                  ) : (
                    <div className="result-scene">
                      <AnatomyScene<string>
                        model={models.get(result.id)}
                        state={sceneState}
                        caseOpacity={
                          !state.selected.length && !state.explode && active && active !== result.id
                            ? 0.18
                            : 1
                        }
                        onSelect={(id) => select(id, result.id)}
                        onProgress={(value) => setProgress((p) => ({ ...p, [result.id]: value }))}
                        onError={setError}
                        onInteract={() => {}}
                        renderMeasurement={(structure, hoveredSide) => {
                          const row = result.rows.find((r) => r.id === structure.id)!;
                          if (row.sides)
                            return (
                              <div className="actual-laterality">
                                <p>
                                  {hoveredSide == null
                                    ? "좌우 판정 보류 영역"
                                    : `환자 ${hoveredSide === "left" ? "좌측" : "우측"} · 분할 체적`}{" "}
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
                              <dd>좌우 미분리</dd>
                            </dl>
                          );
                        }}
                      />
                      {(progress[result.id] ?? 0) < 100 && (
                        <div className="scene-loading">3D 준비 {progress[result.id] || 0}%</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {mode === "3d" && (
            <footer className="render-hint">
              <span>좌클릭 선택 · 드래그 회전 · 휠 확대 · Explode 선택 구조 우클릭 회전</span>
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
