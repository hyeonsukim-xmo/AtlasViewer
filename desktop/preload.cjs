const { contextBridge, ipcRenderer } = require("electron");

// No arbitrary file access, IPC channel, command or native Electron object is exposed.
contextBridge.exposeInMainWorld(
  "exmoDesktop",
  Object.freeze({
    remoteList:()=>ipcRenderer.invoke('exmo:remote:list'),
    remoteRead:(ids,loadMesh)=>ipcRenderer.invoke('exmo:remote:read',ids,loadMesh),
    remoteClose:()=>ipcRenderer.invoke('exmo:remote:close'),
    onAccountChanged:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('exmo:account:changed',listener);return ()=>ipcRenderer.removeListener('exmo:account:changed',listener);},
    syncStatus: () => ipcRenderer.invoke('exmo:sync:status'),
    syncEnqueue: refs => ipcRenderer.invoke('exmo:sync:enqueue',refs),
    syncRetry: id => ipcRenderer.invoke('exmo:sync:retry',id),
    syncCancel: id => ipcRenderer.invoke('exmo:sync:cancel',id),
    syncApproveOrigin: ref => ipcRenderer.invoke('exmo:sync:approve-origin',ref),
    overlayCreate:(ref,options)=>ipcRenderer.invoke('exmo:sync:overlay-create',ref,options),
    overlayRedact:(id,rects)=>ipcRenderer.invoke('exmo:sync:overlay-redact',id,rects),
    overlayApprove:(id,hash)=>ipcRenderer.invoke('exmo:sync:overlay-approve',id,hash),
    overlayDiscard:id=>ipcRenderer.invoke('exmo:sync:overlay-discard',id),
    accountStatus: () => ipcRenderer.invoke('exmo:account:status'),
    accountLogin: () => ipcRenderer.invoke('exmo:account:login'),
    accountLogout: () => ipcRenderer.invoke('exmo:account:logout'),
    accountRefresh: () => ipcRenderer.invoke('exmo:account:refresh'),
    accountWorkspace: (org,id) => ipcRenderer.invoke('exmo:account:workspace',org,id),
    accountEnroll: () => ipcRenderer.invoke('exmo:account:enroll'),
    accountEnrollments: () => ipcRenderer.invoke('exmo:account:enrollments'),
    accountDecide: (id,revision,policy,decision) => ipcRenderer.invoke('exmo:account:decide',id,revision,policy,decision),
    accountActivate: id => ipcRenderer.invoke('exmo:account:activate',id),
    accountSolution: (id,revision,solutionId,state) => ipcRenderer.invoke('exmo:account:solution',id,revision,solutionId,state),
    licenseStatus: () => ipcRenderer.invoke("exmo:license:status"),
    manageLicense: () => ipcRenderer.invoke("exmo:license:manage"),
    installations: () => ipcRenderer.invoke('exmo:installations:status'),
    chooseInstallation: () => ipcRenderer.invoke('exmo:installations:choose'),
    installSolutions: (id, analyses) => ipcRenderer.invoke('exmo:installations:install',id,analyses),
    removeSolution: (analysis) => ipcRenderer.invoke('exmo:installations:remove',analysis),
    rollbackSolution: (analysis) => ipcRenderer.invoke('exmo:installations:rollback',analysis),
    onInstallationsChanged: (callback) => {
      const listener=(_event,value)=>callback(value);ipcRenderer.on('exmo:installations:changed',listener);
      return ()=>ipcRenderer.removeListener('exmo:installations:changed',listener);
    },
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
