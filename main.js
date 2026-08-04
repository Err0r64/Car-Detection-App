const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const {
  createAnalysisWatchdog,
  formatAnalysisFailure,
  removeRunDirectory,
  terminateProcessTree,
  validateProtocolEvent,
} = require('./analysis-lifecycle');
const {
  startClipBatchExport,
  validateClipIntervals,
  writeExportManifest,
} = require('./clip-export');
const {
  resolveRuntimePath,
  runtimeRoot,
} = require('./runtime-paths');
const { parseConfigJson } = require('./runtime-config');
const { resolvePythonRuntime } = require('./python-runtime');
const {
  normalizeServiceUrl,
  resolvePromptProfile,
} = require('./prompt-profile-client');
const {
  cleanProjectName,
  importVideoFile,
  pathsEqual,
  resolveProjectDirectory,
  validateProjectName,
} = require('./project-workspace');

const ANALYSIS_CONFIG_DEFAULTS = {
  pythonPath: process.platform === 'win32' ? 'python' : 'python3',
  analyzeScript: 'pipeline/analyze.py',
  ffmpegPath: 'ffmpeg',
  analysisStallTimeoutSeconds: 5 * 60,
  analysisMaxTimeoutSeconds: 45 * 60,
  promptServiceUrl: 'https://apexiel-prompt-service-316801639479.us-west1.run.app',
  promptFetchTimeoutSeconds: 5,
  useDevStub: false,
};
const ANALYSIS_CONFIG_LIMITS = {
  stallSeconds: 30 * 60,
  maxSeconds: 2 * 60 * 60,
};

function readAnalysisConfig() {
  const configPath = path.join(appResourceRoot(), 'config.json');
  let configured = {};
  if (fs.existsSync(configPath)) {
    configured = parseConfigJson(fs.readFileSync(configPath, 'utf8'));
  }

  if (
    Object.prototype.hasOwnProperty.call(configured, 'analysisTimeoutSeconds')
    && !Object.prototype.hasOwnProperty.call(configured, 'analysisStallTimeoutSeconds')
  ) {
    configured.analysisStallTimeoutSeconds = configured.analysisTimeoutSeconds;
  }

  const config = { ...ANALYSIS_CONFIG_DEFAULTS, ...configured };
  for (const key of ['pythonPath', 'analyzeScript', 'ffmpegPath']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) {
      throw new Error('config.json ' + key + ' must be a non-empty string.');
    }
  }
  if (typeof config.useDevStub !== 'boolean') {
    throw new Error('config.json useDevStub must be true or false.');
  }
  config.promptServiceUrl = normalizeServiceUrl(config.promptServiceUrl);

  const timeoutLimits = {
    analysisStallTimeoutSeconds: ANALYSIS_CONFIG_LIMITS.stallSeconds,
    analysisMaxTimeoutSeconds: ANALYSIS_CONFIG_LIMITS.maxSeconds,
    promptFetchTimeoutSeconds: 30,
  };
  for (const [key, maximum] of Object.entries(timeoutLimits)) {
    if (
      !Number.isFinite(config[key])
      || config[key] <= 0
      || config[key] > maximum
    ) {
      throw new Error(
        'config.json ' + key + ' must be greater than 0 and no more than ' + maximum + '.'
      );
    }
  }
  if (config.analysisMaxTimeoutSeconds <= config.analysisStallTimeoutSeconds) {
    throw new Error(
      'config.json analysisMaxTimeoutSeconds must be greater than analysisStallTimeoutSeconds.'
    );
  }
  return config;
}

function runtimePathOptions() {
  return {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appDirectory: __dirname,
  };
}

function appResourceRoot() {
  return runtimeRoot(runtimePathOptions());
}

function resolveAppPath(configuredPath) {
  return resolveRuntimePath(configuredPath, runtimePathOptions());
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

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    const settings = parseConfigJson(fs.readFileSync(settingsPath(), 'utf8'));
    return settings && typeof settings === 'object' && !Array.isArray(settings)
      ? settings
      : {};
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function defaultProjectsRoot() {
  return path.join(app.getPath('documents'), 'Apexiel Projects');
}

function getProjectsRoot() {
  const configured = readSettings().projectsRoot;
  return typeof configured === 'string' && path.isAbsolute(configured)
    ? path.resolve(configured)
    : defaultProjectsRoot();
}

function findRegisteredProject(projectPath) {
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) return null;
  return readRegistry().find((project) => pathsEqual(project.path, projectPath)) || null;
}

