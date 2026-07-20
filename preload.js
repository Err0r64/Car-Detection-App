const { contextBridge, ipcRenderer } = require('electron');

// IPC surface for the renderer. Editor methods are stubbed to no-ops until
// their main-process handlers land in later checkpoints:
//   saveProject/loadProject -> CP5
contextBridge.exposeInMainWorld('editorAPI', {
  // Project picker (landing screen)
  listProjects: () => ipcRenderer.invoke('list-projects'),
  createProject: () => ipcRenderer.invoke('create-project'),
  deleteProject: (projectPath) => ipcRenderer.invoke('delete-project', projectPath),

  // Editor
  openVideo: () => ipcRenderer.invoke('open-video'),
  startAnalysis: (videoPath) => ipcRenderer.invoke('start-analysis', videoPath),
  cancelAnalysis: () => ipcRenderer.send('cancel-analysis'),
  onAnalysisEvent: (callback) => ipcRenderer.on('analysis-event', (e, data) => callback(data)),
  saveProject: async (projectObj) => null,
  loadProject: async () => null,
});
