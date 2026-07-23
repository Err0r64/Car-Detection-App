const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

const ANALYSIS_CONFIG_DEFAULTS = {
  pythonPath: process.platform === 'win32' ? 'python' : 'python3',
  analyzeScript: 'pipeline/analyze.py',
  ffmpegPath: 'ffmpeg',
  useDevStub: false,
};

function readAnalysisConfig() {
  const configPath = path.join(__dirname, 'config.json');
  let configured = {};
  if (fs.existsSync(configPath)) {
    configured = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  const config = { ...ANALYSIS_CONFIG_DEFAULTS, ...configured };
  for (const key of ['pythonPath', 'analyzeScript', 'ffmpegPath']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) {
      throw new Error(`config.json ${key} must be a non-empty string.`);
    }
  }
  if (typeof config.useDevStub !== 'boolean') {
    throw new Error('config.json useDevStub must be true or false.');
  }
  return config;
}

function resolveAppPath(configuredPath) {
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(__dirname, configuredPath);
}
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

ipcMain.handle('confirm-unsaved-changes', async (event, videoName, destination) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const displayName = typeof videoName === 'string' && videoName
    ? videoName
    : 'the current video';
  const destinationLabels = {
    video: 'opening another video',
    project: 'loading another project',
    projects: 'returning to Projects',
    analysis: 'replacing the current detections with new analysis results',
  };
  const destinationLabel = destinationLabels[destination] || 'continuing';
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Unsaved Changes',
    message: `Save changes to "${displayName}" before ${destinationLabel}?`,
    detail: 'Discarding will permanently lose the current unsaved detections and metadata edits.',
    buttons: ['Save', 'Discard', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  return ['save', 'discard', 'cancel'][response] || 'cancel';
});

// --- Project save/load (.vproj.json) ---

const PROJECT_FILE_FILTERS = [{ name: 'Video Project', extensions: ['vproj.json'] }];
const TIMESTAMP_EPSILON_S = 0.000001;

function validateProjectFile(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    return 'The project file must contain a JSON object.';
  }
  if (project.version !== 1) return 'Only project file version 1 is supported.';
  if (typeof project.videoPath !== 'string' || project.videoPath.length === 0) {
    return 'The project file does not reference a video.';
  }
  if (!Number.isFinite(project.videoDurationS) || project.videoDurationS <= 0) {
    return 'The project video duration must be a positive number of seconds.';
  }
  if (!Array.isArray(project.detections)) return 'The project detections must be an array.';

  for (let index = 0; index < project.detections.length; index += 1) {
    const item = project.detections[index];
    const validConfidence = item && (
      item.confidence === null || (
        Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1
      )
    );
    const valid = item
      && typeof item === 'object'
      && !Array.isArray(item)
      && typeof item.car_number === 'string'
      && Number.isFinite(item.start_s)
      && Number.isFinite(item.end_s)
      && item.start_s >= 0
      && item.start_s < item.end_s
      && item.end_s <= project.videoDurationS + TIMESTAMP_EPSILON_S
      && typeof item.subject === 'boolean'
      && validConfidence
      && typeof item.notes === 'string';
    if (!valid) return `Detection ${index + 1} is not schema-conformant.`;
  }

  if (typeof project.savedAt !== 'string' || Number.isNaN(Date.parse(project.savedAt))) {
    return 'The project savedAt value must be a valid timestamp.';
  }
  return null;
}

ipcMain.handle('save-project', async (event, request) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const project = request && request.project;
  const validationError = validateProjectFile(project);
  if (validationError) {
    dialog.showErrorBox('Save failed', validationError);
    return null;
  }

  let filePath = typeof request.filePath === 'string' && request.filePath
    ? request.filePath
    : null;
  if (!filePath) {
    const projectDirectory = typeof request.projectDirectory === 'string'
      ? request.projectDirectory
      : '';
    const defaultPath = projectDirectory
      ? path.join(projectDirectory, `${path.basename(projectDirectory)}.vproj.json`)
      : 'project.vproj.json';
    const result = await dialog.showSaveDialog(win, {
      title: 'Save Project',
      filters: PROJECT_FILE_FILTERS,
      defaultPath,
    });
    if (result.canceled || !result.filePath) return null;
    filePath = result.filePath;
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(project, null, 2));
    return filePath;
  } catch (err) {
    dialog.showErrorBox('Save failed', `Could not write project file:\n${err.message}`);
    return null;
  }
});

