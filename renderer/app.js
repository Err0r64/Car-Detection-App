'use strict';

// Landing view
const viewLanding = document.getElementById('view-landing');
const projectGrid = document.getElementById('project-grid');
const projectEmpty = document.getElementById('project-empty');
const projectsRootPath = document.getElementById('projects-root-path');
const btnChangeProjectRoot = document.getElementById('btn-change-project-root');
const btnNewProject = document.getElementById('btn-new-project');
const createProjectDialog = document.getElementById('create-project-dialog');
const createProjectForm = document.getElementById('create-project-form');
const projectNameInput = document.getElementById('project-name-input');
const projectNameError = document.getElementById('project-name-error');
const btnCreateProjectCancel = document.getElementById('btn-create-project-cancel');
const btnCreateProjectConfirm = document.getElementById('btn-create-project-confirm');
const themeButtons = [...document.querySelectorAll('[data-theme-toggle]')];

const THEME_STORAGE_KEY = 'apexiel-theme';

function readInitialTheme() {
  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme;
  } catch {
    // The system preference remains a safe fallback if storage is unavailable.
  }

  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme, persist = true) {
  const activeTheme = theme === 'light' ? 'light' : 'dark';
  const nextTheme = activeTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = activeTheme;

  themeButtons.forEach((button) => {
    const label = `Switch to ${nextTheme} mode`;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.setAttribute('aria-pressed', String(activeTheme === 'light'));
  });

  if (!persist) return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, activeTheme);
  } catch {
    // Theme switching still works for the current session without persistence.
  }
}

themeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
  });
});
applyTheme(readInitialTheme(), false);

// Editor view
const viewEditor = document.getElementById('view-editor');
const btnOpenVideo = document.getElementById('btn-open-video');
const btnDetectVehicles = document.getElementById('btn-detect-vehicles');
const btnSaveChanges = document.getElementById('btn-save-changes');
const btnExport = document.getElementById('btn-export');
const btnBackToProjects = document.getElementById('btn-back-to-projects');
const btnLoadProject = document.getElementById('btn-load-project');
const btnCancel = document.getElementById('btn-cancel');
const videoName = document.getElementById('video-name');
const videoPlayer = document.getElementById('video-player');
const videoPlaceholder = document.getElementById('video-placeholder');
const statusLine = document.getElementById('status-line');
const statusStage = document.getElementById('status-stage');
const statusElapsed = document.getElementById('status-elapsed');
const statusTokens = document.getElementById('status-tokens');
const timelineEl = document.getElementById('timeline');
const exportDialog = document.getElementById('export-dialog');
const exportFolderPath = document.getElementById('export-folder-path');
const btnChooseExportFolder = document.getElementById('btn-choose-export-folder');
const exportCount = document.getElementById('export-count');
const exportStatus = document.getElementById('export-status');
const btnExportDialogCancel = document.getElementById('btn-export-dialog-cancel');
const btnStartExport = document.getElementById('btn-start-export');
const exportScopeInputs = [...document.querySelectorAll('input[name="export-scope"]')];
const exportProgress = document.getElementById('export-progress');
const exportOverallLabel = document.getElementById('export-overall-label');
const exportOverallProgress = document.getElementById('export-overall-progress');
const exportCurrentName = document.getElementById('export-current-name');
const exportCurrentPercent = document.getElementById('export-current-percent');
const exportClipProgress = document.getElementById('export-clip-progress');
const exportSummary = document.getElementById('export-summary');
const exportSummaryTitle = document.getElementById('export-summary-title');
const exportSummaryMessage = document.getElementById('export-summary-message');
const exportSuccessList = document.getElementById('export-success-list');
const exportFailureList = document.getElementById('export-failure-list');
const exportManifestLabel = document.getElementById('export-manifest-label');
const btnOpenExportFolder = document.getElementById('btn-open-export-folder');

// Shared selection state: index into DetectionState, or null.
// Timeline bars and panel cards both set it and both reflect it.
let selectedAppearance = null;

