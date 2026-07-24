# Capstone Video Editor

Desktop review-and-cut editor for AI-assisted motorsports video indexing, sponsored by Apexiel. The application uses Electron and vanilla JavaScript with no frontend framework or bundler.

Phase 2 established the secure Electron shell, project picker, local video playback, and stubbed analysis process. Phase 3 CP1-CP4 added the fit-to-width timeline, seeking, detection intervals, and synchronized Analysis panel. Phase 4 adds interval editing, creation/deletion with deletion undo, editable appearance metadata, dirty tracking, real project persistence, and unsaved-change protection when opening another video. Phase 5 CP1-CP3 adds the standalone CFR proxy and Gemini pipeline plus real Electron integration. Timeline zoom and horizontal scrolling (Phase 3 CP5) are intentionally deferred.

## Prerequisites

- Node.js LTS, including npm
- Python 3 available as `python` on `PATH`
- `ffmpeg` and `ffprobe` available on `PATH`
- `GEMINI_API_KEY` in the environment for real analysis
- Pipeline packages installed with `python -m pip install -r pipeline\requirements.txt`

Detect Vehicles uses the real pipeline by default. Start Electron from the same shell that contains `GEMINI_API_KEY` so the child process inherits it.

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

## Stubbed (Mock) Analysis

Set `useDevStub` to `true` in `config.json`, then select **Detect Vehicles** to run `stub/fake_analysis.py` without an API key or network access. The process emits JSON Lines events for five simulated stages:

1. `proxy`
2. `upload`
3. `processing`
4. `analyzing`
5. `parsing`

The editor displays the current stage, elapsed time, live token count during analysis, and a **Cancel** control. Canceling terminates the Python child process. On success, the stub writes one schema-valid canned detection and exercises the same result-loading path as real analysis.

To test the simulated failure path, keep `useDevStub` set to `true` and run:

```powershell
$env:FAKE_ANALYSIS_FAIL = '1'
npm start
Remove-Item Env:FAKE_ANALYSIS_FAIL
```
Restore `useDevStub` to `false` before testing or using real analysis.

## Real Analysis Pipeline

Phase 5 CP2 provides the full standalone pipeline. Set the API key in the current PowerShell session and run it against a short CFR sample:

```powershell
$env:GEMINI_API_KEY = 'your-key-from-Google-AI-Studio'
python pipeline/analyze.py `
  --video "C:\path\to\input.mov" `
  --out "C:\path\to\results.json"
```

The command writes `results.proxy.mp4`, uploads it through the Gemini Files API, waits for processing, submits one blocking Gemini 3.6 Flash request, stores the raw response under a sibling `raw` directory, preserves timestamps as fractional seconds, validates the final data against `detections.schema.json`, and atomically writes `results.json`. The proxy uses CRF 23, a maximum height of 720 pixels, and the source frame cadence. The pipeline rejects variable-frame-rate sources and source/proxy duration differences greater than 0.5 seconds.

The request uses seed 0, 1 FPS Gemini sampling, medium media resolution, and an explicit JSON response schema. Sampling parameters such as temperature are omitted for Gemini 3.6 Flash. The duration-aware prompt in `pipeline/gemini_harness/prompts.py` uses the validated research response contract and tells the model not to extend appearances through absent footage, carry identities into later intervals, or create duplicate entries for one visible car. A fixed seed is best-effort reproducibility; Gemini can still interpret the same video differently across separate API calls.

Bounds are clamped to the source duration. Intervals that collapse to zero length only because they lie outside the source are omitted, while model-provided zero-length or reversed intervals remain parsing errors. MM:SS strings are accepted at the model boundary; when both bounds exceed the clip duration, a valid concatenated MMSS pair such as `115-137` is narrowly recovered as `75-97` before validation. Rich response fields map directly to the application: `is_target_vehicle` becomes `subject`, `vehicle_description` becomes `notes`, and `detection_confidence` is retained.

