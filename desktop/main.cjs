const startupStarted=performance.now(),startupTimings={};
const { app, BrowserWindow, dialog, Menu, net, protocol, session, ipcMain, safeStorage, powerMonitor, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { resultModelResponse } = require('./result-model-response.cjs');
const { pathToFileURL } = require("node:url");
const { installImaging } = require("./imaging.cjs");
const { loadBuild, openLicensing } = require("./security/runtime.cjs");
const { WindowsKey } = require("./security/windows-key.cjs");
const { openResultStorage } = require('./security/result-storage.cjs');
const { installLicenseUi } = require("./security/ui.cjs");

const origin = "atlas://app/";
const contentRoot = path.join(__dirname, "..", "dist-desktop");
const bundled = path.extname(path.dirname(__dirname)) === ".asar";
const scriptsRoot = bundled ? path.resolve(__dirname, "../..", "imaging") : __dirname;
const securityBuild = loadBuild(app.isPackaged || bundled);
const internalBuild = securityBuild.profile === "internal";
const applicationName = internalBuild ? "EXMO Atlas Internal" : "EXMO Atlas";
let desktopImaging;
let publicationSync;
let licensing;
let remoteResults;
let resultStorage;
let protectedEngineRoot;
let installations;
let initializing = true;
let startupRecorded = false;
const preferences = { nodeIntegration: false, contextIsolation: true, sandbox: true };
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

app.setName(applicationName);
// Internal installations have their own store and cannot overwrite customer/source results.
if (internalBuild) app.setPath("userData", path.join(app.getPath("appData"), applicationName));
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on("second-instance", () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});
protocol.registerSchemesAsPrivileged([
  {
    scheme: "atlas",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

app.on("web-contents-created", (_, contents) => {
  contents.on("will-navigate", (event, url) => {
    if (!url.startsWith(origin)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) =>
    url === origin + "ATTRIBUTION.md"
      ? {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: 850,
            height: 650,
            autoHideMenuBar: true,
            webPreferences: preferences,
          },
        }
      : { action: "deny" },
  );
});

function recordStartup(status) {
  if(startupRecorded)return;
  startupRecorded=true;
  try {
    fs.mkdirSync(app.getPath('userData'),{recursive:true});
    require('./security/storage.cjs').atomicWrite(path.join(app.getPath('userData'),'startup-performance.json'),JSON.stringify({
      schema:'exmo-startup-performance-v1',at:new Date().toISOString(),appVersion:require('../package.json').version,profile:securityBuild.profile,
      status,totalMs:performance.now()-startupStarted,timings:startupTimings,
    },null,2));
  }catch{} // Diagnostics must not make otherwise readable results unavailable.
}

function createWindow() {
  const rendererStarted=performance.now();
  const window = new BrowserWindow({
    title: applicationName,
    width: 1440,
    height: 960,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#08081a",
    icon: path.join(__dirname, "icon.png"),
    show: false,
    webPreferences: {
      ...preferences,
      preload: path.join(__dirname, "preload.cjs"),
      backgroundThrottling: true,
    },
  });
  let configuredRoot;
  try {
    configuredRoot = JSON.parse(
      fs.readFileSync(path.join(app.getPath("userData"), "engine.json"), "utf8"),
    ).root;
  } catch {}
  desktopImaging = installImaging(window, {
    engineRoot:
      protectedEngineRoot || process.env.EXMO_ENGINE_ROOT ||
      configuredRoot ||
      path.join(__dirname, "..", "work", "modality-integration"),
    storageRoot: path.join(app.getPath("userData"), "imaging"),
    scriptsRoot,
    palette: path.join(bundled ? scriptsRoot : contentRoot, "imaging-palette.json"),
    analysisAuthorization: licensing,
    originStoreId: resultStorage?.id(),
    artifactStorage: resultStorage?.bootstrap(path.join(app.getPath('userData'), 'imaging', 'runs')),
    installations,
  });
  const removeLicenseUi = installLicenseUi({ ipcMain, dialog, window, licensing, profile: securityBuild.profile, restart:()=>{app.relaunch();app.quit();} });
  const removeInstallationUi=require('./security/installations-ui.cjs').installInstallationUi({ipcMain,dialog,window,installations,licensing,logRoot:path.join(app.getPath('userData'),'imaging')});
  const account=require('./security/account.cjs').openAccount({config:securityBuild.account,directory:path.join(app.getPath('userData'),'account'),safeStorage,
    openExternal:url=>shell.openExternal(url),licensing,allowLoopback:securityBuild.allowLoopback===true});
  const removeAccountUi=require('./security/account-ui.cjs').installAccountUi({ipcMain,window,account});
  const imaging = desktopImaging;
  const sync=publicationSync=require('./sync.cjs').openSync({directory:path.join(app.getPath('userData'),'publication-outbox'),safeStorage,account,imaging});
  const removeSyncUi=require('./sync-ui.cjs').installSyncUi({ipcMain,window,sync});
  remoteResults=require('./remote-results.cjs').openRemote({account});
  const removeRemoteUi=require('./remote-results.cjs').installRemoteUi({ipcMain,window,remote:remoteResults});
  window.once("closed", () => {
    removeLicenseUi();
    removeInstallationUi();
    removeAccountUi();
    removeRemoteUi();
    void removeSyncUi().finally(()=>imaging.dispose()).catch(()=>{});
  });
  window.once("ready-to-show", () => {
    window.show();
    startupTimings.rendererMs=performance.now()-rendererStarted;
    recordStartup('ready');
  });
  window.loadURL(origin + (process.argv.includes("--xray") ? "#xray" : "")).catch((error) => {
    recordStartup('failed');
    dialog.showErrorBox("EXMO Atlas could not start", error.message);
    app.quit();
  });
}

app
  .whenReady()
  .then(async () => {
    if (!primaryInstance) return;
    startupTimings.electronReadyMs=performance.now()-startupStarted;
    app.setAppUserModelId(internalBuild ? "com.exmo.atlas.internal" : "com.exmo.atlas");
    if (securityBuild.profile !== "development") {
      let phaseStarted=performance.now();
      const hashes=JSON.parse(fs.readFileSync(path.join(__dirname,'security/runtime-integrity.json'),'utf8'));
      const resources=path.resolve(scriptsRoot,'..');
      const {hashFile,inventory}=require('./security/payload.cjs');
      for(const [relative,expected] of Object.entries(hashes)) {
        require('./security/payload.cjs').safeName(relative);
        if(hashFile(path.join(resources,relative)).sha256!==expected)throw Error('분석 실행 파일이 변경되었습니다. 설치본을 복구하세요.');
      }
      for(const relative of inventory(scriptsRoot))if(/\.(py|pyc|pyd|dll)$/i.test(relative) && !hashes['imaging/'+relative])throw Error('승인되지 않은 분석 실행 파일이 있습니다.');
      startupTimings.helperIntegrityMs=performance.now()-phaseStarted;
      const payload=path.resolve(scriptsRoot,'../engine');
      let selectedContext;
      const selected=fs.existsSync(path.join(payload,'catalog.json'));
      const progress=(selected || securityBuild.profile==='customer' || fs.existsSync(path.join(payload,'payload.json')))?new BrowserWindow({width:440,height:160,resizable:false,closable:false,autoHideMenuBar:true,backgroundColor:'#100e26',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}):null;
      if(progress)await progress.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{background:#100e26;color:#e9e6f4;font:14px system-ui;margin:28px}p{color:#a7a2bb;font-size:12px}progress{width:100%;accent-color:#aaa0c7}</style><b>분석 실행 환경 확인</b><p>'+(selected?'공용 Viewer를 준비하고 설치 파일을 확인하고 있습니다.':'설치 파일과 모델의 무결성을 확인하고 있습니다.')+'</p><progress max="100"></progress>'));
      const updateProgress=(done,total)=>{if(progress && !progress.isDestroyed() && total)void progress.webContents.executeJavaScript('document.querySelector("progress").value='+Math.round(done/total*100)).catch(()=>{});};
      phaseStarted=performance.now();
      try{
      if(fs.existsSync(path.join(payload,'catalog.json'))){
        if(securityBuild.licenseVersion!==3)throw Error('선택 설치에는 v3 빌드가 필요합니다.');
        const issuer=require('node:crypto').createPublicKey(securityBuild.issuerPublicKey);
        installations=require('./security/installations.cjs').openInstallations({root:path.join(app.getPath('userData'),'runtime-store'),issuer,profile:securityBuild.profile,
          onChange:value=>{updateProgress(value.reader?.completed,value.reader?.total);for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send('exmo:installations:changed',value);}});
        await installations.recover();
        if(!installations.reader())await installations.install(payload,[],null,{commonOnly:true});
        let reader;
        try{reader=await installations.acquire('reader');}
        catch{
          // Restore a verified common reader so damaged runtime files cannot lock out repair UI.
          await installations.install(payload,[],null,{commonOnly:true});
          reader=await installations.acquire('reader');
        }
        selectedContext=reader;protectedEngineRoot=reader.engineRoot;
        startupTimings.readerMs=performance.now()-phaseStarted;
      }else if(securityBuild.profile==='customer' || fs.existsSync(path.join(payload,'payload.json'))) {
        const crypto=require('node:crypto');
        const payloadTimings=startupTimings.payload={};
        const policy=await require('./security/payload.cjs').verifyPayloadAsync(payload,crypto.createPublicKey(securityBuild.issuerPublicKey),updateProgress,payloadTimings);
        if(policy.profile!==securityBuild.profile)throw Error('분석 엔진의 제품 프로필이 일치하지 않습니다.');
        protectedEngineRoot=payload;
      }
      }finally{if(progress && !progress.isDestroyed())progress.destroy();}
      phaseStarted=performance.now();
      resultStorage = openResultStorage(path.join(app.getPath('userData'), 'result-security'), safeStorage);
      startupTimings.resultStorageMs=performance.now()-phaseStarted;phaseStarted=performance.now();
      licensing = await openLicensing({ build: securityBuild, directory: path.join(app.getPath("userData"), "licensing"), safeStorage,
        resultStorage,engineRoot:protectedEngineRoot,scriptsRoot:selectedContext?.scriptsRoot??scriptsRoot,
        dongle:securityBuild.profile==='customer'?new (require('./security/dongle.cjs').Dongle)(
          path.join(protectedEngineRoot,'python','python.exe'),path.join(selectedContext?.scriptsRoot??scriptsRoot,'piv_worker.py'),
          [path.join(selectedContext?.scriptsRoot??scriptsRoot,'runtime_bootstrap.py'),'--site',path.join(protectedEngineRoot,'envs/security/Lib/site-packages'),'--']):undefined,
        key: new WindowsKey(bundled ? path.resolve(__dirname, "../..", "security", "windows-key.ps1") : undefined) });
      startupTimings.licensingMs=performance.now()-phaseStarted;
      powerMonitor.on("resume", () => licensing.refresh().catch(() => {}));
    }
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_, __, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    protocol.handle("atlas", async (request) => {
      try {
        const url = new URL(request.url);
        if (url.host !== "app" || request.method !== "GET")
          return new Response(null, { status: 403 });
        const pathname = decodeURIComponent(url.pathname);
        if (pathname.includes("\\") || pathname.includes(":"))
          return new Response(null, { status: 403 });
        const remote=/^\/remote\/([a-f0-9-]{36})\.glb$/.exec(pathname);
        if(remote)return await remoteResults.model(remote[1]);
        const model = /^\/result\/([a-f0-9-]{36})\.glb$/.exec(pathname);
        const modelPath = model ? desktopImaging?.mesh(model[1]) : null;
        const file =
          modelPath ||
          path.resolve(contentRoot, "." + (pathname === "/" ? "/index.html" : pathname));
        const relative = path.relative(contentRoot, file);
        if (!modelPath && (relative.startsWith("..") || path.isAbsolute(relative)))
          return new Response(null, { status: 403 });
        // Registered result paths use Node streams, including long Windows paths.
        const response = model
          ? resultModelResponse(modelPath, path.join(app.getPath('userData'), 'imaging'), model[1])
          : await net.fetch(pathToFileURL(file).href);
        const headers = new Headers(response.headers);
        headers.set("Content-Security-Policy", csp);
        headers.set("X-Content-Type-Options", "nosniff");
        if (pathname.endsWith(".md")) headers.set("Content-Type", "text/plain; charset=utf-8");
        return new Response(response.body, { status: response.status, headers });
      } catch {
        return new Response("File not found", { status: 404 });
      }
    });
    initializing = false;
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((error) => {
    recordStartup('failed');
    dialog.showErrorBox("EXMO Atlas could not start", error.message);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !initializing) app.quit();
});

app.on("before-quit", (event) => {
  if (!desktopImaging) { licensing?.close(); installations?.close(); return; }
  event.preventDefault();
  const imaging = desktopImaging;
  const sync=publicationSync;
  publicationSync=undefined;
  desktopImaging = undefined;
  Promise.resolve(sync?.close())
    .then(()=>imaging.dispose())
    .catch(() => {})
    .finally(() => app.quit());
});
