const { app, BrowserWindow, dialog, Menu, net, protocol, session } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const origin = "atlas://app/";
const contentRoot = path.join(__dirname, "..", "dist");
const preferences = { nodeIntegration: false, contextIsolation: true, sandbox: true };
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

app.setName("EXMO Atlas");
protocol.registerSchemesAsPrivileged([
  { scheme: "atlas", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

app.on("web-contents-created", (_, contents) => {
  contents.on("will-navigate", (event, url) => {
    if (!url.startsWith(origin)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) =>
    url === origin + "ATTRIBUTION.md"
      ? { action: "allow", overrideBrowserWindowOptions: { width: 850, height: 650, autoHideMenuBar: true, webPreferences: preferences } }
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
    webPreferences: { ...preferences, backgroundThrottling: true },
  });
  window.once("ready-to-show", () => window.show());
  window.loadURL(origin).catch((error) => {
    dialog.showErrorBox("EXMO Atlas could not start", error.message);
    app.quit();
  });
}

app.whenReady().then(() => {
  app.setAppUserModelId("com.exmo.atlas");
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_, __, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle("atlas", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== "app" || request.method !== "GET") return new Response(null, { status: 403 });
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes("\\") || pathname.includes(":")) return new Response(null, { status: 403 });
      const file = path.resolve(contentRoot, "." + (pathname === "/" ? "/index.html" : pathname));
      const relative = path.relative(contentRoot, file);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return new Response(null, { status: 403 });
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
}).catch((error) => {
  dialog.showErrorBox("EXMO Atlas could not start", error.message);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