function setSelection(index) {
  selectedAppearance = index;
  Timeline.setSelected(index);
  Panel.setSelected(index);
  updateExportDialogState();
}

function isTextEntry(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest('textarea, [contenteditable="true"]')) return true;
  const input = target.closest('input');
  return input !== null && !['button', 'checkbox', 'radio', 'range', 'submit'].includes(input.type);
}

function deleteAppearance(index = selectedAppearance) {
  if (!Number.isInteger(index)) return false;

  const previousSelection = selectedAppearance;
  selectedAppearance = null;
  const result = DetectionState.updateDetections({ type: 'delete', index });
  if (!result.ok) {
    selectedAppearance = previousSelection;
    setSelection(previousSelection);
    return false;
  }

  setSelection(null);
  return true;
}

function restoreDeletedAppearance() {
  const result = DetectionState.updateDetections({ type: 'restore' });
  if (!result.ok) return false;

  setSelection(result.restoredIndex);
  Panel.focusFirstField(result.restoredIndex);
  return true;
}

function editAppearanceField(index, field, value) {
  return DetectionState.updateDetections({
    type: 'edit-field',
    index,
    field,
    value,
  });
}

function createAppearance(bounds) {
  const result = DetectionState.updateDetections({
    type: 'create',
    appearance: {
      start_s: bounds.start_s,
      end_s: bounds.end_s,
      car_number: '',
      subject: true,
      confidence: null,
      notes: '',
    },
  });
  if (!result.ok) return;

  const newIndex = result.detections.length - 1;
  setSelection(newIndex);
  Panel.focusFirstField(newIndex);
}

Timeline.init(
  {
    ruler: document.getElementById('timeline-ruler'),
    track: document.getElementById('timeline-track'),
    video: videoPlayer,
  },
  {
    onIntervalClick: (index) => setSelection(index),
    onEmptyTrackClick: () => setSelection(null),
    onDragPreview: (preview, index) => {
      Panel.render(preview);
      Panel.setSelected(index);
    },
    onDragCommit: (action, index) => {
      const result = DetectionState.updateDetections(action);
      if (!result.ok || !result.changed) {
        const detections = DetectionState.getDetections();
        Timeline.setDetections(detections);
        Panel.render(detections);
        setSelection(index);
      }
    },
    onCreateCommit: createAppearance,
    onDeleteRequest: deleteAppearance,
  }
);

Panel.init(
  {
    panel: document.getElementById('analysis-panel'),
    list: document.getElementById('panel-list'),
  },
  {
    onSelect: (index) => setSelection(index),
    onEdit: editAppearanceField,
    onDelete: deleteAppearance,
  }
);

DetectionState.subscribe(({ detections, dirty }) => {
  if (selectedAppearance !== null && selectedAppearance >= detections.length) {
    selectedAppearance = null;
  }
  Timeline.setDetections(detections);
  Panel.render(detections);
  Timeline.handleResize();
  setSelection(selectedAppearance);
  updateSaveButton(dirty);
  updateExportButton();
});

window.addEventListener('keydown', (e) => {
  if (exportDialog.open) return;

  if (e.key === 'Escape') {
    setSelection(null);
    return;
  }

  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z' && !isTextEntry(e.target)) {
    if (restoreDeletedAppearance()) e.preventDefault();
    return;
  }

  if (e.ctrlKey && e.key.toLowerCase() === 'x' && !isTextEntry(e.target)) {
    if (selectedAppearance !== null) {
      e.preventDefault();
      deleteAppearance();
    }
  }
}, true);

// Active project { name, path } and video { path, name, url }, null until chosen.
let currentProject = null;
let currentProjectFilePath = null;
let currentVideo = null;
let pendingDetections = null;
let saveInProgress = false;
let navigationInProgress = false;
let analysisNeedsSave = false;
let exportRunning = false;
let exportCancelRequested = false;
let exportDirectory = null;

function hasUnsavedWork() {
  return DetectionState.isDirty() || analysisNeedsSave;
}

