# Capstone Video Editor

Desktop review-and-cut editor for AI-assisted motorsports video indexing, sponsored by Apexiel. The application uses Electron and vanilla JavaScript with no frontend framework or bundler.

Phase 2 established the secure Electron shell, project picker, local video playback, and stubbed analysis process. Phase 3 CP1-CP4 added the fit-to-width timeline, seeking, detection intervals, and synchronized Analysis panel. Phase 4 CP1-CP4 add interval editing, creation/deletion with deletion undo, editable appearance metadata, dirty tracking, and real project persistence. Timeline zoom and horizontal scrolling (Phase 3 CP5) are intentionally deferred.

## Prerequisites

- Node.js LTS, including npm
- Python 3 available as `python` on `PATH`

The Python requirement currently supports the stubbed analysis pipeline. The real Gemini and ffmpeg pipeline will replace it in a later phase.

## Run

```powershell
npm install
npm start
```

## Application Flow

1. On the project selection screen, choose **New Project** and select a project folder, or open an existing project tile.
2. To remove a tile, use its delete control. This only unregisters the project from the landing screen; it does not delete the project folder or any files on disk.
3. In the editor, select **Open Video** and choose an MP4 or MOV file. The filename, native video controls, analysis panel, and timeline appear after the video metadata loads.
4. Select **Projects** to unload the current video and return to project selection.

The project registry is stored as `projects.json` in Electron's user data directory.

## Stubbed Analysis

Select **Detect Vehicles** to start `stub/fake_analysis.py`. The process emits JSON Lines events for five simulated stages:

1. `proxy`
2. `upload`
3. `processing`
4. `analyzing`
5. `parsing`

The editor displays the current stage, elapsed time, live token count during analysis, and a **Cancel** control. Canceling terminates the Python child process.

To test the visible failure path in PowerShell:

```powershell
$env:FAKE_ANALYSIS_FAIL = '1'
npm start
Remove-Item Env:FAKE_ANALYSIS_FAIL
```

## Timeline Core

After a video loads, the editor displays a fit-to-width timeline beneath the player:

- The ruler uses one shared time-to-pixel mapping and selects readable tick spacing for the available width.
- A white playhead follows video playback.
- Clicking empty track space seeks to that time and clears the current selection.
- Pressing and dragging across the track scrubs the video.
- Detection appearances render as intervals positioned from `start_s` to `end_s`.
- Drag either interval edge to change one bound, or drag the interval body to move both bounds while preserving its length.
- Drag empty track space to create an appearance. Use `Ctrl+X` or the interval context menu to delete the selection; `Ctrl+Z` restores recently deleted intervals when focus is outside a text field.
- Overlapping intervals use separate lanes so each remains selectable.
- Confidence colors use one shared mapping: green at 0.85 or higher, amber from 0.60 through 0.84, and red below 0.60.
- Non-subject appearances use a distinct hatched and dashed treatment.

Timeline zoom and horizontal scrolling are not implemented yet; that work is deferred from Phase 3 CP5.

## Analysis Panel

The Analysis panel lists each appearance in chronological order. Start, end, car number, vehicle description, and subject status are editable; confidence remains read-only.

- Start and end use `MM:SS`, validate against the video duration, and update the timeline immediately.
- Vehicle Description has an expand control for multiline editing in a larger dialog.
- Selecting a timeline interval highlights the matching panel card.
- Selecting a panel card highlights the matching timeline interval and scrolls the card into view.
- Only one appearance can be selected at a time.
- Click empty timeline space or press `Escape` to clear the selection.

## Temporary Detection Fixture

Phase 3 uses `fixtures/sample_detections.json` as temporary renderer-side analysis output. The renderer fetches this file after a video is opened and passes its `appearances` array to the timeline and Analysis panel.

The fixture deliberately includes:

- Five appearances with integer-second boundaries
- Confidence values covering all three color buckets
- One non-subject appearance
- One overlapping pair for lane testing

This pathway is marked temporary in `renderer/app.js` and is scheduled to be replaced by real pipeline output in Phase 5. Editing the fixture and reopening the video is the current way to test alternate detection data.

## Project Save and Load

**Save Changes** is disabled after loading and enables after the first successful edit. The first save opens a native save dialog; later saves silently overwrite that selected `.vproj.json` file. A successful save marks the detection state clean and disables the button again. Saving writes metadata only and never modifies the referenced video.

**Load Project** validates the project file, verifies that its video still exists, reopens that video, restores all detections, and starts with a clean state. Project files use this versioned format:

```json
{
  "version": 1,
  "videoPath": "C:\\path\\to\\video.mp4",
  "videoDurationS": 114,
  "detections": [
    {
      "car_number": "27/72",
      "start_s": 8,
      "end_s": 22,
      "subject": true,
      "confidence": 0.93,
      "notes": "Red car entering from camera left"
    }
  ],
  "savedAt": "2026-07-22T05:31:14.084Z"
}
```

The isolated preload API exposes `saveProject({ project, filePath, projectDirectory })` and `loadProject()`. `filePath` is null for the first save and is reused for silent overwrite; a successful load returns `{ project, filePath, videoUrl }`. The Open Video unsaved-changes prompt is scheduled for Phase 4 CP5.

## Project Layout

- `main.js` - Electron main process, native dialogs, project registry, child-process lifecycle, and IPC handlers
- `preload.js` - isolated `contextBridge` API exposed as `window.editorAPI`
- `renderer/index.html` - project selection and editor markup
- `renderer/app.js` - renderer application state and view coordination
- `renderer/timeline.js` - ruler, time mapping, playhead, seeking, interval layout, and timeline selection
- `renderer/panel.js` - Analysis panel rendering and selection state
- `renderer/style.css` - application, timeline, and panel styles
- `fixtures/sample_detections.json` - temporary Phase 3 detection data
- `stub/fake_analysis.py` - simulated analysis pipeline

The renderer has no direct Node.js access; privileged operations remain behind the preload IPC boundary.
