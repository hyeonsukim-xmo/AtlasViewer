const { contextBridge, ipcRenderer } = require("electron");

// No arbitrary file access, IPC channel, command or native Electron object is exposed.
contextBridge.exposeInMainWorld(
  "exmoDesktop",
  Object.freeze({
    licenseStatus: () => ipcRenderer.invoke("exmo:license:status"),
    manageLicense: () => ipcRenderer.invoke("exmo:license:manage"),
    exportResults: (analysis, ids, language) => ipcRenderer.invoke("exmo:imaging:exportResults", analysis, ids, language),
    imageMenu: (payload) => ipcRenderer.invoke("exmo:imaging:imageMenu", payload),
    solutions: () => ipcRenderer.invoke("exmo:imaging:solutions"),
    status: (analysis) => ipcRenderer.invoke("exmo:imaging:status", analysis),
    onImportProgress: (callback) => {
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on("exmo:imaging:importProgress", listener);
      return () => ipcRenderer.removeListener("exmo:imaging:importProgress", listener);
    },
    list: (analysis) => ipcRenderer.invoke("exmo:imaging:list", analysis),
    results: (analysis) => ipcRenderer.invoke("exmo:imaging:results", analysis),
    chooseFiles: (analysis, folder, language) =>
      ipcRenderer.invoke("exmo:imaging:choose", analysis, folder, language),
    preview: (analysis, id, options) =>
      ipcRenderer.invoke("exmo:imaging:preview", analysis, id, options),
    resultPreview: (id, options) => ipcRenderer.invoke("exmo:imaging:resultPreview", id, options),
    sceneFailure: (id, code, reference) => ipcRenderer.invoke('exmo:imaging:sceneFailure', id, code, reference),
    run: (analysis, ids, confirmedIds, device) =>
      ipcRenderer.invoke("exmo:imaging:run", analysis, ids, confirmedIds, device),
    job: () => ipcRenderer.invoke("exmo:imaging:job"),
    assignXrayStudy: (ids, study) => ipcRenderer.invoke("exmo:imaging:assignXrayStudy", ids, study),
    assignPatientStudy: (analysis, ids, study) => ipcRenderer.invoke("exmo:imaging:assignPatientStudy", analysis, ids, study),
    variant: (id, variant) => ipcRenderer.invoke("exmo:imaging:variant", id, variant),
    cancel: (analysis) => ipcRenderer.invoke("exmo:imaging:cancel", analysis),
    clear: (analysis) => ipcRenderer.invoke("exmo:imaging:clear", analysis),
  }),
);