function updateSaveButton(dirty = DetectionState.isDirty()) {
  btnSaveChanges.disabled = saveInProgress || !currentVideo || !(dirty || analysisNeedsSave);
}

function updateExportButton() {
  const hasDetections = DetectionState.getDetections().length > 0;
  btnExport.disabled = !currentVideo
    || !hasDetections
    || analysisRunning
    || exportRunning
    || navigationInProgress;
}

function updateAppControls() {
  const busy = navigationInProgress || analysisRunning || exportRunning;
  btnOpenVideo.disabled = busy;
  btnLoadProject.disabled = busy;
  btnBackToProjects.disabled = busy;
  btnDetectVehicles.disabled = !currentVideo || busy;
  updateExportButton();
}

function setNavigationInProgress(inProgress) {
  navigationInProgress = inProgress;
  updateAppControls();
}

async function resolveUnsavedChanges(destination) {
  if (!hasUnsavedWork()) return true;

  const action = await window.editorAPI.confirmUnsavedChanges(
    currentVideo?.name,
    destination
  );
  if (action === 'discard') return true;
  if (action !== 'save') return false;

  const saved = await saveCurrentProject();
  return saved && !hasUnsavedWork();
}

// Analysis run state
let analysisRunning = false;
let analysisStart = 0;
let elapsedTimer = null;

const STAGE_LABELS = {
  proxy: 'Creating proxy (1/5)',
  upload: 'Uploading (2/5)',
  processing: 'Processing (3/5)',
  analyzing: 'Analyzing (4/5)',
  parsing: 'Parsing results (5/5)',
};

// --- Landing: project picker ---

function validateProjectNameInput(value) {
  const name = value.trim();
  if (!name) return 'Enter a project name.';
  if (name === '.' || name === '..') return 'Choose a different project name.';
  if (name.length > 100) return 'Project names must be 100 characters or fewer.';
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    return 'Project names cannot contain < > : " / \\ | ? *.';
  }
  if (/[. ]$/.test(name)) return 'Project names cannot end with a period or space.';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    return 'That name is reserved by Windows.';
  }
  return null;
}

function showProjectNameError(message) {
  projectNameError.textContent = message || '';
  projectNameError.hidden = !message;
  projectNameInput.setAttribute('aria-invalid', String(Boolean(message)));
}

async function refreshProjectsRoot() {
  const projectsRoot = await window.editorAPI.getProjectsRoot();
  projectsRootPath.textContent = projectsRoot;
  projectsRootPath.title = projectsRoot;
}

async function refreshProjectGrid() {
  projectGrid.querySelectorAll('.project-tile-wrap').forEach((wrap) => wrap.remove());
  const projects = await window.editorAPI.listProjects();
  projectEmpty.hidden = projects.length > 0;

  for (const project of projects) {
    const wrap = document.createElement('div');
    wrap.className = 'project-tile-wrap';

    const tile = document.createElement('button');
    tile.className = 'project-tile';
    tile.title = project.path;
    tile.setAttribute('aria-label', `Open ${project.name}`);
    tile.addEventListener('click', () => enterEditor(project));

    const folderIcon = document.createElement('span');
    folderIcon.className = 'project-folder-icon';
    folderIcon.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'project-name';
    name.textContent = project.name;

    const projectPath = document.createElement('span');
    projectPath.className = 'project-path';
    projectPath.textContent = project.path;

    tile.appendChild(folderIcon);
    tile.appendChild(name);
    tile.appendChild(projectPath);

    const del = document.createElement('button');
    del.className = 'project-delete';
    del.textContent = '\u00d7';
    del.title = 'Remove from project list';
    del.setAttribute('aria-label', `Remove ${project.name} from project list`);
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const removed = await window.editorAPI.deleteProject(project.path);
      if (removed) refreshProjectGrid();
    });

    wrap.appendChild(tile);
    wrap.appendChild(del);
    projectGrid.appendChild(wrap);
  }
}