// --- IPC handlers ---

ipcMain.handle('list-projects', () => readRegistry());
ipcMain.handle('get-projects-root', () => getProjectsRoot());

ipcMain.handle('choose-projects-root', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const currentRoot = getProjectsRoot();
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose Projects Location',
    defaultPath: fs.existsSync(currentRoot) ? currentRoot : path.dirname(currentRoot),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const projectsRoot = path.resolve(result.filePaths[0]);
  try {
    fs.mkdirSync(projectsRoot, { recursive: true });
    writeSettings({ ...readSettings(), projectsRoot });
    return projectsRoot;
  } catch (err) {
    dialog.showErrorBox('Project location unavailable', `Could not use that folder:\n${err.message}`);
    return null;
  }
});

ipcMain.handle('create-project', async (event, requestedName) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const validationError = validateProjectName(requestedName);
  if (validationError) {
    dialog.showErrorBox('Invalid project name', validationError);
    return null;
  }

  const name = cleanProjectName(requestedName);
  const projectsRoot = getProjectsRoot();
  let projectDirectory;
  try {
    projectDirectory = resolveProjectDirectory(projectsRoot, name);
  } catch (err) {
    dialog.showErrorBox('Could not create project', err.message);
    return null;
  }

  const projects = readRegistry();
  const registered = projects.find((project) => pathsEqual(project.path, projectDirectory));
  if (registered) return registered;

  try {
    fs.mkdirSync(projectsRoot, { recursive: true });
    if (fs.existsSync(projectDirectory)) {
      if (!fs.statSync(projectDirectory).isDirectory()) {
        throw new Error('A file with that project name already exists.');
      }
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        title: 'Use Existing Folder',
        message: `A folder named "${name}" already exists. Use it as this project?`,
        detail: 'Existing files in the folder will not be changed.',
        buttons: ['Use Folder', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return null;
    } else {
      fs.mkdirSync(projectDirectory);
    }

    fs.mkdirSync(path.join(projectDirectory, 'media'), { recursive: true });
    const project = { name, path: projectDirectory };
    projects.push(project);
    writeRegistry(projects);
    return project;
  } catch (err) {
    dialog.showErrorBox('Could not create project', err.message);
    return null;
  }
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
    detail: 'This only removes the project from the landing screen. The project folder, imported videos, and saved files stay on disk.',
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return false;

  writeRegistry(projects.filter((p) => p.path !== projectPath));
  return true;
});

