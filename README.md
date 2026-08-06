# Capstone Video Editor

Desktop review-and-cut editor for AI-assisted motorsports video indexing, sponsored by Apexiel. The application uses Electron and vanilla JavaScript with no frontend framework or bundler.

## Project Status

The required scope for Phases 2 through 6 is implemented. The application provides the secure Electron shell and project workflow, synchronized timeline and Analysis panel, interval and metadata editing, project persistence, cloud-backed Gemini vehicle analysis, and scoped clip export. macOS packaging provides both an unpacked diagnostic application and an unsigned DMG for controlled testing; Windows packaging provides an unpacked build and unsigned NSIS installer. Cloud Analysis CP4 routes real detection through the private Cloud Run job API using short-lived development identity tokens. Installer-grade device authentication, code signing, and notarization remain pending.

The following optional work remains intentionally deferred:

- Phase 3 CP5: timeline zoom and horizontal scrolling
- Phase 5 CP5 polish: a staged analysis checklist with per-stage durations, activity heartbeat, and soft-stall warning

## Cloud Prompt Service

The Cloud Run prompt-control service is located in `cloud/prompt-service`. It
provides immutable draft revisions, explicit publication, a public active-profile
endpoint, Firestore persistence, and a Secret Manager-backed administrator token.
The Cloud Run analysis worker retrieves and validates the active profile for each
job; Electron no longer downloads or caches prompt instructions.

See `cloud/prompt-service/README.md` for local verification, Google Cloud deployment, security boundaries, token rotation, and Apexiel handoff steps.
## Cloud Analysis Service

The private Cloud Run analysis service is located in
`cloud/analysis-service`. CP1 established authenticated invocation, CP2 added
private proxy storage and persistent job records, and CP3 added Cloud Tasks,
integrity verification, remote prompt loading, Secret Manager-backed Gemini,
bounded retries, cancellation guardrails, and terminal results. CP4 migrates
real Electron analysis to this API: the desktop creates the CFR proxy locally,
uploads it through a signed URL, polls the private job, validates results, and
deletes completed cloud data. Processing cancellations are durable, late worker
results cannot revive canceled jobs, and cloud workers make one bounded Gemini
call per Cloud Tasks attempt. The desktop no longer requires or receives
`GEMINI_API_KEY`.

Development runs authenticate with the signed-in Google Cloud CLI identity. This
is not the final installer-grade user authentication design. See
`cloud/analysis-service/CP4-OPERATIONS.md` for the exact boundary and tests.
## Prerequisites

- Node.js LTS, including npm
- Python 3 available as `py` or `python` on Windows, or `python3` on macOS
- `ffmpeg` and `ffprobe` available on `PATH`
- Google Cloud CLI installed and signed in for real cloud analysis
- The signed-in account granted `roles/run.invoker` on the analysis service

The same source checkout supports Windows and macOS. The setup command creates a
platform-specific `.venv` and verifies Python, FFmpeg, and ffprobe. Electron
automatically selects the virtual environment for the current operating system.

The local desktop needs no Gemini SDK or Gemini API key. Python and FFmpeg create
the proxy; Cloud Run owns prompt selection and Gemini execution.
## Run

```text
npm install
npm run setup
npm start
```

If FFmpeg is missing on macOS and you use Homebrew, install it with
`brew install ffmpeg`, then run `npm run setup` again. On Windows, install
FFmpeg and ensure both `ffmpeg.exe` and `ffprobe.exe` are on `PATH`.

## macOS Packaging

`electron-builder.yml` places the Electron main and renderer code in
`Contents/Resources/app.asar`. `config.json`, `detections.schema.json`,
`pipeline`, and `stub` are copied beside it in `Contents/Resources` so system
Python can execute them. The `runtime-paths.js` boundary selects the correct root
in development and packaged environments.

The builds target the current Mac architecture and expect Python 3, ffmpeg,
ffprobe, and an authenticated Google Cloud CLI on the host. They do not contain a
Gemini key or other Google credential. The artifacts are unsigned and not
notarized, so they are suitable for controlled testing rather than public
distribution.
Finder-launched builds extend their executable search path with standard
Homebrew, Python Framework, and user Cloud SDK locations.

### CP1 packaged-build verification

Install dependencies, run the automated tests, and create the unpacked macOS application:

```bash
npm install
npm test
npm run pack:mac

appRoot="$(find dist -type d -name 'Capstone Video Editor.app' | head -n 1)"
resources="$appRoot/Contents/Resources"
test -x "$appRoot/Contents/MacOS/Capstone Video Editor"
test -f "$resources/app.asar"
test -f "$resources/config.json"
test -f "$resources/pipeline/analyze.py"
test -f "$resources/stub/fake_analysis.py"
"$appRoot/Contents/MacOS/Capstone Video Editor"
```