ipcMain.handle('load-project', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Load Project',
    properties: ['openFile'],
    filters: PROJECT_FILE_FILTERS,
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  try {
    const project = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const validationError = validateProjectFile(project);
    if (validationError) throw new Error(validationError);
    if (!fs.existsSync(project.videoPath) || !fs.statSync(project.videoPath).isFile()) {
      dialog.showErrorBox(
        'Video file missing',
        `The project video could not be found:\n${project.videoPath}`
      );
      return null;
    }

    return {
      project,
      filePath,
      videoUrl: pathToFileURL(project.videoPath).href,
    };
  } catch (err) {
    dialog.showErrorBox('Load failed', `Could not read project file:\n${err.message}`);
    return null;
  }
});

// --- Analysis pipeline ---

let analysisChild = null;
let analysisCanceled = false;
let analysisResultPath = null;
let analysisRunDirectory = null;

function sameFilePath(left, right) {
  const normalize = (value) => {
    let resolved;
    try {
      resolved = fs.realpathSync.native(value);
    } catch {
      resolved = path.resolve(value);
    }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function validateAnalysisResults(results) {
  if (!results || typeof results !== 'object' || Array.isArray(results)) {
    return 'Analysis results must contain a JSON object.';
  }
  if (!Array.isArray(results.detections)) {
    return 'Analysis results must contain a detections array.';
  }
  for (let index = 0; index < results.detections.length; index += 1) {
    const item = results.detections[index];
    const validConfidence = item && (
      item.confidence === null || (
        Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1
      )
    );
    const valid = item
      && typeof item === 'object'
      && !Array.isArray(item)
      && typeof item.car_number === 'string'
      && Number.isFinite(item.start_s)
      && Number.isFinite(item.end_s)
      && item.start_s >= 0
      && item.start_s < item.end_s
      && typeof item.subject === 'boolean'
      && validConfidence
      && typeof item.notes === 'string';
    if (!valid) return `Detection ${index + 1} is not schema-conformant.`;
  }
  return null;
}

ipcMain.handle('load-analysis-results', () => {
  if (!analysisResultPath) return null;
  try {
    const results = JSON.parse(fs.readFileSync(analysisResultPath, 'utf8'));
    const validationError = validateAnalysisResults(results);
    if (validationError) throw new Error(validationError);
    analysisResultPath = null;
    return results;
  } catch (err) {
    dialog.showErrorBox('Analysis results unavailable', `Could not load analysis results:\n${err.message}`);
    return null;
  }
});

function killAnalysis() {
  if (analysisChild) {
    analysisCanceled = true;
    analysisChild.kill();
  }
}

ipcMain.handle('start-analysis', (event, videoPath) => {
  if (analysisChild) return false;

  const win = BrowserWindow.fromWebContents(event.sender);
  if (typeof videoPath !== 'string' || !fs.existsSync(videoPath)) {
    dialog.showErrorBox('Analysis failed to start', 'The selected video file could not be found.');
    return false;
  }

  let config;
  try {
    config = readAnalysisConfig();
  } catch (err) {
    dialog.showErrorBox('Invalid analysis configuration', err.message);
    return false;
  }

  if (!config.useDevStub && !process.env.GEMINI_API_KEY) {
    dialog.showErrorBox(
      'Gemini API key missing',
      'Set GEMINI_API_KEY in the environment before starting the application.'
    );
    return false;
  }

  let args;
  let expectedResultPath = null;
  if (config.useDevStub) {
    try {
      analysisRunDirectory = fs.mkdtempSync(
        path.join(app.getPath('temp'), 'capstone-analysis-')
      );
    } catch (err) {
      dialog.showErrorBox('Analysis failed to start', `Could not create a work directory:\n${err.message}`);
      return false;
    }
    expectedResultPath = path.join(analysisRunDirectory, 'results.json');
    args = [
      '-u',
      path.join(__dirname, 'stub', 'fake_analysis.py'),
      videoPath,
      '--out',
      expectedResultPath,
    ];
    if (process.env.FAKE_ANALYSIS_FAIL) args.push('--fail');
  } else {
    const analyzeScript = resolveAppPath(config.analyzeScript);
    if (!fs.existsSync(analyzeScript)) {
      dialog.showErrorBox(
        'Analysis failed to start',
        `The configured analysis script could not be found:\n${analyzeScript}`
      );
      return false;
    }
    try {
      analysisRunDirectory = fs.mkdtempSync(
        path.join(app.getPath('temp'), 'capstone-analysis-')
      );
    } catch (err) {
      dialog.showErrorBox('Analysis failed to start', `Could not create a work directory:\n${err.message}`);
      return false;
    }
    expectedResultPath = path.join(analysisRunDirectory, 'results.json');
    args = [
      '-u',
      analyzeScript,
      '--video',
      videoPath,
      '--out',
      expectedResultPath,
      '--ffmpeg-path',
      config.ffmpegPath,
    ];
  }

  const sender = event.sender;
  const childEnvironment = { ...process.env };
  if (!config.useDevStub) {
    childEnvironment.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  }
  const child = spawn(config.pythonPath, args, {
    cwd: __dirname,
    env: childEnvironment,
    windowsHide: true,
  });
  analysisChild = child;
  analysisCanceled = false;
  analysisResultPath = null;

  let stdoutBuf = '';
  let lastStderr = '';
  let terminalEventSent = false;

  const sendTerminal = (terminalEvent, errorTitle) => {
    if (terminalEventSent) return;
    terminalEventSent = true;
    sender.send('analysis-event', terminalEvent);
    if (errorTitle) dialog.showErrorBox(errorTitle, terminalEvent.message);
  };

  const forwardProtocolEvent = (protocolEvent) => {
    if (protocolEvent.event === 'done') {
      if (
        typeof protocolEvent.resultsPath !== 'string'
        || !sameFilePath(protocolEvent.resultsPath, expectedResultPath)
        || !fs.existsSync(expectedResultPath)
      ) {
        sendTerminal(
          { event: 'error', stage: 'parsing', message: 'Analysis returned an invalid results path.' },
          'Analysis failed'
        );
        return;
      }
      analysisResultPath = expectedResultPath;
      sendTerminal(config.useDevStub ? { ...protocolEvent, devStub: true } : protocolEvent);
      return;
    }
    if (protocolEvent.event === 'error') {
      const stage = protocolEvent.stage ? `${protocolEvent.stage}: ` : '';
      sendTerminal(
        { ...protocolEvent, message: `${stage}${protocolEvent.message || 'Analysis failed.'}` },
        'Analysis failed'
      );
      return;
    }
    sender.send('analysis-event', protocolEvent);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        forwardProtocolEvent(JSON.parse(line));
      } catch {
        // Protocol hardening for malformed output is handled in CP4.
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const text = chunk.trim();
    if (text) lastStderr = text.split('\n').pop();
  });

  child.on('error', (err) => {
    analysisChild = null;
    sendTerminal(
      { event: 'error', message: `Could not launch Python: ${err.message}` },
      'Analysis failed to start'
    );
  });

  child.on('close', (code) => {
    analysisChild = null;
    if (analysisCanceled) {
      sendTerminal({ event: 'canceled' });
    } else if (code === 0) {
      if (!terminalEventSent) {
        sendTerminal(
          { event: 'error', message: 'Analysis exited without reporting a results file.' },
          'Analysis failed'
        );
      }
    } else if (!terminalEventSent) {
      const message = `Analysis process exited with code ${code}${lastStderr ? `\n${lastStderr}` : ''}`;
      sendTerminal({ event: 'error', message }, 'Analysis failed');
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
