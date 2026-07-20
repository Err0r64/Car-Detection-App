const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

// --- Project registry (userData/projects.json): [{ name, path }] ---

function registryPath() {
  return path.join(app.getPath('userData'), 'projects.json');
}

function readRegistry() {
  try {
    const projects = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    return Array.isArray(projects) ? projects : [];
  } catch {
    return [];
  }
}

function writeRegistry(projects) {
  fs.writeFileSync(registryPath(), JSON.stringify(projects, null, 2));
}

// --- IPC handlers ---

ipcMain.handle('list-projects', () => readRegistry());

ipcMain.handle('create-project', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Select Project Directory',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const dir = result.filePaths[0];
  const projects = readRegistry();
  const existing = projects.find((p) => p.path === dir);
  if (existing) return existing;

  const project = { name: path.basename(dir), path: dir };
  projects.push(project);
  writeRegistry(projects);
  return project;
});

ipcMain.handle('delete-project', async (event, projectPath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const projects = readRegistry();
  const project = projects.find((p) => p.path === projectPath);
  if (!project) return false;

  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Remove Project',
    message: `Remove "${project.name}" from the project list?`,
    detail: 'This only removes the project from the list on the landing screen. The folder and its files stay on disk, and you can re-add it later via New Project.',
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return false;

  writeRegistry(projects.filter((p) => p.path !== projectPath));
  return true;
});

ipcMain.handle('open-video', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Open Video',
    properties: ['openFile'],
    filters: [{ name: 'Videos', extensions: ['mp4', 'mov'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  // url: file:// form usable as a <video> src. Built here because neither the
  // renderer nor the sandboxed preload has access to pathToFileURL.
  return { path: filePath, name: path.basename(filePath), url: pathToFileURL(filePath).href };
});

// --- Stubbed analysis pipeline ---

let analysisChild = null;
let analysisCanceled = false;

function killAnalysis() {
  if (analysisChild) {
    analysisCanceled = true;
    analysisChild.kill();
  }
}

ipcMain.handle('start-analysis', (event, videoPath) => {
  if (analysisChild) return false;

  const sender = event.sender;
  const args = ['-u', path.join(__dirname, 'stub', 'fake_analysis.py')];
  if (videoPath) args.push(videoPath);
  if (process.env.FAKE_ANALYSIS_FAIL) args.push('--fail');

  const child = spawn('python', args);
  analysisChild = child;
  analysisCanceled = false;

  let stdoutBuf = '';
  let lastStderr = '';
  let settled = false;

  const settle = (terminalEvent, errorTitle) => {
    if (settled) return;
    settled = true;
    analysisChild = null;
    sender.send('analysis-event', terminalEvent);
    if (errorTitle) dialog.showErrorBox(errorTitle, terminalEvent.message);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        sender.send('analysis-event', JSON.parse(line));
      } catch {
        // ignore lines that are not valid JSON
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const text = chunk.trim();
    if (text) lastStderr = text.split('\n').pop();
  });

  child.on('error', (err) => {
    settle({ event: 'error', message: `Could not launch Python: ${err.message}` }, 'Analysis failed to start');
  });

  child.on('close', (code) => {
    if (analysisCanceled) {
      settle({ event: 'canceled' });
    } else if (code === 0) {
      settle({ event: 'done' });
    } else {
      const message = `Analysis process exited with code ${code}${lastStderr ? `\n${lastStderr}` : ''}`;
      settle({ event: 'error', message }, 'Analysis failed');
    }
  });

  return true;
});

ipcMain.on('cancel-analysis', () => killAnalysis());

app.on('before-quit', () => killAnalysis());

// --- Window ---

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1280,
    minHeight: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
