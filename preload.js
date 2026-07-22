const { contextBridge, ipcRenderer } = require('electron');

// IPC surface for the renderer.
contextBridge.exposeInMainWorld('editorAPI', {
  // Project picker (landing screen)
  listProjects: () => ipcRenderer.invoke('list-projects'),
  createProject: () => ipcRenderer.invoke('create-project'),
  deleteProject: (projectPath) => ipcRenderer.invoke('delete-project', projectPath),

  // Editor
  openVideo: () => ipcRenderer.invoke('open-video'),
  confirmUnsavedChanges: (videoName, destination) =>
    ipcRenderer.invoke('confirm-unsaved-changes', videoName, destination),
  startAnalysis: (videoPath) => ipcRenderer.invoke('start-analysis', videoPath),
  cancelAnalysis: () => ipcRenderer.send('cancel-analysis'),
  onAnalysisEvent: (callback) => ipcRenderer.on('analysis-event', (e, data) => callback(data)),
  saveProject: (request) => ipcRenderer.invoke('save-project', request),
  loadProject: () => ipcRenderer.invoke('load-project'),
});
