import { t, useLanguage, localeTag } from "./language";
import LanguageSelect from "./language-select";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import Home from "../../app/page";
import ThighWorkspace, { type Analysis } from "./thigh-workspace";
import { unwrap, type AnalysisResult, type ModelStatus } from "./imaging";
import "../../app/globals.css";
import "./workspace.css";

const analyses = [
  {
    id: "ct",
    name: "CT",
    protocol: "3D CT · HU",
    output: "Volume · HU fat-range · 3D",
    input: "DICOM / NRRD / NIfTI",
  },
  {
    id: "mri",
    name: "MRI",
    protocol: "3D Water sequence",
    output: "Volume · TTA / QC · 3D",
    input: "DICOM / NRRD / NIfTI",
  },
  {
    id: "xray",
    name: "X-ray",
    protocol: "AP / LAT-LT / LAT-RT",
    output: "Projection area · Overlay",
    input: "NRRD · DICOM 방향 확인",
  },
] as const;

function Desktop() {
  const language = useLanguage();
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  const [view, setView] = useState<Analysis | "home" | "demo">(
    location.hash === "#xray" ? "xray" : "home",
  );
  const [status, setStatus] = useState<Partial<Record<Analysis, ModelStatus>>>({});
  const [recent, setRecent] = useState<AnalysisResult[]>([]);
  const [initialResult, setInitialResult] = useState<string>();
  useEffect(() => {
    if (view !== "home") return;
    let stale = false;
    void Promise.all(
      analyses.map(async ({ id }) => ({
        id,
        status: unwrap(await window.exmoDesktop.status(id)),
        results: unwrap(await window.exmoDesktop.results(id)),
      })),
    )
      .then((values) => {
        if (stale) return;
        setStatus(Object.fromEntries(values.map((value) => [value.id, value.status])));
        setRecent(
          values
            .flatMap((value) => value.results)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 8),
        );
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [view]);
  return (
    <div className="desktop-shell dark">
      {view !== "demo" && (
        <nav className="desktop-nav" aria-label="Desktop navigation">
          <button
            className="desktop-brand"
            aria-label={t("분석 선택으로")}
            onClick={() => setView("home")}
          >
            <img src="/brand/exmo-logo-white.svg" alt="EXMO" />
          </button>
          <span className="desktop-nav-label">Clinical imaging workspace</span>
          <button className="desktop-demo-link" onClick={() => setView("demo")}>
            {t("3D 데모")}
          </button>
          <LanguageSelect />
        </nav>
      )}
      <main className="desktop-content">
        {view === "home" && (
          <section className="analysis-catalog" aria-label={t("분석 선택")}>
            <div className="analysis-catalog-inner">
              <header className="catalog-heading">
                <div>
                  <p className="analysis-eyebrow">LOWER EXTREMITY</p>
                  <h1>{t("분석 작업")}</h1>
                  <p>Thigh muscle estimation</p>
                </div>
                <span>Desktop · Local processing</span>
              </header>
              <div className="catalog-section">
                <div className="panel-title">
                  <strong>{t("분석 프로토콜")}</strong>
                  <span>{t("프로토콜 선택 후 영상을 등록합니다")}</span>
                </div>
                <table className="clinical-table protocol-table">
                  <thead>
                    <tr>
                      <th>Modality</th>
                      <th>{t("분석 / 입력 조건")}</th>
                      <th>{t("결과")}</th>
                      <th>{t("엔진")}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {analyses.map((analysis) => (
                      <tr
                        key={analysis.id}
                        className="openable-row"
                        onClick={() => {
                          setInitialResult(undefined);
                          setView(analysis.id);
                        }}
                      >
                        <td>
                          <span className="modality-label">{analysis.name}</span>
                        </td>
                        <td>
                          <strong>Thigh muscle estimation</strong>
                          <span>{analysis.protocol}</span>
                          <small>{t(analysis.input)}</small>
                        </td>
                        <td>{analysis.output}</td>
                        <td>
                          <span
                            className={
                              status[analysis.id]?.estimationAvailable
                                ? "status-ready"
                                : "status-review"
                            }
                          >
                            {status[analysis.id]?.estimationAvailable
                              ? t("연결됨")
                              : t("준비 필요")}
                          </span>
                          <small>{status[analysis.id]?.device || "—"}</small>
                        </td>
                        <td>
                          <button
                            className="clinical-button"
                            aria-label={t("{{value0}} 허벅지 근육 분석", { value0: analysis.name })}
                          >
                            {t("작업 열기")}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="catalog-section recent-section">
                <div className="panel-title">
                  <strong>{t("최근 분석")}</strong>
                  <span>{t("이 장치에 저장된 결과")}</span>
                </div>
                <table className="clinical-table">
                  <thead>
                    <tr>
                      <th>Case / Study</th>
                      <th>Modality</th>
                      <th>Series</th>
                      <th>{t("분석 일시")}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((result) => (
                      <tr
                        key={result.id}
                        className="openable-row"
                        onClick={() => {
                          setInitialResult(result.id);
                          setView(result.analysis);
                        }}
                      >
                        <td>
                          <strong>{result.metadata.caseName}</strong>
                          <small>{result.metadata.studyDescription || "—"}</small>
                        </td>
                        <td>{result.analysis.toUpperCase()}</td>
                        <td>{result.metadata.seriesDescription}</td>
                        <td>{new Date(result.createdAt).toLocaleString(localeTag())}</td>
                        <td>
                          <button
                            className="text-button"
                            aria-label={t("{{value0}} 결과 열기", {
                              value0: result.metadata.caseName,
                            })}
                          >
                            {t("결과 열기")}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!recent.length && (
                  <div className="clinical-empty">
                    <span>{t("저장된 분석 결과가 없습니다")}</span>
                  </div>
                )}
              </div>
              <footer className="catalog-footer">
                <span>{t("영상·Series 검토 → Segmentation → 측정·Overlay → 3D")}</span>
                <span>EXMO</span>
              </footer>
            </div>
          </section>
        )}
        {analyses.map((analysis) => (
          <div className="desktop-workspace" key={analysis.id} hidden={view !== analysis.id}>
            <ThighWorkspace
              analysis={analysis.id}
              name={analysis.name}
              visible={view === analysis.id}
              onBack={() => setView("home")}
              initialResult={initialResult}
            />
          </div>
        ))}
        {view === "demo" && (
          <Home onHome={() => setView("home")} headerAccessory={<LanguageSelect />} />
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Desktop />);
