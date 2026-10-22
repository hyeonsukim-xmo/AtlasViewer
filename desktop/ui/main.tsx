import Publication from './publication';
import { t, useLanguage, localeTag } from "./language";
import {failureText} from "./diagnostics";
import LanguageSelect from "./language-select";
import LicenseStatusButton from "./license-status";
import Account from './account';
import InstallationManager, {installationLabel} from './installation-manager';
import RemoteResults from './remote-results';
import {useAccountState} from './account-state';
import {solutionAction} from './solution-readiness';
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import Home from "../../app/page";
import ThighWorkspace from "./thigh-workspace";
import { unwrap, type AnalysisResult, type ModelStatus, type Solution, type LicenseStatus } from "./imaging";
import "../../app/globals.css";
import "./workspace.css";
import { groupXrays, studyIdentity, xrayView, viewLabel } from "./xray-studies";

function Desktop() {
  const language = useLanguage();
  const account=useAccountState();
  const [accountRequest,setAccountRequest]=useState(0),[installRequest,setInstallRequest]=useState(0),[license,setLicense]=useState<LicenseStatus>();
  useEffect(()=>{let alive=true;const update=()=>void window.exmoDesktop.licenseStatus().then(value=>{if(alive)setLicense(value);}).catch(()=>{});update();const timer=setInterval(update,5000);return()=>{alive=false;clearInterval(timer);};},[]);
  function permission(id:string){
    if(!license)return t('상태 확인 중');
    if(license.profile==='development')return t('개발 환경');
    const grant=license.solutions?.find(s=>s.solutionId===id);
    if(license.solutions && !grant)return t('권한 없음');
    if(grant?.state==='expired')return t('기간 만료');
    if(grant && grant.state!=='active')return t('사용 중지');
    return ['VALID','GRACE'].includes(license.state)?t('사용 허용'):t('장비 인증 필요');
  }
  function enter(analysis:Solution){
    const action=solutionAction(analysis.id,license,status[analysis.id]);
    if(action==='checking')return;
    if(action==='install'){setInstallRequest(n=>n+1);return;}
    if(action==='license'){void window.exmoDesktop.manageLicense().then(setLicense);return;}
    setInitialResult(undefined);setView(analysis.id);
  }
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  const [view, setView] = useState<string>(
    location.hash === "#xray" ? "exmo.lower-extremity.xray" : "home",
  );
  const [analyses, setAnalyses] = useState<Solution[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [status, setStatus] = useState<Record<string, ModelStatus>>({});
  const [solutionErrors, setSolutionErrors] = useState<Record<string, string>>({});
  const [installationRevision,setInstallationRevision]=useState(0);
  useEffect(()=>{
    let previous='';
    return window.exmoDesktop.onInstallationsChanged?.(value=>{
      const signature=JSON.stringify(value.solutions.map(s=>[s.analysis,s.installed,s.state,s.version]));
      if(signature!==previous){previous=signature;setInstallationRevision(n=>n+1);}
    });
  },[]);
  useEffect(() => {
    let stale = false;
    window.exmoDesktop.solutions().then(unwrap).then(values => {if (!stale) setAnalyses(values);})
      .catch(error => {if (!stale) setCatalogError(failureText(error));});
    return () => {stale = true;};
  }, []);
  const [recent, setRecent] = useState<AnalysisResult[]>([]);
  const [initialResult, setInitialResult] = useState<string>();
  useEffect(() => {
    if (view !== "home") return;
    let stale = false;
    void Promise.all(analyses.map(async ({id}) => {
      const [state, saved] = await Promise.allSettled([
        window.exmoDesktop.status(id).then(unwrap), window.exmoDesktop.results(id).then(unwrap),
      ]);
      return {id, status:state.status === 'fulfilled' ? state.value : undefined,
        results:saved.status === 'fulfilled' ? saved.value : [],
        error:[state,saved].filter(item => item.status === 'rejected')
          .map(item => failureText((item as PromiseRejectedResult).reason)).join('\n')};
    })).then(values => {
      if (stale) return;
      setStatus(Object.fromEntries(values.filter(value => value.status).map(value => [value.id,value.status!])));
      setSolutionErrors(Object.fromEntries(values.map(value => [value.id,value.error])));
      setRecent(values.flatMap(value => value.results).sort((a,b) => b.createdAt.localeCompare(a.createdAt)));
    });
    return () => {
      stale = true;
    };
  }, [view, analyses, installationRevision]);
  const recentStudies = [
    ...recent.filter(result => result.analysis !== "xray").map(result => ({ key: result.id, items: [result] })),
    ...groupXrays(recent.filter(result => result.analysis === "xray")),
  ].sort((a, b) => {
    const latest = (items: AnalysisResult[]) => items.reduce((date, item) => item.createdAt > date ? item.createdAt : date, "");
    return latest(b.items).localeCompare(latest(a.items));
  }).slice(0, 8);
  return (
    <div className="desktop-shell dark">
      {view !== "demo" && (
        <nav className="desktop-nav" aria-label="Desktop navigation">
          <div className="desktop-nav-brand">
            <button
              className="desktop-brand"
              aria-label={t("분석 선택으로")}
              onClick={() => setView("home")}
            >
              <img src="/brand/exmo-logo-white.svg" alt="EXMO" />
            </button>
            <span className="desktop-nav-label">Atlas Viewer</span>
          </div>
          <div className="desktop-nav-primary">
            <button data-view="home" aria-current={view!=='server'?'page':undefined} onClick={()=>setView('home')}>{t('분석 작업')}</button>
            <button data-view="server" aria-current={view==='server'?'page':undefined} onClick={()=>setView('server')}>{t('서버 결과')}</button>
            <button data-view="demo" onClick={()=>setView('demo')}>{t('3D 데모')}</button>
          </div>
          <div className="desktop-nav-tools">
            <InstallationManager openRequest={installRequest}/>
            <Publication />
          </div>
          <div className="desktop-nav-user">
            <LicenseStatusButton />
            <Account openRequest={accountRequest}/>
            <LanguageSelect />
          </div>
        </nav>
      )}
      <main className="desktop-content">
        {catalogError && <p className="inline-error" role="alert">{catalogError}</p>}
        {view === "home" && (
          <section className="analysis-catalog" aria-label={t("분석 선택")}>
            <div className="analysis-catalog-inner">
              <header className="catalog-heading">
                <div>
                  <h1>{t("분석 작업")}</h1>
                  <p>{t("허벅지 근육 분석")}</p>
                </div>
                <button className="text-button" onClick={()=>setInstallationRevision(n=>n+1)}>{t('새로고침')}</button>
              </header>
              {account?.state==='signed-in' && <p className="catalog-account">{account.me?.name} · {account.workspace?.orgId||t('작업공간 선택')}
                <button className="text-button" onClick={()=>setAccountRequest(n=>n+1)}>{t('계정·작업공간')}</button>
              </p>}
              {license && license.profile!=='development' && !['VALID','GRACE'].includes(license.state) && <p className="metric-note">{t('신규 분석은 장비 승인이 필요합니다. 기존 결과는 아래 목록에서 열 수 있습니다.')} <button className="text-button" onClick={()=>setAccountRequest(n=>n+1)}>{t('초기 설정')}</button></p>}
              <div className="catalog-section">
                <div className="panel-title">
                  <strong>{t("분석 선택")}</strong>
                </div>
                <table className="clinical-table protocol-table">
                  <thead>
                    <tr>
                      <th>Modality</th>
                      <th>{t("입력 영상")}</th>
                      <th>{t("결과")}</th>
                      <th>{t("상태")}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {analyses.filter(a=>!license?.solutions || license.solutions.some(s=>s.solutionId===a.id)).toSorted((a,b)=>Number(license?.solutions?.find(s=>s.solutionId===b.id)?.state==='active')-Number(license?.solutions?.find(s=>s.solutionId===a.id)?.state==='active')).map((analysis) => (
                      <tr
                        key={analysis.id}
                        className="openable-row"
                        tabIndex={0}
                        onClick={() => enter(analysis)}
                        onKeyDown={e=>{if(e.target===e.currentTarget && ['Enter',' '].includes(e.key)){e.preventDefault();enter(analysis);}}}
                      >
                        <td>
                          <span className="modality-label">{analysis.name}</span>
                        </td>
                        <td>
                          <strong>{analysis.protocol}</strong>
                          <small>{t(analysis.input)} / ZIP</small>
                        </td>
                        <td>{analysis.analysis==='ct'?t('근육 체적 · HU 기반 지방 범위 · 3D'):analysis.analysis==='mri'?t('근육 체적 · QC · 3D'):t('근육 투영 면적 · Overlay')}</td>
                        <td>
                          <span
                            className={
                              solutionAction(analysis.id,license,status[analysis.id])==='open' && status[analysis.id]?.estimationAvailable
                                ? "status-ready"
                                : "status-review"
                            }
                          >
                            {solutionAction(analysis.id,license,status[analysis.id])==='open'?(status[analysis.id]?.estimationAvailable?t('분석 가능'):t('준비 필요')):
                              solutionAction(analysis.id,license,status[analysis.id])==='license'?permission(analysis.id):
                              status[analysis.id]?.installation?installationLabel(status[analysis.id]?.installation):t('상태 확인 중')}
                          </span>
                          {solutionErrors[analysis.id] && <small className="inline-error" role="alert">{solutionErrors[analysis.id]}</small>}
                        </td>
                        <td>
                          <button
                            className="clinical-button"
                            disabled={solutionAction(analysis.id,license,status[analysis.id])==='checking'}
                            aria-label={t("{{value0}} 허벅지 근육 분석", { value0: analysis.name })}
                          >
                            {solutionAction(analysis.id,license,status[analysis.id])==='checking'?t('상태 확인 중'):solutionAction(analysis.id,license,status[analysis.id])==='install'?t('설치 확인'):solutionAction(analysis.id,license,status[analysis.id])==='license'?t('사용권 확인'):t('작업 열기')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {license?.solutions?.length===0 && <div className="clinical-empty"><p>{t('승인된 솔루션이 없습니다. EXMO 운영 관리자에게 사용권을 요청하세요.')}</p><button className="clinical-button" onClick={()=>setAccountRequest(n=>n+1)}>{t('계정·장비 등록')}</button></div>}
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
                    {recentStudies.map((group) => {
                      const result = group.items[0];
                      return (
                      <tr
                        key={group.key}
                        className="openable-row"
                        tabIndex={0}
                        onKeyDown={e=>{if(e.target===e.currentTarget && ['Enter',' '].includes(e.key)){e.preventDefault();e.currentTarget.click();}}}
                        onClick={() => {
                          setInitialResult(result.id);
                          setView(result.solutionId || analyses.find(item => item.analysis === result.analysis)!.id);
                        }}
                      >
                        <td>
                          <strong>{studyIdentity(result.metadata)?.patientId || result.metadata.caseName}</strong>
                          {result.analysis === "xray" && <small>{studyIdentity(result.metadata)?.studyDate}</small>}
                          <small>{result.metadata.studyDescription || "—"}</small>
                        </td>
                        <td>{result.analysis.toUpperCase()}</td>
                        <td>{result.analysis === "xray" ? [...new Set(group.items.map(item => xrayView(item)).filter(view => view != null).map(viewLabel))].join(" / ") : result.metadata.seriesDescription}</td>
                        <td>{new Date(group.items.reduce((date, item) => item.createdAt > date ? item.createdAt : date, "")).toLocaleString(localeTag())}</td>
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
                    );})}
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
        {view==='server' && <RemoteResults local={recent} onAccount={()=>setAccountRequest(n=>n+1)} onHome={()=>setView('home')}/>}
        {analyses.map((analysis) => (
          <div className="desktop-workspace" key={analysis.id} hidden={view !== analysis.id}>
            <ThighWorkspace
              analysis={analysis.analysis}
              solutionId={analysis.id}
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