function enterEditor(project) {
  currentProject = project;
  viewLanding.hidden = true;
  viewEditor.hidden = false;
}

function exitToLanding() {
  if (analysisRunning) window.editorAPI.cancelAnalysis();
  if (exportDialog.open) exportDialog.close();
  endAnalysisRun();
  currentProject = null;
  currentProjectFilePath = null;
  currentVideo = null;
  pendingDetections = null;
  saveInProgress = false;
  analysisNeedsSave = false;
  exportRunning = false;
  exportCancelRequested = false;
  videoName.textContent = 'No Video Selected';
  videoPlayer.removeAttribute('src');
  videoPlayer.load();
  videoPlaceholder.textContent = 'Import a video to begin';
  videoPlaceholder.hidden = false;
  DetectionState.initialize([], 0);
  setSelection(null);
  timelineEl.hidden = true;
  Timeline.clear();
  Panel.clear();
  btnDetectVehicles.disabled = true;
  btnSaveChanges.disabled = true;
  btnExport.disabled = true;
  statusLine.hidden = true;
  viewEditor.hidden = true;
  viewLanding.hidden = false;
  refreshProjectGrid();
}

btnNewProject.addEventListener('click', () => {
  projectNameInput.value = '';
  showProjectNameError(null);
  createProjectDialog.showModal();
  projectNameInput.focus();
});

btnCreateProjectCancel.addEventListener('click', () => createProjectDialog.close());

createProjectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const validationError = validateProjectNameInput(projectNameInput.value);
  showProjectNameError(validationError);
  if (validationError) {
    projectNameInput.focus();
    return;
  }

  btnCreateProjectConfirm.disabled = true;
  btnCreateProjectCancel.disabled = true;
  try {
    const project = await window.editorAPI.createProject(projectNameInput.value.trim());
    if (!project) return;
    createProjectDialog.close();
    await refreshProjectGrid();
    enterEditor(project);
  } catch {
    showProjectNameError('Could not create the project.');
  } finally {
    btnCreateProjectConfirm.disabled = false;
    btnCreateProjectCancel.disabled = false;
  }
});

btnChangeProjectRoot.addEventListener('click', async () => {
  btnChangeProjectRoot.disabled = true;
  try {
    const projectsRoot = await window.editorAPI.chooseProjectsRoot();
    if (projectsRoot) {
      projectsRootPath.textContent = projectsRoot;
      projectsRootPath.title = projectsRoot;
    }
  } finally {
    btnChangeProjectRoot.disabled = false;
  }
});

btnBackToProjects.addEventListener('click', async () => {
  if (analysisRunning || exportRunning || navigationInProgress) return;
  setNavigationInProgress(true);
  try {
    if (await resolveUnsavedChanges('projects')) exitToLanding();
  } finally {
    setNavigationInProgress(false);
  }
});

refreshProjectsRoot();
refreshProjectGrid();

// --- Editor ---

function initializeDetectionsWhenReady() {
  if (!pendingDetections || !currentVideo || !Number.isFinite(videoPlayer.duration)) return;
  const detections = pendingDetections;
  pendingDetections = null;
  DetectionState.initialize(detections, videoPlayer.duration);
  setSelection(null);
}

// Shows `video` ({ path, name, url }) in the player and enables the buttons
// that need a loaded video.
function showVideo(video, options = {}) {
  currentVideo = video;
  currentProjectFilePath = options.projectFilePath || null;
  analysisNeedsSave = false;
  pendingDetections = Array.isArray(options.detections)
    ? options.detections
    : [];
  DetectionState.initialize([], 0);
  setSelection(null);
  videoName.textContent = video.name;
  videoPlayer.src = video.url;
  videoPlaceholder.hidden = true;
  updateAppControls();
  updateSaveButton(false);
}

videoPlayer.addEventListener('loadedmetadata', () => {
  if (!currentVideo) return;
  timelineEl.hidden = false;
  Timeline.setVideo(videoPlayer.duration);
  initializeDetectionsWhenReady();
});

window.addEventListener('resize', () => Timeline.handleResize());

