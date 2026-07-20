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
const btnCancel = document.getElementById('btn-cancel');
const videoName = document.getElementById('video-name');
const videoPlayer = document.getElementById('video-player');
const videoPlaceholder = document.getElementById('video-placeholder');
const statusLine = document.getElementById('status-line');
const statusStage = document.getElementById('status-stage');
const statusElapsed = document.getElementById('status-elapsed');
const statusTokens = document.getElementById('status-tokens');

// Active project { name, path } and video { path, name, url }, null until chosen.
let currentProject = null;
let currentVideo = null;

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

btnOpenVideo.addEventListener('click', async () => {
  const result = await window.editorAPI.openVideo();
  if (!result) return;
  currentVideo = result;
  videoName.textContent = result.name;
  videoPlayer.src = result.url;
  videoPlaceholder.hidden = true;
  btnDetectVehicles.disabled = false;
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
