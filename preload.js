const { contextBridge, ipcRenderer } = require('electron');

// IPC surface for the renderer. Editor methods are stubbed to no-ops until
// their main-process handlers land in later checkpoints:
//   openVideo            -> CP3
//   startAnalysis/cancelAnalysis/onAnalysisEvent -> CP4
//   saveProject/loadProject -> CP5
contextBridge.exposeInMainWorld('editorAPI', {
  // Project picker (landing screen)
  listProjects: () => ipcRenderer.invoke('list-projects'),
  createProject: () => ipcRenderer.invoke('create-project'),
  deleteProject: (projectPath) => ipcRenderer.invoke('delete-project', projectPath),

  // Editor
  openVideo: () => ipcRenderer.invoke('open-video'),
  startAnalysis: (videoPath) => {},
  cancelAnalysis: () => {},
  onAnalysisEvent: (callback) => {},
  saveProject: async (projectObj) => null,
  loadProject: async () => null,
});