btnOpenVideo.addEventListener('click', async () => {
  if (analysisRunning || exportRunning || navigationInProgress || !currentProject) return;
  setNavigationInProgress(true);
  try {
    if (!await resolveUnsavedChanges('video')) return;

    const previousStatus = {
      hidden: statusLine.hidden,
      stage: statusStage.textContent,
      elapsed: statusElapsed.textContent,
      tokens: statusTokens.textContent,
    };
    statusStage.textContent = 'Importing video into project...';
    statusElapsed.textContent = '';
    statusTokens.textContent = '';
    statusLine.hidden = false;

    const result = await window.editorAPI.openVideo(currentProject.path);
    if (!result) {
      statusLine.hidden = previousStatus.hidden;
      statusStage.textContent = previousStatus.stage;
      statusElapsed.textContent = previousStatus.elapsed;
      statusTokens.textContent = previousStatus.tokens;
      return;
    }

    showVideo(result);
    statusStage.textContent = `Imported ${result.name}`;
    statusElapsed.textContent = '';
    statusTokens.textContent = '';
    statusLine.hidden = false;
  } finally {
    setNavigationInProgress(false);
  }
});

// --- Project save/load (.vproj.json) ---

async function saveCurrentProject() {
  if (!currentVideo || !hasUnsavedWork() || saveInProgress) return false;

  const project = {
    version: 1,
    videoPath: currentVideo.path,
    videoDurationS: Number(videoPlayer.duration.toFixed(3)),
    detections: DetectionState.getDetections(),
    savedAt: new Date().toISOString(),
  };
  const savedState = JSON.stringify(project.detections);
  const savedVideoPath = currentVideo.path;
  saveInProgress = true;
  updateSaveButton();

  try {
    const savedPath = await window.editorAPI.saveProject({
      project,
      filePath: currentProjectFilePath,
      projectDirectory: currentProject ? currentProject.path : null,
    });
    if (!savedPath) return false;

    currentProjectFilePath = savedPath;
    const stateUnchanged = currentVideo
      && currentVideo.path === savedVideoPath
      && JSON.stringify(DetectionState.getDetections()) === savedState;
    if (stateUnchanged) {
      analysisNeedsSave = false;
      DetectionState.markClean();
      updateSaveButton();
    }
    statusStage.textContent = `Saved ${savedPath}`;
    statusElapsed.textContent = '';
    statusTokens.textContent = '';
    statusLine.hidden = false;
    return !hasUnsavedWork();
  } finally {
    saveInProgress = false;
    updateSaveButton();
  }
}

btnSaveChanges.addEventListener('click', saveCurrentProject);

btnLoadProject.addEventListener('click', async () => {
  if (analysisRunning || exportRunning || navigationInProgress) return;
  setNavigationInProgress(true);
  try {
    if (!await resolveUnsavedChanges('project')) return;
    const result = await window.editorAPI.loadProject();
    if (!result) return;
    const { project, videoUrl, filePath } = result;
    const name = project.videoPath.split(/[\\/]/).pop();
    showVideo(
      { path: project.videoPath, name, url: videoUrl },
      { detections: project.detections, projectFilePath: filePath }
    );
    statusStage.textContent = `Loaded project (${project.detections.length} detections)`;
    statusElapsed.textContent = '';
    statusTokens.textContent = '';
    statusLine.hidden = false;
  } finally {
    setNavigationInProgress(false);
  }
});

videoPlayer.addEventListener('error', () => {
  if (!currentVideo) return;
  videoPlaceholder.hidden = false;
  videoPlaceholder.textContent = `Could not play ${currentVideo.name}`;
});

// --- Clip export ---

function selectedExportScope() {
  return exportScopeInputs.find((input) => input.checked)?.value || 'selected';
}

function selectedExportIntervals() {
  return ExportScope.selectIntervals(
    DetectionState.getDetections(),
    selectedExportScope(),
    selectedAppearance
  );
}