Gemini calls are limited to five requests per rolling minute by default and are spaced at least 12 seconds apart. Request history is shared across Electron analysis subprocesses through `gemini-rate-limit.json` in the application user-data directory. Transient `429`, `500`, `502`, `503`, and `504` responses are retried up to five total attempts using server-provided delays or exponential backoff with jitter. The analyzing status reports rate-limit and retry waits. Set `HARNESS_RPM`, `GEMINI_MIN_REQUEST_INTERVAL_S`, or `GEMINI_MAX_ATTEMPTS` before starting Electron to tune these safeguards.

Stdout is reserved for flushed JSONL protocol events across `proxy`, `upload`, `processing`, `analyzing`, and `parsing`; diagnostics are written only to stderr. `GEMINI_API_KEY` is read only from the environment. Use `--dry-run` to exercise every stage with a canned model response and no key, network request, or API cost.

### CP2 terminal verification

Create a 15-second CFR sample from the supplied MOV, then verify the complete local wiring without API usage:

```powershell
New-Item -ItemType Directory -Force -Path .\cp2-manual | Out-Null
$source = 'C:\Users\epics.BLIPBWEEPBWOOP\Downloads\GX010094_stabilized_resized.mov'
ffmpeg -hide_banner -loglevel error -y `
  -i $source -t 15 -map 0:v:0 -an `
  -c:v libx264 -preset veryfast -crf 23 -fps_mode cfr `
  ".\cp2-manual\short-cfr-video.mp4"

python pipeline/analyze.py `
  --video ".\cp2-manual\short-cfr-video.mp4" `
  --out ".\cp2-manual\dry-results.json" `
  --dry-run |
  Tee-Object -FilePath ".\cp2-manual\dry-stdout.jsonl"
$LASTEXITCODE
```

Then run the real request using the same short video:

```powershell
New-Item -ItemType Directory -Force -Path .\cp2-manual | Out-Null
if (-not (Test-Path ".\cp2-manual\short-cfr-video.mp4")) {
  throw "Prepare the short CFR sample using the preceding block first."
}
$env:GEMINI_API_KEY = 'your-key-from-Google-AI-Studio'
python pipeline/analyze.py `
  --video ".\cp2-manual\short-cfr-video.mp4" `
  --out ".\cp2-manual\results.json" |
  Tee-Object -FilePath ".\cp2-manual\stdout.jsonl"
$LASTEXITCODE
```

Both commands should exit with `$LASTEXITCODE` equal to `0`. Verify the captured stdout and result contract:

```powershell
$events = Get-Content ".\cp2-manual\stdout.jsonl" | ForEach-Object { $_ | ConvertFrom-Json }
$events.stage | Sort-Object -Unique
$events | Where-Object { $_.stage -eq 'analyzing' -and $_.event -eq 'token' }
$events[-1]

$result = Get-Content ".\cp2-manual\results.json" -Raw | ConvertFrom-Json
$result.detections | Format-Table car_number,start_s,end_s,subject,confidence,notes
$result.detections | Where-Object {
  $_.start_s -lt 0 -or $_.start_s -ge $_.end_s
}

python -c "import json; from pathlib import Path; from jsonschema import Draft202012Validator; schema=json.loads(Path('detections.schema.json').read_text()); data=json.loads(Path('cp2-manual/results.json').read_text()); Draft202012Validator(schema).validate(data); print('schema valid')"
Get-ChildItem ".\cp2-manual\raw" -Filter '*.txt'
```

The unique stages should be `analyzing`, `parsing`, `processing`, `proxy`, and `upload`; at least one token event should print; the final event should be `parsing/done` with the absolute results path. The invalid-bounds command should print no rows, schema validation should print `schema valid`, and the raw directory should contain the saved model response. Because only stdout is piped to `Tee-Object`, diagnostics remain on stderr and cannot contaminate the captured JSONL file.

## Application Analysis Configuration

`config.json` controls the main-process child command:

```json
{
  "pythonPath": "python",
  "analyzeScript": "pipeline/analyze.py",
  "ffmpegPath": "ffmpeg",
  "useDevStub": false
}
```

Relative `analyzeScript` paths resolve from the application root. Real mode fails before spawning when `GEMINI_API_KEY` is absent. The preload exposes a result loader with no path argument; the renderer can only load the schema-validated result path recorded from the active analysis process.