1. Confirm the packaged application opens directly to the project-selection screen without a console window or startup error.
2. Open an existing project tile or select the **+** action, enter a project name, and confirm the editor opens the new workspace under the displayed Project location.
3. Select **Import Video**, choose an MP4 or MOV file, and confirm it is copied into the project `media` folder before the video, empty timeline, and editor controls load.
4. Select **Projects** and confirm the application returns to project selection, then close the application through the window shell.

To verify that the packaged app launches its external stub resource, close the application and enable the stub in the generated config:

```bash
configPath="$resources/config.json"
sed -i '' 's/"useDevStub": false/"useDevStub": true/' "$configPath"
"$appRoot/Contents/MacOS/Capstone Video Editor"
```

Open a project and video, then select **Detect Vehicles**. Expect all five analysis stages to complete and one detection to appear without requiring `GEMINI_API_KEY` or making a network request. Close the application and restore the generated config:

```bash
sed -i '' 's/"useDevStub": true/"useDevStub": false/' "$configPath"
```

### macOS installer (DMG)

Build the installable disk image from the repository root:

```bash
npm install
npm test
npm run installer:mac

installer="$(find dist -maxdepth 1 -name '*.dmg' | head -n 1)"
test -f "$installer"
shasum -a 256 "$installer"
open "$installer"
```

Drag **Capstone Video Editor** into **Applications**. Because the controlled-test
build is unsigned, macOS may require opening it once through **Control-click >
Open**. Public distribution requires a Developer ID certificate, hardened
runtime, and Apple notarization.

## Windows Packaging

### Controlled-tester installer (CP2)

The CP2 artifact is an unsigned, per-user NSIS installer for a controlled proof-of-concept test group. It creates Desktop and Start Menu shortcuts, supports a custom installation directory, and adds a normal Windows uninstall entry. It does not embed Gemini, Google Cloud, or service-account credentials.

Build the installer from the repository root:

```powershell
npm install
npm test
npm run installer:win

$installer = Join-Path $PWD 'dist\installer\Capstone Video Editor-Setup-0.1.0-x64.exe'
Get-Item -LiteralPath $installer
Get-FileHash -Algorithm SHA256 -LiteralPath $installer
```

The build runs from `%LOCALAPPDATA%\CapstoneVideoEditorInstaller` to avoid mapped-drive packaging failures, then copies the installer and its `.sha256.txt` file into `dist\installer`. Share both files with testers through the approved private file-sharing channel. Because the POC installer is not code-signed, Windows SmartScreen may show an unknown-publisher warning; testers should verify the SHA-256 value before selecting **More info > Run anyway**.

Each tester machine currently requires these host tools:

```powershell
winget install --exact --id Python.Python.3.13
winget install --exact --id Gyan.FFmpeg
winget install --exact --id Google.CloudSDK
```

Close and reopen the application after installing prerequisites. On Windows, the app refreshes the current machine and user `PATH` values at startup. A project administrator must grant the tester account only Cloud Run invocation access:

```powershell
gcloud run services add-iam-policy-binding apexiel-analysis-service `
  --project project-53ab0446-caac-4099-97d `
  --region us-west1 `
  --member "user:TESTER_EMAIL" `
  --role roles/run.invoker
```

The administrator runs that command once per tester. The tester then runs:

```powershell
gcloud auth login
gcloud config set project project-53ab0446-caac-4099-97d
gcloud auth print-identity-token | Out-Null
```

After installing the application, verify the complete tester workflow:

1. Launch **Capstone Video Editor** from the Start Menu and confirm the project-selection screen appears.
2. Create a project, import an MP4 or MOV file, and confirm the imported copy opens with an empty timeline.
3. Select **Detect Vehicles** and confirm the status advances through proxy creation, upload, processing, analysis, and parsing.
4. Save the detections, return to Projects, reopen the project, and confirm the intervals persist.
5. Export at least one interval and confirm the MP4 clip and `export_manifest.json` are created.
6. Close the app and uninstall it from **Settings > Apps > Installed apps**. Confirm project folders remain on disk.

This installer is suitable for allowlisted POC testers only. Before public distribution, replace the `gcloud` dependency with device authentication and code-sign the installer.

## Application Flow

1. On the project selection screen, use **Change** to choose the persistent Project location if needed. Select **+**, enter a project name, or open an existing project tile.
2. To remove a tile, use its delete control. This only unregisters the project from the landing screen; it does not delete the project folder or any files on disk.
3. In the editor, select **Import Video** and choose an MP4 or MOV file. The app copies it into `<project>\media` using a collision-safe filename, then loads the imported copy with native video controls and an empty timeline.
4. Select **Projects** to unload the current video and return to project selection.

The project registry is stored as `projects.json` in Electron's user data directory. The designated Project location is stored separately in `settings.json` and defaults to `Documents\Apexiel Projects`. Changing the location affects new projects only; existing registered project tiles keep their original paths. Each new project contains a `media` directory, and importing the same source filename again creates `name (2).ext`, `name (3).ext`, and later copies without overwriting existing media.

