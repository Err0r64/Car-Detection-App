'use strict';

// Landing view
const viewLanding = document.getElementById('view-landing');
const projectGrid = document.getElementById('project-grid');
const btnNewProject = document.getElementById('btn-new-project');

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

// Shared selection state: index into DetectionState, or null.
// Timeline bars and panel cards both set it and both reflect it.
let selectedAppearance = null;

function setSelection(index) {
  selectedAppearance = index;
  Timeline.setSelected(index);
  Panel.setSelected(index);
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
  }
);

DetectionState.subscribe(({ detections }) => {
  if (selectedAppearance !== null && selectedAppearance >= detections.length) {
    selectedAppearance = null;
  }
  Timeline.setDetections(detections);
  Panel.render(detections);
  Timeline.handleResize();
  setSelection(selectedAppearance);
});

window.addEventListener('keydown', (e) => {
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
let currentVideo = null;
let fixtureAppearances = null;

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

async function refreshProjectGrid() {
  projectGrid.querySelectorAll('.project-tile-wrap').forEach((wrap) => wrap.remove());
  const projects = await window.editorAPI.listProjects();
  for (const project of projects) {
    const wrap = document.createElement('div');
    wrap.className = 'project-tile-wrap';

    const tile = document.createElement('button');
    tile.className = 'project-tile';
    tile.textContent = project.name;
    tile.title = project.path;
    tile.addEventListener('click', () => enterEditor(project));

    const del = document.createElement('button');
    del.className = 'project-delete';
    del.textContent = '✕';
    del.title = 'Remove from project list';
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
  endAnalysisRun();
  currentProject = null;
  currentVideo = null;
  videoName.textContent = 'No Video Selected';
  videoPlayer.removeAttribute('src');
  videoPlayer.load();
  videoPlaceholder.textContent = 'Open a video to begin';
  videoPlaceholder.hidden = false;
  fixtureAppearances = null;
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

btnNewProject.addEventListener('click', async () => {
  const project = await window.editorAPI.createProject();
  if (project) enterEditor(project);
});

btnBackToProjects.addEventListener('click', exitToLanding);

refreshProjectGrid();

// --- Editor ---

// TEMP Phase 3: replaced by real pipeline in Phase 5 — fixture data stands in
// for analysis output. All times in the fixture are integer seconds.
function initializeFixtureWhenReady() {
  if (!currentVideo || !fixtureAppearances || !Number.isFinite(videoPlayer.duration)) return;
  DetectionState.initialize(fixtureAppearances, videoPlayer.duration);
  setSelection(null);
}

async function loadFixtureDetections() {
  try {
    const res = await fetch('../fixtures/sample_detections.json');
    const fixture = await res.json();
    fixtureAppearances = fixture.appearances || [];
  } catch (err) {
    console.error('Failed to load fixture detections:', err);
    fixtureAppearances = [];
  }
  initializeFixtureWhenReady();
}

// Shows `video` ({ path, name, url }) in the player and enables the buttons
// that need a loaded video.
function showVideo(video) {
  currentVideo = video;
  fixtureAppearances = null;
  DetectionState.initialize([], 0);
  setSelection(null);
  videoName.textContent = video.name;
  videoPlayer.src = video.url;
  videoPlaceholder.hidden = true;
  btnDetectVehicles.disabled = false;
  btnSaveChanges.disabled = false;
  loadFixtureDetections();
}

videoPlayer.addEventListener('loadedmetadata', () => {
  if (!currentVideo) return;
  timelineEl.hidden = false;
  Timeline.setVideo(videoPlayer.duration);
  initializeFixtureWhenReady();
});

window.addEventListener('resize', () => Timeline.handleResize());

btnOpenVideo.addEventListener('click', async () => {
  const result = await window.editorAPI.openVideo();
  if (result) showVideo(result);
});

// --- Project save/load (placeholder project object) ---

btnSaveChanges.addEventListener('click', async () => {
  const projectObj = {
    videoPath: currentVideo ? currentVideo.path : null,
    detections: [],
    edits: {},
  };
  const savedPath = await window.editorAPI.saveProject(projectObj);
  if (savedPath) {
    statusStage.textContent = `Saved ${savedPath}`;
    statusElapsed.textContent = '';
    statusTokens.textContent = '';
    statusLine.hidden = false;
  }
});

btnLoadProject.addEventListener('click', async () => {
  if (analysisRunning) return;
  const result = await window.editorAPI.loadProject();
  if (!result) return;
  const { project, videoUrl } = result;
  if (project.videoPath && videoUrl) {
    const name = project.videoPath.split(/[\\/]/).pop();
    showVideo({ path: project.videoPath, name, url: videoUrl });
  }
  statusStage.textContent = `Loaded project (${(project.detections || []).length} detections)`;
  statusElapsed.textContent = '';
  statusTokens.textContent = '';
  statusLine.hidden = false;
});

videoPlayer.addEventListener('error', () => {
  if (!currentVideo) return;
  videoPlaceholder.hidden = false;
  videoPlaceholder.textContent = `Could not play ${currentVideo.name}`;
});

// --- Stubbed analysis run ---

// Stops the timer and restores idle button states; leaves the status line
// alone so callers decide what it shows afterwards.
function endAnalysisRun() {
  analysisRunning = false;
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  btnCancel.hidden = true;
  btnOpenVideo.disabled = false;
  btnDetectVehicles.disabled = !currentVideo;
}

btnDetectVehicles.addEventListener('click', async () => {
  if (!currentVideo || analysisRunning) return;
  const started = await window.editorAPI.startAnalysis(currentVideo.path);
  if (!started) return;

  analysisRunning = true;
  analysisStart = Date.now();
  statusStage.textContent = 'Starting…';
  statusElapsed.textContent = '0.0s';
  statusTokens.textContent = '';
  statusLine.hidden = false;
  btnCancel.hidden = false;
  btnDetectVehicles.disabled = true;
  btnOpenVideo.disabled = true;
  elapsedTimer = setInterval(() => {
    statusElapsed.textContent = `${((Date.now() - analysisStart) / 1000).toFixed(1)}s`;
  }, 100);
});

btnCancel.addEventListener('click', () => {
  window.editorAPI.cancelAnalysis();
});

window.editorAPI.onAnalysisEvent((evt) => {
  if (!analysisRunning) return;

  if (evt.event === 'start' && evt.stage) {
    statusStage.textContent = STAGE_LABELS[evt.stage] || evt.stage;
  } else if (evt.event === 'token') {
    statusTokens.textContent = `${evt.count} tokens`;
  } else if (evt.event === 'done') {
    endAnalysisRun();
    statusStage.textContent = 'Analysis complete';
  } else if (evt.event === 'canceled') {
    endAnalysisRun();
    statusLine.hidden = true;
  } else if (evt.event === 'error') {
    // The main process shows the error dialog; just restore the UI.
    endAnalysisRun();
    statusLine.hidden = true;
  }
});
