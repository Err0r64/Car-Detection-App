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

// Active project { name, path } and video { path, name }, null until chosen.
let currentProject = null;
let currentVideo = null;

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
