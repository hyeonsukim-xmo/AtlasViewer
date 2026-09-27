const { app, BrowserWindow, dialog, Menu, net, protocol, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { installImaging } = require("./imaging.cjs");

const origin = "atlas://app/";
const contentRoot = path.join(__dirname, "..", "dist-desktop");
const bundled = path.extname(path.dirname(__dirname)) === ".asar";
const scriptsRoot = bundled ? path.resolve(__dirname, "../..", "imaging") : __dirname;
let desktopImaging;
const preferences = { nodeIntegration: false, contextIsolation: true, sandbox: true };
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

app.setName("EXMO Atlas");
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

function createWindow() {
  const window = new BrowserWindow({
    title: "EXMO Atlas",
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
      process.env.EXMO_ENGINE_ROOT ||
      configuredRoot ||
      path.join(__dirname, "..", "work", "modality-integration"),
    storageRoot: path.join(app.getPath("userData"), "imaging"),
    scriptsRoot,
    palette: path.join(bundled ? scriptsRoot : contentRoot, "imaging-palette.json"),
  });
  const imaging = desktopImaging;
  window.once("closed", () => {
    imaging.dispose().catch(() => {});
  });
  window.once("ready-to-show", () => window.show());
  window.loadURL(origin + (process.argv.includes("--xray") ? "#xray" : "")).catch((error) => {
    dialog.showErrorBox("EXMO Atlas could not start", error.message);
    app.quit();
  });
}

app
  .whenReady()
  .then(() => {
    if (!primaryInstance) return;
    app.setAppUserModelId("com.exmo.atlas");
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
        const model = /^\/result\/([a-f0-9-]{36})\.glb$/.exec(pathname);
        const modelPath = model ? desktopImaging?.mesh(model[1]) : null;
        if (model && !modelPath) return new Response(null, { status: 404 });
        const file =
          modelPath ||
          path.resolve(contentRoot, "." + (pathname === "/" ? "/index.html" : pathname));
        const relative = path.relative(contentRoot, file);
        if (!modelPath && (relative.startsWith("..") || path.isAbsolute(relative)))
          return new Response(null, { status: 403 });
        const response = await net.fetch(pathToFileURL(file).href);
        const headers = new Headers(response.headers);
        headers.set("Content-Security-Policy", csp);
        headers.set("X-Content-Type-Options", "nosniff");
        if (pathname.endsWith(".md")) headers.set("Content-Type", "text/plain; charset=utf-8");
        return new Response(response.body, { status: response.status, headers });
      } catch {
        return new Response("File not found", { status: 404 });
      }
    });
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((error) => {
    dialog.showErrorBox("EXMO Atlas could not start", error.message);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (!desktopImaging) return;
  event.preventDefault();
  const imaging = desktopImaging;
  desktopImaging = undefined;
  imaging
    .dispose()
    .catch(() => {})
    .finally(() => app.quit());
});