function setExportStatus(message = '', kind = '') {
  exportStatus.textContent = message;
  exportStatus.hidden = message.length === 0;
  exportStatus.className = 'export-status';
  if (kind) exportStatus.classList.add(`export-status-${kind}`);
}

function resetExportRunView() {
  exportProgress.hidden = true;
  exportSummary.hidden = true;
  exportOverallLabel.textContent = '0 of 0 completed';
  exportOverallProgress.value = 0;
  exportCurrentName.textContent = 'Waiting for ffmpeg';
  exportCurrentPercent.textContent = '0%';
  exportClipProgress.value = 0;
  exportSummaryTitle.textContent = 'Export complete';
  exportSummaryMessage.textContent = '';
  exportSuccessList.replaceChildren();
  exportFailureList.replaceChildren();
  exportManifestLabel.textContent = '';
}

function appendExportSummaryItem(list, text, className = '') {
  const item = document.createElement('li');
  item.textContent = text;
  if (className) item.className = className;
  list.appendChild(item);
}

function renderExportSummary(result) {
  const succeeded = Array.isArray(result.succeeded) ? result.succeeded : [];
  const failed = Array.isArray(result.failed) ? result.failed : [];
  exportProgress.hidden = true;
  exportSummary.hidden = false;

  if (result.canceled) {
    exportSummaryTitle.textContent = 'Export canceled';
    exportSummaryMessage.textContent = `${succeeded.length} succeeded, ${failed.length} failed, ${result.skipped || 0} not attempted.`;
  } else if (failed.length > 0) {
    exportSummaryTitle.textContent = 'Export completed with errors';
    exportSummaryMessage.textContent = `${succeeded.length} succeeded and ${failed.length} failed.`;
  } else {
    exportSummaryTitle.textContent = 'Export complete';
    exportSummaryMessage.textContent = `${succeeded.length} clip${succeeded.length === 1 ? '' : 's'} exported.`;
  }

  exportSuccessList.replaceChildren();
  exportFailureList.replaceChildren();
  if (succeeded.length === 0) {
    appendExportSummaryItem(exportSuccessList, 'None', 'export-summary-empty');
  } else {
    succeeded.forEach((clip) => appendExportSummaryItem(exportSuccessList, clip.filename));
  }
  if (failed.length === 0) {
    appendExportSummaryItem(exportFailureList, 'None', 'export-summary-empty');
  } else {
    failed.forEach((failure) => {
      appendExportSummaryItem(exportFailureList, `${failure.filename}: ${failure.error}`);
    });
  }

  exportManifestLabel.textContent = result.manifestPath
    ? 'Manifest: export_manifest.json'
    : 'Manifest unavailable';
  btnOpenExportFolder.disabled = !exportDirectory;
}

function updateExportDialogState() {
  const intervals = selectedExportIntervals();
  const clipCount = intervals.length;
  exportCount.textContent = `${clipCount} clip${clipCount === 1 ? '' : 's'}`;
  exportFolderPath.value = exportDirectory || '';
  exportFolderPath.placeholder = exportDirectory ? '' : 'No folder selected';
  exportScopeInputs.forEach((input) => { input.disabled = exportRunning; });
  btnChooseExportFolder.disabled = exportRunning;
  btnStartExport.disabled = exportRunning || !exportDirectory || clipCount === 0;
  btnExportDialogCancel.disabled = exportRunning && exportCancelRequested;
  btnOpenExportFolder.disabled = exportRunning || !exportDirectory;
  if (exportRunning) {
    btnExportDialogCancel.textContent = exportCancelRequested ? 'Canceling...' : 'Cancel';
  }
}

btnExport.addEventListener('click', () => {
  if (btnExport.disabled) return;
  exportCancelRequested = false;
  setExportStatus();
  resetExportRunView();
  btnExportDialogCancel.textContent = 'Cancel';
  updateExportDialogState();
  exportDialog.showModal();
});

exportScopeInputs.forEach((input) => {
  input.addEventListener('change', updateExportDialogState);
});

