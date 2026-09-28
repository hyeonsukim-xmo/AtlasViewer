const { contextBridge, ipcRenderer } = require("electron");

// No arbitrary file access, IPC channel, command or native Electron object is exposed.
contextBridge.exposeInMainWorld(
  "exmoDesktop",
  Object.freeze({
    status: (analysis) => ipcRenderer.invoke("exmo:imaging:status", analysis),
    list: (analysis) => ipcRenderer.invoke("exmo:imaging:list", analysis),
    results: (analysis) => ipcRenderer.invoke("exmo:imaging:results", analysis),
    chooseFiles: (analysis, folder, language) =>
      ipcRenderer.invoke("exmo:imaging:choose", analysis, folder, language),
    preview: (analysis, id, options) =>
      ipcRenderer.invoke("exmo:imaging:preview", analysis, id, options),
    resultPreview: (id, options) => ipcRenderer.invoke("exmo:imaging:resultPreview", id, options),
    run: (analysis, ids, confirmedIds, device) =>
      ipcRenderer.invoke("exmo:imaging:run", analysis, ids, confirmedIds, device),
    job: () => ipcRenderer.invoke("exmo:imaging:job"),
    variant: (id, variant) => ipcRenderer.invoke("exmo:imaging:variant", id, variant),
    cancel: (analysis) => ipcRenderer.invoke("exmo:imaging:cancel", analysis),
    clear: (analysis) => ipcRenderer.invoke("exmo:imaging:clear", analysis),
  }),
);
