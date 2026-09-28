import { t, useLanguage } from "./language";
import { useEffect, useRef, useState } from "react";
import { type Analysis, type Preview, type PreviewOptions, unwrap } from "./imaging";

export default function ImagePreview({
  analysis,
  id,
  result = false,
  classIds,
  side = "all",
  revision = "input",
  compact = false,
}: {
  analysis: Analysis;
  id: string;
  result?: boolean;
  classIds?: number[] | null;
  side?: PreviewOptions["side"];
  revision?: string;
  compact?: boolean;
}) {
  useLanguage();
  const [view, setView] = useState<NonNullable<PreviewOptions["view"]>>("axial");
  const [index, setIndex] = useState<number | null>(null);
  const [windowing, setWindow] = useState<"soft" | "bone">("soft");
  const [opacity, setOpacity] = useState(0.45);
  const [data, setData] = useState<Preview>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; y: number; index: number } | null>(null);
  const current = useRef(data);
  current.current = data;
  const selection = classIds == null ? "all" : classIds.join(",");
  const identity = `${analysis}:${id}:${revision}:${result}:${view}:${windowing}:${selection}:${side}`;
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  const pending = useRef<{
    identity: string;
    analysis: Analysis;
    id: string;
    result: boolean;
    options: PreviewOptions;
  } | null>(null);
  const inFlight = useRef(false);
  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      pending.current = null;
    };
  }, []);
  useEffect(() => {
    setData(undefined);
    setIndex(null);
    setError("");
  }, [id]);
  useEffect(() => {
    // One in-flight image per viewport. Continuous input replaces the pending
    // request, while completed slices remain visible during the gesture.
    pending.current = {
      identity,
      analysis,
      id,
      result,
      options: {
        view,
        index,
        window: windowing,
        opacity,
        classIds: selection === "all" ? null : selection ? selection.split(",").map(Number) : [],
        side,
      },
    };
    setLoading(true);
    setError("");
    if (inFlight.current) return;
    inFlight.current = true;
    void (async () => {
      while (!disposed.current && pending.current) {
        const request = pending.current;
        pending.current = null;
        try {
          const value = unwrap(
            await (request.result
              ? window.exmoDesktop.resultPreview(request.id, request.options)
              : window.exmoDesktop.preview(request.analysis, request.id, request.options)),
          );
          if (!disposed.current && request.identity === latestIdentity.current) {
            setData(value);
            setError("");
          }
        } catch (error) {
          if (!disposed.current && request.identity === latestIdentity.current)
            setError((error as Error).message);
        }
      }
      inFlight.current = false;
      if (!disposed.current) setLoading(false);
    })();
  }, [analysis, id, revision, result, view, index, windowing, selection, opacity, side]);
  useEffect(() => {
    const host = area.current;
    if (!host) return;
    function wheel(event: WheelEvent) {
      const value = current.current;
      if (!value || value.count < 2) return;
      event.preventDefault();
      setIndex((previous) =>
        Math.min(value.count - 1, Math.max(0, (previous ?? value.index) + Math.sign(event.deltaY))),
      );
    }
    host.addEventListener("wheel", wheel, { passive: false });
    return () => host.removeEventListener("wheel", wheel);
  }, []);
  return (
    <div className={`medical-preview ${compact ? "compact" : ""}`}>
      <div className="preview-toolbar">
        {analysis !== "xray" ? (
          <div className="control-segment" aria-label={t("보기 방향")}>
            {(["axial", "coronal", "sagittal"] as const).map((item) => (
              <button
                key={item}
                aria-pressed={view === item}
                onClick={() => {
                  setView(item);
                  setIndex(null);
                }}
              >
                {item[0].toUpperCase() + item.slice(1)}
              </button>
            ))}
          </div>
        ) : (
          <span>Projection</span>
        )}
        {analysis === "ct" && (
          <select
            aria-label="CT window"
            value={windowing}
            onChange={(e) => setWindow(e.target.value as "soft" | "bone")}
          >
            <option value="soft">Soft tissue</option>
            <option value="bone">Bone</option>
          </select>
        )}
      </div>
      <div
        className="medical-image"
        ref={area}
        tabIndex={0}
        aria-label={t("영상 preview · 휠 또는 가운데 버튼 드래그로 slice 이동")}
        title={
          analysis === "xray"
            ? undefined
            : t("휠 스크롤 · 가운데 버튼을 누른 채 위아래로 드래그하여 slice 이동")
        }
        onPointerDown={(e) => {
          if (e.button !== 1 || !data || data.count < 2) return;
          e.preventDefault();
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { pointer: e.pointerId, y: e.clientY, index: index ?? data.index };
          e.currentTarget.dataset.dragging = "true";
        }}
        onPointerMove={(e) => {
          const start = drag.current;
          if (!start || start.pointer !== e.pointerId || !data) return;
          e.preventDefault();
          const next = Math.max(
            0,
            Math.min(data.count - 1, start.index + Math.trunc((e.clientY - start.y) / 4)),
          );
          setIndex(next);
        }}
        onPointerUp={(e) => {
          if (drag.current?.pointer !== e.pointerId) return;
          drag.current = null;
          delete e.currentTarget.dataset.dragging;
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onLostPointerCapture={(e) => {
          drag.current = null;
          delete e.currentTarget.dataset.dragging;
        }}
        onPointerCancel={(e) => {
          drag.current = null;
          delete e.currentTarget.dataset.dragging;
        }}
        onAuxClick={(e) => {
          if (e.button === 1) e.preventDefault();
        }}
        onKeyDown={(e) => {
          if (data && ["ArrowUp", "ArrowDown"].includes(e.key)) {
            e.preventDefault();
            setIndex((old) =>
              Math.max(
                0,
                Math.min(data.count - 1, (old ?? data.index) + (e.key === "ArrowDown" ? 1 : -1)),
              ),
            );
          }
        }}
      >
        {data && !error && (
          <img src={data.image} alt={`${data.view} slice ${data.index + 1}`} draggable={false} />
        )}
        {error ? (
          <p role="alert">{t(error)}</p>
        ) : !data ? (
          <span className="preview-placeholder">{t("영상 준비 중")}</span>
        ) : null}
        {data?.sides.map((side, i) => (
          <span key={i} className={`orientation orientation-${i}`}>
            {side}
          </span>
        ))}
        {loading && data && <span className="preview-updating">{t("갱신 중")}</span>}
      </div>
      <div className="preview-footer">
        <span>{data ? `${data.index + 1} / ${data.count}` : "—"}</span>
        {data && data.count > 1 && (
          <input
            type="range"
            aria-label="Slice"
            min={0}
            max={data.count - 1}
            value={index ?? data.index}
            onChange={(e) => setIndex(Number(e.target.value))}
          />
        )}
        <span>{analysis === "xray" ? "2D" : "mm"}</span>
      </div>
      {result && !compact && (
        <label className="overlay-opacity">
          Overlay
          <input
            aria-label="Overlay opacity"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
          />
          <span>{Math.round(opacity * 100)}%</span>
        </label>
      )}
    </div>
  );
}