btnChooseExportFolder.addEventListener('click', async () => {
  if (exportRunning) return;
  const folder = await window.editorAPI.chooseExportFolder(exportDirectory);
  if (!folder) return;
  exportDirectory = folder;
  updateExportDialogState();
});

btnExportDialogCancel.addEventListener('click', () => {
  if (!exportRunning) {
    exportDialog.close();
    return;
  }
  if (exportCancelRequested) return;
  exportCancelRequested = true;
  setExportStatus('Canceling export...');
  window.editorAPI.cancelExport();
  updateExportDialogState();
});

btnOpenExportFolder.addEventListener('click', async () => {
  if (!exportDirectory || exportRunning) return;
  const result = await window.editorAPI.openExportFolder(exportDirectory);
  if (!result?.ok) setExportStatus(result?.error || 'Could not open the export folder.', 'error');
});

exportDialog.addEventListener('cancel', (event) => {
  if (exportRunning) event.preventDefault();
});

window.editorAPI.onExportEvent((event) => {
  if (!exportRunning || !event || typeof event !== 'object') return;
  if (event.event === 'start') {
    exportProgress.hidden = false;
    exportOverallLabel.textContent = `0 of ${event.total} completed`;
    exportOverallProgress.value = 0;
  } else if (event.event === 'clip-start') {
    exportCurrentName.textContent = event.filename;
    exportCurrentPercent.textContent = '0%';
    exportClipProgress.value = 0;
    exportOverallLabel.textContent = `${event.completed} of ${event.total} completed`;
  } else if (event.event === 'progress') {
    const clipFraction = Math.max(0, Math.min(1, Number(event.clipFraction) || 0));
    const overallFraction = Math.max(0, Math.min(1, Number(event.overallFraction) || 0));
    exportClipProgress.value = clipFraction;
    exportOverallProgress.value = overallFraction;
    exportCurrentPercent.textContent = `${Math.round(clipFraction * 100)}%`;
  } else if (event.event === 'clip-success') {
    exportClipProgress.value = 1;
    exportCurrentPercent.textContent = '100%';
    exportOverallProgress.value = event.completed / event.total;
    exportOverallLabel.textContent = `${event.completed} of ${event.total} completed`;
  } else if (event.event === 'clip-failure') {
    exportOverallProgress.value = event.completed / event.total;
    exportOverallLabel.textContent = `${event.completed} of ${event.total} completed`;
    setExportStatus(`Failed ${event.filename}; continuing...`, 'warning');
  } else if (event.event === 'canceling') {
    setExportStatus('Canceling export...');
  } else if (event.event === 'complete') {
    exportOverallProgress.value = event.completed / event.total;
    exportOverallLabel.textContent = `${event.completed} of ${event.total} completed`;
    setExportStatus('Writing export manifest...');
  }
});

btnStartExport.addEventListener('click', async () => {
  const intervals = selectedExportIntervals();
  if (!currentVideo || !exportDirectory || intervals.length === 0 || exportRunning) return;

  exportRunning = true;
  exportCancelRequested = false;
  resetExportRunView();
  exportProgress.hidden = false;
  exportOverallLabel.textContent = `0 of ${intervals.length} completed`;
  setExportStatus(`Exporting ${intervals.length} clip${intervals.length === 1 ? '' : 's'}...`);
  updateExportDialogState();
  updateAppControls();

  let result;
  try {
    result = await window.editorAPI.exportClips({
      videoPath: currentVideo.path,
      outputDirectory: exportDirectory,
      intervals,
    });
  } catch (error) {
    result = { ok: false, error: error.message };
  } finally {
    exportRunning = false;
    exportCancelRequested = false;
    updateAppControls();
    updateExportDialogState();
  }

  if (Array.isArray(result?.succeeded) && Array.isArray(result?.failed)) {
    renderExportSummary(result);
  } else {
    exportProgress.hidden = true;
  }

  if (result?.ok) {
    if (result.canceled) {
      setExportStatus('Export canceled');
    } else if (result.failed.length > 0) {
      setExportStatus('Export completed with errors', 'warning');
    } else {
      setExportStatus('Export complete', 'success');
    }
  } else {
    setExportStatus(result?.error || 'Clip export failed.', 'error');
  }
  btnExportDialogCancel.textContent = 'Close';
});
// --- Analysis run ---