ipcMain.handle('open-video', async (event, projectPath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const project = findRegisteredProject(projectPath);
  if (!project) {
    dialog.showErrorBox('Import unavailable', 'Select a registered project before importing video.');
    return null;
  }

  const result = await dialog.showOpenDialog(win, {
    title: 'Import Video',
    properties: ['openFile'],
    filters: [{ name: 'Videos', extensions: ['mp4', 'mov'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const sourcePath = result.filePaths[0];
  try {
    const importedPath = await importVideoFile(project.path, sourcePath);
    return {
      path: importedPath,
      name: path.basename(importedPath),
      url: pathToFileURL(importedPath).href,
    };
  } catch (err) {
    dialog.showErrorBox('Video import failed', `Could not copy the video into the project:\n${err.message}`);
    return null;
  }
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
let analysisStarting = false;
let verifiedPythonRuntime = null;
let analysisResultPath = null;
let analysisRunDirectory = null;
let terminateActiveAnalysis = null;
let activeExport = null;

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

function cleanupAnalysisRunDirectory(directory = analysisRunDirectory) {
  if (!directory) return true;
  const error = removeRunDirectory(directory);
  if (error) {
    console.error(`Could not remove analysis work directory ${directory}: ${error.message}`);
    return false;
  }
  if (analysisRunDirectory === directory) analysisRunDirectory = null;
  return true;
}

function discardAnalysisResults() {
  analysisResultPath = null;
  return cleanupAnalysisRunDirectory();
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
  const resultPath = analysisResultPath;
  const runDirectory = analysisRunDirectory;
  analysisResultPath = null;
  try {
    const results = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const validationError = validateAnalysisResults(results);
    if (validationError) throw new Error(validationError);
    return results;
  } catch (err) {
    dialog.showErrorBox(
      'Analysis results unavailable',
      formatAnalysisFailure('parsing', `Could not load analysis results: ${err.message}`)
    );
    return null;
  } finally {
    cleanupAnalysisRunDirectory(runDirectory);
  }
});

ipcMain.handle('discard-analysis-results', () => discardAnalysisResults());

function killAnalysis() {
  if (terminateActiveAnalysis) terminateActiveAnalysis('canceled');
}

async function startAnalysis(event, videoPath) {
  if (analysisChild || activeExport) return false;

  if (analysisRunDirectory && !discardAnalysisResults()) {
    dialog.showErrorBox(
      'Analysis failed to start',
      formatAnalysisFailure('startup', 'Could not clean up the previous analysis run.')
    );
    return false;
  }

  if (typeof videoPath !== 'string' || !fs.existsSync(videoPath)) {
    dialog.showErrorBox(
      'Analysis failed to start',
      formatAnalysisFailure('startup', 'The selected video file could not be found.')
    );
    return false;
  }

  let config;
  try {
    config = readAnalysisConfig();
  } catch (err) {
    dialog.showErrorBox(
      'Invalid analysis configuration',
      formatAnalysisFailure('startup', err.message)
    );
    return false;
  }

  if (!config.useDevStub && !process.env.GEMINI_API_KEY) {
    dialog.showErrorBox(
      'Gemini API key missing',
      formatAnalysisFailure(
        'startup',
        'Set GEMINI_API_KEY in the environment before starting the application.'
      )
    );
    return false;
  }

  let scriptPath;
  if (config.useDevStub) {
    scriptPath = path.join(appResourceRoot(), 'stub', 'fake_analysis.py');
  } else {
    scriptPath = resolveAppPath(config.analyzeScript);
  }
  if (!fs.existsSync(scriptPath)) {
    dialog.showErrorBox(
      'Analysis failed to start',
      formatAnalysisFailure('startup', `The analysis script could not be found: ${scriptPath}`)
    );
    return false;
  }

  let pythonCommand = config.pythonPath;
  if (!config.useDevStub) {
    if (
      !verifiedPythonRuntime
      || verifiedPythonRuntime.configuredPath !== config.pythonPath
    ) {
      const resolution = resolvePythonRuntime(config.pythonPath);
      if (!resolution.command) {
        const checked = resolution.attempted.length > 0
          ? resolution.attempted.join(', ')
          : config.pythonPath;
        const installTarget = resolution.attempted[0] || config.pythonPath;
        const requirementsPath = path.join(
          appResourceRoot(),
          'pipeline',
          'requirements.txt'
        );
        const newline = String.fromCharCode(10);
        dialog.showErrorBox(
          'Analysis dependencies missing',
          formatAnalysisFailure(
            'startup',
            'Could not find a Python installation containing google-genai and jsonschema.'
              + newline + 'Checked: ' + checked
              + newline + 'Install the pipeline packages with: "'
              + installTarget
              + '" -m pip install -r "'
              + requirementsPath
              + '"'
          )
        );        return false;
      }
      verifiedPythonRuntime = {
        configuredPath: config.pythonPath,
        command: resolution.command,
      };
    }
    pythonCommand = verifiedPythonRuntime.command;
  }

  let promptSelection = {
    source: 'built-in',
    envelope: null,
    reason: 'Development stub does not call Gemini.',
  };
  if (!config.useDevStub) {
    try {
      promptSelection = await resolvePromptProfile({
        serviceUrl: config.promptServiceUrl,
        cachePath: path.join(app.getPath('userData'), 'prompt-profile-cache.json'),
        clientVersion: app.getVersion(),
        timeoutMs: config.promptFetchTimeoutSeconds * 1000,
      });
    } catch (error) {
      promptSelection = {
        source: 'built-in',
        envelope: null,
        reason: `Prompt selection failed; using built-in prompt. ${error.message}`,
      };
    }
  }
  const selectedProfile = promptSelection.envelope && promptSelection.envelope.profile;
  const promptLabel = selectedProfile
    ? `${selectedProfile.profileId} v${selectedProfile.version}`
    : 'built-in';
  console.info(`[prompt-profile] Using ${promptLabel} (${promptSelection.source}).`);
  console.info(`[prompt-profile] ${promptSelection.reason}`);
  if (promptSelection.warning) console.warn(`[prompt-profile] ${promptSelection.warning}`);

  let runDirectory;
  try {
    runDirectory = fs.mkdtempSync(path.join(app.getPath('temp'), 'capstone-analysis-'));
  } catch (err) {
    dialog.showErrorBox(
      'Analysis failed to start',
      formatAnalysisFailure('startup', `Could not create a work directory: ${err.message}`)
    );
    return false;
  }

  analysisRunDirectory = runDirectory;
  const expectedResultPath = path.join(runDirectory, 'results.json');
  let promptProfilePath = null;
  if (promptSelection.envelope) {
    promptProfilePath = path.join(runDirectory, 'prompt-profile.json');
    try {
      fs.writeFileSync(
        promptProfilePath,
        JSON.stringify(promptSelection.envelope, null, 2) + '\n',
        'utf8'
      );
    } catch (error) {
      cleanupAnalysisRunDirectory(runDirectory);
      dialog.showErrorBox(
        'Analysis failed to start',
        formatAnalysisFailure(
          'startup',
          `Could not prepare the selected prompt profile: ${error.message}`
        )
      );
      return false;
    }
  }
  const args = config.useDevStub
    ? [
      '-u',
      scriptPath,
      videoPath,
      '--out',
      expectedResultPath,
      ...(process.env.FAKE_ANALYSIS_FAIL ? ['--fail'] : []),
      ...(process.env.FAKE_ANALYSIS_MALFORMED ? ['--malformed'] : []),
    ]
    : [
      '-u',
      scriptPath,
      '--video',
      videoPath,
      '--out',
      expectedResultPath,
      '--ffmpeg-path',
      config.ffmpegPath,
      '--proxy-cache-dir',
      path.join(path.dirname(videoPath), '.analysis-cache'),
      '--prompt-source',
      promptSelection.source,
      ...(promptProfilePath ? ['--prompt-profile', promptProfilePath] : []),
    ];

  const sender = event.sender;
  const childEnvironment = { ...process.env };
  if (!config.useDevStub) {
    childEnvironment.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    childEnvironment.CAPSTONE_GEMINI_RATE_STATE = path.join(
      app.getPath('userData'),
      'gemini-rate-limit.json'
    );
  }

  let child;
  try {
    child = spawn(pythonCommand, args, {
      cwd: appResourceRoot(),
      detached: process.platform !== 'win32',
      env: childEnvironment,
      windowsHide: true,
    });
  } catch (err) {
    cleanupAnalysisRunDirectory(runDirectory);
    dialog.showErrorBox(
      'Analysis failed to start',
      formatAnalysisFailure('startup', `Could not launch Python: ${err.message}`)
    );
    return false;
  }

  analysisChild = child;
  analysisResultPath = null;

  let activeStage = 'startup';
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let lastStderr = '';
  let terminalKind = null;
  let terminationReason = null;
  let pendingDoneEvent = null;
  let pendingFailure = null;
  let watchdog = null;
  let forceKillTimer = null;

  const clearRunTimers = () => {
    if (watchdog) {
      watchdog.stop();
      watchdog = null;
    }
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
  };

  const sendEvent = (protocolEvent) => {
    if (!sender.isDestroyed()) sender.send('analysis-event', protocolEvent);
  };

  const sendTerminal = (terminalEvent, errorTitle = null) => {
    if (terminalKind) return;
    terminalKind = terminalEvent.event;
    sendEvent(terminalEvent);
    if (errorTitle) dialog.showErrorBox(errorTitle, terminalEvent.message);
  };

  const sendFailure = (stage, message, errorTitle = 'Analysis failed') => {
    sendTerminal(
      {
        event: 'error',
        stage,
        message: formatAnalysisFailure(stage, message, lastStderr),
      },
      errorTitle
    );
  };

  const stopChild = (reason) => {
    if (terminationReason) return;
    terminationReason = reason;
    clearRunTimers();
    forceKillTimer = terminateProcessTree(child);
  };

  terminateActiveAnalysis = (reason = 'canceled') => {
    if (analysisChild !== child || terminalKind || terminationReason) return;
    stopChild(reason);
  };

  const queueFailure = (stage, message) => {
    if (pendingFailure || pendingDoneEvent || terminalKind || terminationReason) return;
    pendingFailure = { stage, message };
    stopChild('error');
  };

  const forwardProtocolEvent = (protocolEvent) => {
    if (terminationReason || terminalKind || pendingDoneEvent) return;
    activeStage = protocolEvent.stage;
    if (protocolEvent.event === 'done') {
      if (
        typeof protocolEvent.resultsPath !== 'string'
        || !sameFilePath(protocolEvent.resultsPath, expectedResultPath)
        || !fs.existsSync(expectedResultPath)
      ) {
        queueFailure('parsing', 'Analysis returned an invalid results path.');
        return;
      }
      pendingDoneEvent = config.useDevStub
        ? { ...protocolEvent, devStub: true }
        : protocolEvent;
      return;
    }
    if (protocolEvent.event === 'error') {
      queueFailure(
        protocolEvent.stage,
        protocolEvent.message || 'Analysis failed.'
      );
      return;
    }
    sendEvent(protocolEvent);
  };

  const processProtocolLine = (line) => {
    if (!line.trim() || terminationReason || terminalKind || pendingDoneEvent) return;
    let protocolEvent;
    try {
      protocolEvent = JSON.parse(line);
    } catch {
      queueFailure(activeStage, 'Analysis emitted malformed JSONL progress output.');
      return;
    }
    const validationError = validateProtocolEvent(protocolEvent);
    if (validationError) {
      queueFailure(activeStage, `Invalid analysis progress event: ${validationError}.`);
      return;
    }
    if (watchdog) watchdog.touch();
    forwardProtocolEvent(protocolEvent);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop();
    for (const line of lines) processProtocolLine(line);
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop();
    for (const line of lines) {
      const text = line.trim();
      if (text) {
        lastStderr = text;
        if (watchdog) watchdog.touch();
      }
    }
  });

  child.on('error', (err) => {
    if (!pendingFailure && !terminalKind) {
      pendingFailure = {
        stage: 'startup',
        message: `Could not launch Python: ${err.message}`,
        title: 'Analysis failed to start',
      };
    }
  });

  child.on('close', (code) => {
    if (stderrBuffer.trim()) lastStderr = stderrBuffer.trim();
    if (stdoutBuffer.trim() && !terminationReason && !terminalKind && !pendingDoneEvent) {
      processProtocolLine(stdoutBuffer);
    }

    clearRunTimers();
    if (analysisChild === child) analysisChild = null;
    if (terminateActiveAnalysis) terminateActiveAnalysis = null;

    if (terminationReason === 'canceled') {
      sendTerminal({ event: 'canceled' });
    } else if (terminationReason === 'timeout') {
      // The timeout callback already sent the visible terminal error.
    } else if (pendingFailure) {
      sendFailure(
        pendingFailure.stage,
        pendingFailure.message,
        pendingFailure.title || 'Analysis failed'
      );
    } else if (pendingDoneEvent && code === 0) {
      analysisResultPath = expectedResultPath;
      sendTerminal(pendingDoneEvent);
    } else if (code === 0) {
      sendFailure(activeStage, 'Analysis exited without reporting a results file.');
    } else {
      sendFailure(activeStage, `Analysis process exited with code ${code}.`);
    }

    if (terminalKind !== 'done') cleanupAnalysisRunDirectory(runDirectory);
  });

  watchdog = createAnalysisWatchdog({
    stallMs: config.analysisStallTimeoutSeconds * 1000,
    maxMs: config.analysisMaxTimeoutSeconds * 1000,
    onStall: () => {
      if (analysisChild !== child || terminalKind || terminationReason) return;
      sendFailure(
        activeStage,
        'Analysis stopped reporting progress for '
          + config.analysisStallTimeoutSeconds
          + ' seconds.'
      );
      stopChild('timeout');
    },
    onMax: () => {
      if (analysisChild !== child || terminalKind || terminationReason) return;
      sendFailure(
        activeStage,
        'Analysis exceeded the maximum run time of '
          + config.analysisMaxTimeoutSeconds
          + ' seconds.'
      );
      stopChild('timeout');
    },
  });
  watchdog.start();

  return true;
}

ipcMain.handle('start-analysis', async (event, videoPath) => {
  if (analysisStarting || analysisChild || activeExport) return false;
  analysisStarting = true;
  try {
    return await startAnalysis(event, videoPath);
  } finally {
    analysisStarting = false;
  }
});

ipcMain.on('cancel-analysis', () => killAnalysis());

// --- Clip export ---

ipcMain.handle('choose-export-folder', async (event, suggestedPath) => {
  if (analysisStarting || analysisChild || activeExport) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: 'Choose Export Folder',
    properties: ['openDirectory', 'createDirectory'],
  };
  if (
    typeof suggestedPath === 'string'
    && suggestedPath
    && fs.existsSync(suggestedPath)
  ) {
    options.defaultPath = suggestedPath;
  }
  const result = await dialog.showOpenDialog(win, options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('export-clips', async (event, request) => {
  if (analysisStarting || analysisChild || activeExport) {
    return { ok: false, error: 'Another analysis or export is already running.' };
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { ok: false, error: 'An export request is required.' };
  }

  const { videoPath, outputDirectory, intervals } = request;
  const intervalsError = validateClipIntervals(intervals);
  if (intervalsError) return { ok: false, error: intervalsError };
  try {
    if (typeof videoPath !== 'string' || !fs.statSync(videoPath).isFile()) {
      return { ok: false, error: 'The original video file could not be found.' };
    }
  } catch {
    return { ok: false, error: 'The original video file could not be found.' };
  }
  try {
    if (typeof outputDirectory !== 'string' || !fs.statSync(outputDirectory).isDirectory()) {
      return { ok: false, error: 'The selected export folder could not be found.' };
    }
  } catch {
    return { ok: false, error: 'The selected export folder could not be found.' };
  }

  let config;
  try {
    config = readAnalysisConfig();
  } catch (error) {
    return { ok: false, error: `Invalid export configuration: ${error.message}` };
  }

  let run;
  try {
    const simulatedFailure = Number(process.env.CAPSTONE_EXPORT_FAIL_CLIP);
    run = startClipBatchExport({
      ffmpegPath: config.ffmpegPath,
      sourcePath: videoPath,
      outputDirectory,
      intervals,
      simulateFailureAtClip: Number.isInteger(simulatedFailure) && simulatedFailure > 0
        ? simulatedFailure
        : null,
      onEvent: (exportEvent) => {
        if (!event.sender.isDestroyed()) event.sender.send('export-event', exportEvent);
      },
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }

  activeExport = run;
  try {
    const result = await run.completion;
    try {
      const manifest = writeExportManifest({
        outputDirectory,
        sourcePath: videoPath,
        summary: result,
      });
      return { ok: true, ...result, manifestPath: manifest.manifestPath };
    } catch (error) {
      return {
        ok: false,
        ...result,
        error: `Clips finished, but the export manifest could not be written: ${error.message}`,
      };
    }
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    if (activeExport === run) activeExport = null;
  }
});

function killExport() {
  if (!activeExport) return false;
  if (typeof activeExport.requestCancel === 'function') activeExport.requestCancel();
  if (activeExport.child) terminateProcessTree(activeExport.child);
  return true;
}

ipcMain.on('cancel-export', () => killExport());

ipcMain.handle('open-export-folder', async (_event, folderPath) => {
  try {
    if (typeof folderPath !== 'string' || !fs.statSync(folderPath).isDirectory()) {
      return { ok: false, error: 'The export folder could not be found.' };
    }
  } catch {
    return { ok: false, error: 'The export folder could not be found.' };
  }
  const error = await shell.openPath(folderPath);
  return error ? { ok: false, error } : { ok: true };
});
app.on('before-quit', () => {
  killAnalysis();
  killExport();
  if (!analysisChild) discardAnalysisResults();
});
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