### CP3 application verification

Launch Electron from the PowerShell session containing the API key:

```powershell
$env:GEMINI_API_KEY = 'your-key-from-Google-AI-Studio'
npm start
```

1. Open or create a project, select **Open Video**, and choose `cp2-manual\short-cfr-video.mp4`.
2. Select **Detect Vehicles**. The status should advance through Creating proxy, Uploading, Processing, Analyzing, and Parsing results; Analyzing should show a token count.
3. On completion, real detections should replace the fixture data in both the timeline and Analysis panel. The status should report the detection count, and **Save Changes** should be enabled.
4. Select **Save Changes**, choose a `.vproj.json` path if prompted, then use **Load Project** to confirm the same detections return.
5. Edit one detection, run **Detect Vehicles** again, and wait for completion. The overwrite prompt should offer **Save**, **Discard**, and **Cancel**. Cancel keeps the edited detections; Discard replaces them with the new model results; Save writes the current detections before replacement.

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

- Start and end use `MM:SS` or `MM:SS.sss`, validate against the exact video duration, and update the timeline immediately.
- Vehicle Description has an expand control for multiline editing in a larger dialog.
- Selecting a timeline interval highlights the matching panel card.
- Selecting a panel card highlights the matching timeline interval and scrolls the card into view.
- Only one appearance can be selected at a time.
- Click empty timeline space or press `Escape` to clear the selection.

## Temporary Detection Fixture

Phase 3 uses `fixtures/sample_detections.json` as temporary renderer-side analysis output. The renderer fetches this file after a video is opened and passes its `appearances` array to the timeline and Analysis panel.

The fixture deliberately includes:

- Five appearances, including fractional-second boundaries
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
  "videoDurationS": 114.933,
  "detections": [
    {
      "car_number": "27/72",
      "start_s": 8.25,
      "end_s": 22.75,
      "subject": true,
      "confidence": 0.93,
      "notes": "Red car entering from camera left"
    }
  ],
  "savedAt": "2026-07-22T05:31:14.084Z"
}
```

When **Open Video**, **Load Project**, or **Projects** is selected with dirty metadata, a native prompt offers **Save**, **Discard**, and **Cancel**. Save must complete before navigation continues; cancelling or failing that save keeps the current video and edits. Discard proceeds without writing, Cancel changes nothing, and clean state bypasses the prompt. If a file picker is cancelled after choosing Discard, the current dirty state remains intact because navigation did not complete.

The isolated preload API exposes `saveProject({ project, filePath, projectDirectory })`, `loadProject()`, and `confirmUnsavedChanges(videoName, destination)`. `filePath` is null for the first save and is reused for silent overwrite; a successful load returns `{ project, filePath, videoUrl }`. The prompt destination is `video`, `project`, or `projects` so the native message identifies the pending navigation.

## Project Layout

- `main.js` - Electron main process, native dialogs, project registry, child-process lifecycle, and IPC handlers
- `config.json` - Python, analysis-script, ffmpeg, and offline-stub selection
- `preload.js` - isolated `contextBridge` API exposed as `window.editorAPI`
- `renderer/index.html` - project selection and editor markup
- `renderer/app.js` - renderer application state and view coordination
- `renderer/timeline.js` - ruler, time mapping, playhead, seeking, interval layout, and timeline selection
- `renderer/panel.js` - Analysis panel rendering and selection state
- `renderer/style.css` - application, timeline, and panel styles
- `fixtures/sample_detections.json` - temporary Phase 3 detection data
- `stub/fake_analysis.py` - simulated analysis pipeline
- `pipeline/analyze.py` - standalone real-analysis entry point and CFR proxy stage
- `pipeline/gemini_harness/` - minimally adapted Gemini harness API, prompt, and response parser
- `pipeline/stages.py` - upload, processing, analysis, normalization, and schema validation
- `detections.schema.json` - frozen real-analysis result contract

The renderer has no direct Node.js access; privileged operations remain behind the preload IPC boundary.