// Stops the timer and restores idle button states; leaves the status line
// alone so callers decide what it shows afterwards.
function endAnalysisRun() {
  analysisRunning = false;
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  btnCancel.hidden = true;
  updateAppControls();
}

btnDetectVehicles.addEventListener('click', async () => {
  if (!currentVideo || analysisRunning || exportRunning) return;
  const started = await window.editorAPI.startAnalysis(currentVideo.path);
  if (!started) return;

  analysisRunning = true;
  analysisStart = Date.now();
  statusStage.textContent = 'Starting…';
  statusElapsed.textContent = '0.0s';
  statusTokens.textContent = '';
  statusLine.hidden = false;
  btnCancel.hidden = false;
  updateAppControls();
  elapsedTimer = setInterval(() => {
    statusElapsed.textContent = `${((Date.now() - analysisStart) / 1000).toFixed(1)}s`;
  }, 100);
});

btnCancel.addEventListener('click', () => {
  window.editorAPI.cancelAnalysis();
});

async function completeAnalysis(evt) {
  endAnalysisRun();

  if (!evt.resultsPath) {
    statusStage.textContent = 'Analysis complete';
    return;
  }

  if (!await resolveUnsavedChanges('analysis')) {
    await window.editorAPI.discardAnalysisResults();
    statusStage.textContent = 'Analysis complete; existing detections kept';
    return;
  }

  const results = await window.editorAPI.loadAnalysisResults();
  if (!results || !Array.isArray(results.detections)) {
    statusStage.textContent = 'Analysis results unavailable';
    return;
  }

  DetectionState.initialize(results.detections, videoPlayer.duration, { dirty: false });
  analysisNeedsSave = true;
  setSelection(null);
  updateSaveButton();
  statusStage.textContent = `Analysis complete (${results.detections.length} detections)`;
}

window.editorAPI.onAnalysisEvent((evt) => {
  if (!analysisRunning) return;

  if (evt.event === 'start' && evt.stage) {
    statusStage.textContent = STAGE_LABELS[evt.stage] || evt.stage;
  } else if (evt.event === 'token') {
    const tokenCount = Number.isFinite(evt.outputTokens) ? evt.outputTokens : evt.count;
    if (Number.isFinite(tokenCount)) statusTokens.textContent = `${tokenCount} tokens`;
  } else if (evt.event === 'retry') {
    const delay = Number.isFinite(evt.delayS) ? Math.ceil(evt.delayS) : null;
    statusStage.textContent = evt.statusCode === 429
      ? 'Gemini rate limited; waiting to retry'
      : 'Gemini temporarily unavailable; waiting to retry';
    statusTokens.textContent = delay === null
      ? `Attempt ${evt.attempt}/${evt.maxAttempts}`
      : `Retry in ${delay}s - attempt ${evt.attempt}/${evt.maxAttempts}`;
  } else if (evt.event === 'retry_start') {
    statusStage.textContent = `Analyzing - attempt ${evt.attempt}/${evt.maxAttempts}`;
    statusTokens.textContent = '';
  } else if (evt.event === 'rate_limit') {
    const delay = Number.isFinite(evt.delayS) ? Math.ceil(evt.delayS) : null;
    statusStage.textContent = 'Waiting for Gemini request limit';
    statusTokens.textContent = delay === null ? '' : `Continuing in ${delay}s`;
  } else if (evt.event === 'done') {
    void completeAnalysis(evt);
  } else if (evt.event === 'canceled') {
    endAnalysisRun();
    statusLine.hidden = true;
  } else if (evt.event === 'error') {
    // The main process shows the error dialog; just restore the UI.
    endAnalysisRun();
    statusLine.hidden = true;
  }
});