## Clip Export (Phase 6 CP1-CP3)

Select **Export** after detections are available. The dialog accepts an output folder and filters the current detection state by **All intervals**, **Subject only**, or **Selected interval**. Its clip count updates whenever the scope changes, including after edits to subject flags. **Start Export** remains disabled until the chosen scope contains at least one interval and an output folder is present.

The main process cuts directly from `currentVideo.path`, which is the source-quality copy in the project `media` folder and never the analysis proxy. `clip-export.js` validates the complete interval set, then runs one configured `ffmpegPath` process at a time with accurate input seeking, H.264 (`libx264`), `veryfast`, CRF 20, original dimensions, and copied audio when present. A successful temporary file is atomically published under `car{car_number|UNK}_{start}s-{end}s.mp4`; unsafe car-number characters become underscores and existing files receive `_2`, `_3`, and later suffixes rather than being overwritten. Fractional interval bounds are preserved to three decimal places in both the command and filename.

During export, ffmpeg's machine-readable progress stream drives current-clip and overall progress bars. Cancel requests terminate the active ffmpeg process tree, remove its hidden partial file, skip intervals that have not started, and still produce a partial completion summary. A failed clip is listed with its encoder error while the sequential batch continues. Every completed run writes `export_manifest.json` and the summary can open the selected output folder.

The isolated preload API exposes `chooseExportFolder(suggestedPath)`, `exportClips({ videoPath, outputDirectory, intervals })`, `cancelExport()`, `onExportEvent(callback)`, and `openExportFolder(folderPath)`. Analysis and export are mutually exclusive in both renderer controls and main-process IPC.

### CP1 clip-export verification (confirmed)

Prepare an empty output folder and launch Electron:

```powershell
New-Item -ItemType Directory -Force -Path .\cp1-export-manual | Out-Null
npm start
```

1. On the project landing screen, open a project tile or select **+** and enter a project name.
2. In the editor, select **Load Project** and open `cp2-manual\recovered-analysis.vproj.json`.
3. Select the sole 12-15 second appearance in the timeline or Analysis panel, then select **Export**.
4. Keep **Selected interval** checked and confirm the dialog reports `1 clip`. Choose `cp1-export-manual` as the output folder and select **Start Export**.
5. Confirm the dialog reports `Exported carUNK_12s-15s.mp4` and that the file is non-empty. Repeating the export should create `carUNK_12s-15s_2.mp4` without modifying the first file.

Close Electron, then verify native resolution, frame rate, and duration:

```powershell
$source = (Resolve-Path '.\cp2-manual\short-cfr-video.mp4').Path
$clip = (Resolve-Path '.\cp1-export-manual\carUNK_12s-15s.mp4').Path

ffprobe -v error -select_streams v:0 `
  -show_entries stream=width,height,avg_frame_rate `
  -show_entries format=duration -of default=noprint_wrappers=1 $source
ffprobe -v error -select_streams v:0 `
  -show_entries stream=width,height,avg_frame_rate `
  -show_entries format=duration -of default=noprint_wrappers=1 $clip
```

The source should report 1280x1120, 30/1 FPS, and 15 seconds. The clip must retain 1280x1120 and 30/1 FPS and report 3.000 seconds; one-frame tolerance is 0.0333 seconds. For an exact visual boundary check on this 30 FPS fixture, extract the expected source and exported boundary frames:

```powershell
ffmpeg -hide_banner -loglevel error -y -i $source `
  -vf "select='eq(n,360)'" -frames:v 1 '.\cp1-export-manual\source-start.png'
ffmpeg -hide_banner -loglevel error -y -i $clip `
  -vf "select='eq(n,0)'" -frames:v 1 '.\cp1-export-manual\clip-start.png'
ffmpeg -hide_banner -loglevel error -y -i $source `
  -vf "select='eq(n,449)'" -frames:v 1 '.\cp1-export-manual\source-end.png'
ffmpeg -hide_banner -loglevel error -y -i $clip `
  -vf "select='eq(n,89)'" -frames:v 1 '.\cp1-export-manual\clip-end.png'
```

`source-start.png` and `clip-start.png` should show the same frame, as should `source-end.png` and `clip-end.png`, apart from minor H.264 re-encoding differences. Frames 360 through 449 are the 90 source frames in the half-open interval `[12, 15)`, so these checks validate both boundaries and the three-second duration.

### CP2 batch-export verification

Create a short local project with three intervals and three empty output folders. This uses the existing 15-second CFR sample and makes no Gemini request:

```powershell
$video = (Resolve-Path '.\cp2-manual\short-cfr-video.mp4').Path
$testRoot = Join-Path (Resolve-Path '.\cp2-manual').Path 'cp2-export'
if (Test-Path -LiteralPath $testRoot) {
  throw "CP2 test output already exists: $testRoot"
}
New-Item -ItemType Directory -Path `
  (Join-Path $testRoot 'all'), `
  (Join-Path $testRoot 'subject'), `
  (Join-Path $testRoot 'subject-edited') | Out-Null

