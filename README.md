# Capstone Video Editor (Phase 2 scaffold)

Desktop review-and-cut editor for AI-assisted motorsports video indexing (sponsor: Apexiel).
Plain Electron + vanilla JS — no bundler, no framework. This phase ships the app shell,
project picker, video playback, and a **stubbed** analysis pipeline; the real Gemini/ffmpeg
pipeline arrives in later phases.

## Prerequisites

- **Node.js LTS** (includes npm)
- **Python 3** on PATH (the stubbed analysis pipeline spawns `python`)

## Run

```
npm install
npm start
```

## Using the app

1. **Landing screen** — click **New Project** and pick (or create) a project folder, or click
   an existing project tile. The ✕ on a tile removes it from the list only; nothing on disk
   is deleted. The project list is stored in Electron's userData folder (`projects.json`).
2. **Editor** — click **Open Video** and pick an mp4/mov. The video plays with native
   controls and **Detect Vehicles** / **Save Changes** enable.
3. **Fake analysis flow** — click **Detect Vehicles**. The app spawns
   `stub/fake_analysis.py`, which emits the five pipeline stages (`proxy`, `upload`,
   `processing`, `analyzing`, `parsing`) as JSON lines on stdout (~2s per stage, live token
   counts during `analyzing`). The status line shows the current stage, an elapsed timer,
   token count, and a **Cancel** button that kills the child process.
   - To test the failure path, launch with the env var `FAKE_ANALYSIS_FAIL=1`
     (PowerShell: `$env:FAKE_ANALYSIS_FAIL=1; npm start`) — the stub exits nonzero
     mid-run and the app shows an error dialog.
4. **Save / load** — **Save Changes** writes a `.vproj.json` project file (placeholder
   contents for now: `{ videoPath, detections: [], edits: {} }`); **Load Project** reads one
   back and restores the video.

## Layout

- `main.js` — Electron main process: window, dialogs, project registry, stub spawning/relay
- `preload.js` — `contextBridge` IPC surface (`window.editorAPI`); the renderer has no Node access
- `renderer/` — vanilla HTML/CSS/JS UI (landing + editor views)
- `stub/fake_analysis.py` — fake analysis pipeline used by Detect Vehicles
