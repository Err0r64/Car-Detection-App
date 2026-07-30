const { contextBridge, ipcRenderer } = require('electron');

// IPC surface for the renderer.
contextBridge.exposeInMainWorld('editorAPI', {
  // Project picker (landing screen)
  listProjects: () => ipcRenderer.invoke('list-projects'),
  getProjectsRoot: () => ipcRenderer.invoke('get-projects-root'),
  chooseProjectsRoot: () => ipcRenderer.invoke('choose-projects-root'),
  createProject: (projectName) => ipcRenderer.invoke('create-project', projectName),
  deleteProject: (projectPath) => ipcRenderer.invoke('delete-project', projectPath),

  // Editor
  openVideo: (projectPath) => ipcRenderer.invoke('open-video', projectPath),
  confirmUnsavedChanges: (videoName, destination) =>
    ipcRenderer.invoke('confirm-unsaved-changes', videoName, destination),
  startAnalysis: (videoPath) => ipcRenderer.invoke('start-analysis', videoPath),
  loadAnalysisResults: () => ipcRenderer.invoke('load-analysis-results'),
  discardAnalysisResults: () => ipcRenderer.invoke('discard-analysis-results'),
  cancelAnalysis: () => ipcRenderer.send('cancel-analysis'),
  chooseExportFolder: (suggestedPath) =>
    ipcRenderer.invoke('choose-export-folder', suggestedPath),
  exportClips: (request) => ipcRenderer.invoke('export-clips', request),
  cancelExport: () => ipcRenderer.send('cancel-export'),
  openExportFolder: (folderPath) => ipcRenderer.invoke('open-export-folder', folderPath),
  onExportEvent: (callback) => ipcRenderer.on('export-event', (e, data) => callback(data)),
  onAnalysisEvent: (callback) => ipcRenderer.on('analysis-event', (e, data) => callback(data)),
  saveProject: (request) => ipcRenderer.invoke('save-project', request),
  loadProject: () => ipcRenderer.invoke('load-project'),
});