$project = [ordered]@{
  version = 1
  videoPath = $video
  videoDurationS = 15
  detections = @(
    [ordered]@{ car_number = '29|33'; start_s = 1; end_s = 3; subject = $true; confidence = 0.93; notes = 'Subject interval' }
    [ordered]@{ car_number = '14'; start_s = 4.5; end_s = 6; subject = $false; confidence = 0.72; notes = 'Non-subject interval' }
    [ordered]@{ car_number = ''; start_s = 7.25; end_s = 9.75; subject = $true; confidence = $null; notes = 'Unknown car number' }
  )
  savedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$projectPath = Join-Path $testRoot 'cp2-export-scopes.vproj.json'
[IO.File]::WriteAllText(
  $projectPath,
  ($project | ConvertTo-Json -Depth 5),
  [Text.UTF8Encoding]::new($false)
)
npm start
```

1. Open or create a landing-page project, select **Load Project**, and open `cp2-manual\cp2-export\cp2-export-scopes.vproj.json`.
2. Select the first interval, open **Export**, and switch among the scopes. **All intervals** must show `3 clips`, **Subject only** must show `2 clips`, and **Selected interval** must show `1 clip`.
3. Choose the `cp2-manual\cp2-export\all` folder, select **All intervals**, and start export. Expect `car29_33_1s-3s.mp4`, `car14_4.5s-6s.mp4`, and `carUNK_7.25s-9.75s.mp4`.
4. Run **All intervals** again into the same folder. Expect matching `_2` files, with the original three files unchanged.
5. Choose the `subject` folder and export **Subject only**. Expect only the `car29_33` and `carUNK` files; no `car14` file should exist.
6. Close the dialog, enable **Subject appearance** on the `car14` interval, reopen **Export**, and confirm **Subject only** now shows `3 clips`. Export to `subject-edited` and confirm all three filenames are present.

After closing Electron, list the results:

```powershell
Get-ChildItem -LiteralPath (Join-Path $testRoot 'all') -File -Filter '*.mp4' | Select-Object Name,Length
Get-ChildItem -LiteralPath (Join-Path $testRoot 'subject') -File -Filter '*.mp4' | Select-Object Name,Length
Get-ChildItem -LiteralPath (Join-Path $testRoot 'subject-edited') -File -Filter '*.mp4' | Select-Object Name,Length
```

Every listed clip must be non-empty. The first folder should contain six MP4 files, the second two, and the third three. Current CP3 builds also write one `export_manifest.json` per output folder; repeated runs replace that manifest without overwriting clips.

### Export manifest format

Each run writes `export_manifest.json` through a temporary file, then replaces the prior manifest in that run's output folder. `clips` is keyed by the actual collision-safe output filename, while `failures` records the intended filename and encoder reason. Interval fields are snapshots of the edited values sent to the main process.

```json
{
  "version": 1,
  "source_video": "C:\\path\\to\\original.mov",
  "exported_at": "2026-07-26T00:00:00.000Z",
  "canceled": false,
  "total_intervals": 3,
  "succeeded": 2,
  "failed": 1,
  "skipped": 0,
  "clips": {
    "car621_11.5s-40s.mp4": {
      "car_number": "621",
      "start_s": 11.5,
      "end_s": 40,
      "subject": true,
      "confidence": 0.95,
      "notes": "Blue sedan",
      "size_bytes": 123456
    }
  },
  "failures": [
    {
      "filename": "car14_40s-70s.mp4",
      "car_number": "14",
      "start_s": 40,
      "end_s": 70,
      "subject": false,
      "confidence": 0.72,
      "notes": "White hatchback",
      "error": "ffmpeg exited with code 1. ..."
    }
  ]
}
```

### CP3 progress, cancel, and summary verification

Create a three-interval project and three empty output folders from the existing 1:54 sample. This setup does not run Gemini:

```powershell
$video = (Resolve-Path '.\Application_Dir\Dummy_0\GX010094_stabilized_resized.mov').Path
$testRoot = Join-Path (Resolve-Path '.\cp2-manual').Path 'cp3-export'
if (Test-Path -LiteralPath $testRoot) {
  throw "CP3 test output already exists: $testRoot"
}
New-Item -ItemType Directory -Path `
  (Join-Path $testRoot 'complete'), `
  (Join-Path $testRoot 'cancel'), `
  (Join-Path $testRoot 'failure') | Out-Null

$project = [ordered]@{
  version = 1
  videoPath = $video
  videoDurationS = 114.949
  detections = @(
    [ordered]@{ car_number = '621'; start_s = 11.5; end_s = 40; subject = $true; confidence = 0.95; notes = 'Blue sedan' }
    [ordered]@{ car_number = '14'; start_s = 40; end_s = 70; subject = $false; confidence = 0.72; notes = 'White hatchback' }
    [ordered]@{ car_number = '183'; start_s = 75; end_s = 95.5; subject = $true; confidence = 0.95; notes = 'Blue hatchback' }
  )
  savedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$projectPath = Join-Path $testRoot 'cp3-progress.vproj.json'
[IO.File]::WriteAllText(
  $projectPath,
  ($project | ConvertTo-Json -Depth 5),
  [Text.UTF8Encoding]::new($false)
)
npm start
```

Normal run:

1. Open or create a landing-page project, select **Load Project**, and open `cp2-manual\cp3-export\cp3-progress.vproj.json`.
2. Select **Export**, choose the `complete` folder, select **All intervals**, and select **Start Export**.
3. Confirm the current-clip percentage and bar advance for each filename and the overall bar advances across all three clips. Scope, folder, and editor controls must remain disabled while the run is active.
4. Expect the message `3 clips exported`, three filenames under **Succeeded**, `None` under **Failed**, an `export_manifest.json` label, and these clips: `car621_11.5s-40s.mp4`, `car14_40s-70s.mp4`, and `car183_75s-95.5s.mp4`.
5. Select **Open Folder** and confirm Windows Explorer opens the `complete` folder.

Canceled run:

1. Close the summary, reopen **Export**, choose the `cancel` folder, and start **All intervals**.
2. After clip 1 completes and clip 2 begins, select **Cancel**. The control should change to **Canceling...** until ffmpeg exits.
3. Expect an **Export canceled** summary. When cancellation occurs during clip 2, it should report `1 succeeded, 0 failed, 2 not attempted`; a boundary-timing click after clip 2 finishes may instead report `2 succeeded, 0 failed, 1 not attempted`.
4. Confirm the in-flight clip is absent, no hidden `.partial.mp4` remains, and `export_manifest.json` has `"canceled": true` with matching counts.

Close Electron and verify cleanup:

```powershell
Get-ChildItem -LiteralPath (Join-Path $testRoot 'cancel') -Recurse -Force |
  Where-Object Name -Like '*.partial.*'
Get-Process -Name ffmpeg -ErrorAction SilentlyContinue
```

Both commands should produce no output.

Mixed-failure run:

```powershell
$env:CAPSTONE_EXPORT_FAIL_CLIP = '2'
npm start
```

1. Load `cp2-manual\cp3-export\cp3-progress.vproj.json`, select **Export**, choose the `failure` folder, select **All intervals**, and start export.
2. Clip 2 receives a deliberately invalid output path. Expect clip 1 to succeed, clip 2 to appear under **Failed** with an ffmpeg error, and clip 3 to continue and succeed.
3. Expect the summary to report `2 succeeded and 1 failed`. **Open Folder** should show the `car621` and `car183` clips plus `export_manifest.json`, with no `car14` clip or partial file.
4. Close Electron and clear the development-only failure hook:

```powershell
Remove-Item Env:CAPSTONE_EXPORT_FAIL_CLIP
$manifest = Get-Content -LiteralPath (Join-Path $testRoot 'failure\export_manifest.json') -Raw |
  ConvertFrom-Json
$manifest | Select-Object canceled,total_intervals,succeeded,failed,skipped
$manifest.clips.PSObject.Properties.Name
$manifest.failures | Select-Object filename,error
```

The manifest should report `canceled=False`, `total_intervals=3`, `succeeded=2`, `failed=1`, and `skipped=0`. Its clip keys should be the `car621` and `car183` filenames, and its single failure should identify `car14_40s-70s.mp4`.
## Stubbed (Mock) Analysis

Set `useDevStub` to `true` in `config.json`, then select **Detect Vehicles** to run `stub/fake_analysis.py` without an API key or network access. The process emits JSON Lines events for five simulated stages:

1. `proxy`
2. `upload`
3. `processing`
4. `analyzing`
5. `parsing`

The editor displays the current stage, elapsed time, live token count during analysis, and a **Cancel** control. Canceling terminates the complete analysis process tree and removes its temporary work directory after exit. On success, the stub writes one schema-valid canned detection and exercises the same result-loading path as real analysis.

To test the simulated failure path, keep `useDevStub` set to `true` and run:

```powershell
$env:FAKE_ANALYSIS_FAIL = '1'
npm start
Remove-Item Env:FAKE_ANALYSIS_FAIL
```

Set `FAKE_ANALYSIS_MALFORMED=1` instead to make the stub emit invalid JSONL and exercise protocol validation. Restore `useDevStub` to `false` before testing or using real analysis.

## Real Analysis Pipeline

The completed Phase 5 pipeline can also run independently of Electron. Set the API key in the current PowerShell session and run it against a short CFR sample:

```powershell
$env:GEMINI_API_KEY = 'your-key-from-Google-AI-Studio'
python pipeline/analyze.py `
  --video "C:\path\to\input.mov" `
  --out "C:\path\to\results.json"
```

The command writes `results.proxy.mp4` by default, uploads it through the Gemini Files API, waits for processing, submits one blocking Gemini 3.6 Flash request, stores the raw response under a sibling `raw` directory, preserves timestamps as fractional seconds, validates the final data against `detections.schema.json`, and atomically writes `results.json`. Pass `--proxy-cache-dir <directory>` to reuse a source-keyed proxy across runs. Electron supplies `<project>/media/.analysis-cache`, and cache keys include the source path, size, modification time, and proxy settings.

The balanced proxy profile is CFR H.264 at 2 FPS, CRF 21 for software encoding, and a maximum height of 1080 pixels. The pipeline probes NVIDIA NVENC, Intel Quick Sync, and AMD AMF in that order and uses each backend's quality-based rate control with a target quality of 21 instead of a fixed bitrate. It requests hardware-assisted decoding when a hardware encoder is selected, retries with `libx264` if that encoder fails, and uses stream metadata instead of enumerating every source and proxy frame. A source may be variable-frame-rate because the explicit FFmpeg FPS filter normalizes the proxy; source/proxy duration differences greater than 0.5 seconds are still rejected. Cache profile version 2 prevents older 5 FPS/720p proxies from being reused. Cache files are validated before reuse and incomplete proxy writes are never published. If the source folder does not permit cache creation, analysis falls back to the temporary run directory without caching.

The Gemini request samples the 2 FPS proxy at the same 2 FPS cadence, uses seed 0, medium media resolution, and an explicit JSON response schema. This removes the previous mismatch where most encoded proxy frames were discarded before model analysis and gives fast-moving footage half-second sampling points. Sampling parameters such as temperature are omitted for Gemini 3.6 Flash. The duration-aware prompt in `pipeline/gemini_harness/prompts.py` uses the validated research response contract and tells the model not to extend appearances through absent footage, carry identities into later intervals, or create duplicate entries for one visible car. Physical vehicle identity has priority over timing and visual similarity, with an explicit example requiring two entries when different vehicles appear across a 15-second gap. A fixed seed is best-effort reproducibility; Gemini can still interpret the same video differently across separate API calls.

Bounds are clamped to the source duration. Intervals that collapse to zero length only because they lie outside the source are omitted, while model-provided zero-length or reversed intervals remain parsing errors. MM:SS strings are accepted at the model boundary; when both bounds exceed the clip duration, a valid concatenated MMSS pair such as `115-137` is narrowly recovered as `75-97` before validation. Rich response fields map directly to the application: `is_target_vehicle` becomes `subject`, `vehicle_description` becomes `notes`, and `detection_confidence` is retained.

The direct local Gemini harness limits calls to five requests per rolling minute by default, spaces them at least 12 seconds apart, and retries transient `429`, `500`, `502`, `503`, and `504` responses up to five total attempts. Request history is shared through `gemini-rate-limit.json` in the application user-data directory. Set `HARNESS_RPM`, `GEMINI_MIN_REQUEST_INTERVAL_S`, or `GEMINI_MAX_ATTEMPTS` before starting a direct local run to tune those safeguards. Cloud analysis instead makes one provider attempt per durable Cloud Tasks delivery, allows at most three task attempts, and gives each Gemini HTTP request a five-minute deadline. This prevents nested retries from multiplying one failed job into as many as 15 provider calls.

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

### Proxy optimization verification

Use the dry-run path to verify proxy generation and cache reuse without a Gemini key, network request, or API charge:

```powershell
New-Item -ItemType Directory -Force -Path "./cp2-manual" | Out-Null
$video = "./cp2-manual/short-cfr-video.mp4"
$cache = "./cp2-manual/proxy-cache"

python pipeline/analyze.py `
  --video $video `
  --out "./cp2-manual/cache-first-results.json" `
  --proxy-cache-dir $cache `
  --dry-run |
  Tee-Object -FilePath "./cp2-manual/cache-first.jsonl"
if ($LASTEXITCODE -ne 0) { throw "First proxy run failed." }

python pipeline/analyze.py `
  --video $video `
  --out "./cp2-manual/cache-second-results.json" `
  --proxy-cache-dir $cache `
  --dry-run |
  Tee-Object -FilePath "./cp2-manual/cache-second.jsonl"
if ($LASTEXITCODE -ne 0) { throw "Cached proxy run failed." }

$first = Get-Content "./cp2-manual/cache-first.jsonl" |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.stage -eq "proxy" -and $_.event -eq "complete" }
$second = Get-Content "./cp2-manual/cache-second.jsonl" |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.stage -eq "proxy" -and $_.event -eq "complete" }

$first | Format-List proxyCached,proxyEncoder,sourceFps,proxyFps,durationDeltaS
$second | Format-List proxyCached,proxyEncoder,sourceFps,proxyFps,durationDeltaS
```

The first event should report `proxyCached: False`, `proxyFps: 2`, and either an available hardware encoder or `libx264`. The second should report `proxyCached: True`, `proxyEncoder: cache`, and the same duration and frame rate. The second run should emit no `proxy/progress` events.

## Application Analysis Configuration

`config.json` controls local proxy creation and the private cloud client:

```json
{
  "analyzeScript": "pipeline/analyze.py",
  "ffmpegPath": "ffmpeg",
  "ffprobePath": "ffprobe",
  "analysisStallTimeoutSeconds": 300,
  "analysisMaxTimeoutSeconds": 2700,
  "analysisServiceUrl": "https://apexiel-analysis-service-316801639479.us-west1.run.app",
  "analysisPollIntervalSeconds": 5,
  "analysisRequestTimeoutSeconds": 30,
  "useDevStub": false
}
```

When `pythonPath` is omitted, Electron uses `.venv\Scripts\python.exe` on
Windows or `.venv/bin/python` on macOS when present, then falls back to the
platform's standard Python 3 command. Add an explicit `pythonPath` only when a
custom interpreter is required. Relative `analyzeScript` paths resolve from the
application root. `analysisGcloudPath` may be set for a custom Google Cloud CLI;
when omitted it defaults to `gcloud.cmd` on Windows and `gcloud` elsewhere.
`analysisServiceUrl` must use HTTPS outside localhost. The stall watchdog resets
on proxy output, upload progress, and successful cloud polls; the maximum timeout
covers the complete local-and-cloud run. Poll intervals cannot exceed 60 seconds
and individual authenticated request timeouts cannot exceed 120 seconds.

Real mode runs `pipeline/analyze.py --proxy-only`, explicitly removes
`GEMINI_API_KEY` from the proxy child environment, obtains a short-lived Google
identity token, and calls Cloud Run. The selected Python only needs the standard
library for this path. The preload exposes result load/discard operations with no
path argument, so the renderer can consume only the schema-validated result
recorded for the active run.

### Remote prompt ownership

Electron no longer selects or caches the active prompt. The private worker fetches
the published profile directly from the prompt service, verifies its ETag and
schema, and persists profile ID, version, and ETag with the completed job. The
Gemini key and prompt instructions never enter the desktop process.
### Cloud analysis CP4 verification

Run the automated desktop and pipeline checks:

```powershell
npm test
python -m unittest pipeline.tests.test_cp2
```

Verify the published prompt independently of Gemini:

```powershell
$promptUrl = 'https://apexiel-prompt-service-316801639479.us-west1.run.app'
Invoke-RestMethod "$promptUrl/v1/prompt-profiles/active" |
  ConvertTo-Json -Depth 10
```

Verify the desktop identity can reach the private analysis service without an
upload or Gemini call:

```powershell
gcloud auth print-identity-token | Out-Null
node -e "const {createGcloudIdentityToken,CloudAnalysisClient}=require('./cloud-analysis-client'); (async()=>{const token=await createGcloudIdentityToken({gcloudPath:'gcloud.cmd'}); const client=new CloudAnalysisClient({serviceUrl:'https://apexiel-analysis-service-316801639479.us-west1.run.app',identityToken:token}); console.log(await client.request('/v1/capabilities',{stage:'authentication'}));})().catch(error=>{console.error(error.message);process.exit(1)})"
```

All four capability flags must be `true`. Complete manual application and cleanup
steps are in `cloud/analysis-service/CP4-OPERATIONS.md`.
### Phase 5 lifecycle verification (confirmed)

Run the automated lifecycle and pipeline regression tests first:

```powershell
npm test
python -m unittest pipeline.tests.test_cp2
```

Both commands must pass. For the UI tests below, note the existing analysis work directories before each launch:

```powershell
$before = @(Get-ChildItem $env:TEMP -Directory -Filter 'capstone-analysis-*' -ErrorAction SilentlyContinue).FullName
```

#### Cancel and cleanup

Set `useDevStub` to `true`, `analysisStallTimeoutSeconds` to `300`, and `analysisMaxTimeoutSeconds` to `2700` in `config.json`, then run `npm start`. Open a video and select **Detect Vehicles**. Select **Cancel** once while the status reads **Uploading**, then repeat in a fresh run while it reads **Analyzing**. In both runs, the analysis controls must return to idle without an error dialog. Close Electron and run:

```powershell
$after = @(Get-ChildItem $env:TEMP -Directory -Filter 'capstone-analysis-*' -ErrorAction SilentlyContinue).FullName
Compare-Object $before $after
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match '^python(?:w)?\.exe$' -and
  $_.CommandLine -match 'fake_analysis\.py|pipeline[\\/]analyze\.py'
}
```

Both commands should print no rows. This confirms that the canceled run added no surviving work directory and left no analysis Python process.

#### Forced failure and malformed protocol

Keep stub mode enabled. Test the nonzero exit path:

```powershell
$env:FAKE_ANALYSIS_FAIL = '1'
npm start
Remove-Item Env:FAKE_ANALYSIS_FAIL
```

Run an analysis and wait for the dialog. It must identify the `processing` stage, exit code `2`, and the final stderr detail `simulated failure during processing stage`. Next test malformed stdout:

```powershell
$env:FAKE_ANALYSIS_MALFORMED = '1'
npm start
Remove-Item Env:FAKE_ANALYSIS_MALFORMED
```

The dialog must identify the `processing` stage and report malformed JSONL progress output. Repeat the directory and process checks from the cancellation test after closing Electron; both should remain empty.

#### Timeout

Keep stub mode enabled, set `analysisStallTimeoutSeconds` to `3`, keep `analysisMaxTimeoutSeconds` at `2700`, and run `npm start`. Start an analysis and do not cancel it. After three seconds without a protocol event, a visible error must identify the current stage and state that analysis stopped reporting progress for 3 seconds. The controls must return to idle, with no surviving work directory or Python process. Restore `analysisStallTimeoutSeconds` to `300` afterward.

#### Cloud authentication and unavailable service

Set `useDevStub` to `false`, remove any local Gemini key, and verify that the
signed-in Cloud identity is available:

```powershell
Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue
gcloud auth print-identity-token | Out-Null
npm start
```

**Detect Vehicles** must continue without a missing-key dialog. To verify bounded
authentication failure, close Electron, temporarily set `analysisGcloudPath` to
`missing-gcloud.cmd`, restart, and run detection. After proxy creation, the dialog
must identify the `authentication` stage and no local Gemini fallback may occur.
Restore `analysisGcloudPath` afterward.

To verify an unreachable cloud endpoint, temporarily set `analysisServiceUrl` to
`https://127.0.0.1:9`, restart, and run detection. The dialog must identify the
`upload` stage and report that the analysis service could not be reached. Restore
the production URL after the check. Canceled and failed runs must leave no local
analysis work directory or Python process.
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

## Project Save and Load

**Save Changes** is disabled after loading and enables after the first successful edit. The first save opens a native save dialog; later saves silently overwrite that selected `.vproj.json` file. A successful save marks the detection state clean and disables the button again. Saving writes metadata only and never modifies the referenced video.

Importing a video copies the source into the active project and initializes an empty detection list. **Load Project** validates the project file, verifies that its video still exists, reopens that video, restores all saved detections, and starts with a clean state. Project files use this versioned format:

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

When **Import Video**, **Load Project**, or **Projects** is selected with dirty metadata, a native prompt offers **Save**, **Discard**, and **Cancel**. Save must complete before navigation continues; cancelling or failing that save keeps the current video and edits. Discard proceeds without writing, Cancel changes nothing, and clean state bypasses the prompt. If a file picker is cancelled after choosing Discard, the current dirty state remains intact because navigation did not complete.

The isolated preload API exposes project-location, project-creation, video-import, save/load, and unsaved-change methods without giving the renderer direct filesystem access. `filePath` is null for the first save and is reused for silent overwrite; a successful load returns `{ project, filePath, videoUrl }`. The prompt destination is `video`, `project`, or `projects` so the native message identifies the pending navigation.

## Project Layout

- `main.js` - Electron main process, native dialogs, project registry, child-process lifecycle, and IPC handlers
- `clip-export.js` - validated filename construction, ffmpeg argument construction, atomic clip publication, and collision handling
- `analysis-lifecycle.js` - protocol validation, progress-aware watchdogs, staged error formatting, work-directory cleanup, and process-tree termination
- `project-workspace.js` - project-name validation, workspace paths, and collision-safe video imports
- `prompt-profile-client.js` - remote profile validation, ETag caching, compatibility checks, and fallback selection
- `config.json` - Python, analysis-script, ffmpeg, prompt-service, timeout, and offline-stub selection
- `python-runtime.js` - Python discovery and pipeline dependency preflight
- `runtime-environment.js` - macOS executable-path discovery for installed builds
- `preload.js` - isolated `contextBridge` API exposed as `window.editorAPI`
- `renderer/index.html` - project selection and editor markup
- `renderer/app.js` - renderer application state and view coordination
- `renderer/timeline.js` - ruler, time mapping, playhead, seeking, interval layout, and timeline selection
- `renderer/panel.js` - Analysis panel rendering and selection state
- `renderer/export-scope.js` - all, subject-only, and selected-interval filtering over detection snapshots
- `renderer/style.css` - application, timeline, and panel styles
- `stub/fake_analysis.py` - simulated analysis pipeline
- `pipeline/analyze.py` - standalone real-analysis entry point, optimized CFR proxy generation, and cache management
- `pipeline/gemini_harness/` - minimally adapted Gemini harness API, prompt, and response parser
- `pipeline/stages.py` - upload, processing, analysis, normalization, and schema validation
- `cloud/prompt-service/` - versioned remote prompt publication service
- `cloud/analysis-service/` - private Cloud Run boundary for cloud analysis jobs
- `detections.schema.json` - frozen real-analysis result contract

The renderer has no direct Node.js access; privileged operations remain behind the preload IPC boundary.
