# Cloud Analysis CP4 Operations

Checkpoint 4 migrates real Electron analysis from the local Gemini pipeline to
the private Cloud Run job API. The desktop still creates the proven 2 FPS CFR
proxy locally, but the Gemini key, active prompt, model request, normalization,
and persistent job state remain in Google Cloud.

## Runtime flow

1. Electron runs `pipeline/analyze.py --proxy-only` and reuses the existing
   source-keyed proxy cache when valid.
2. The main process obtains a short-lived Google identity token with
   `gcloud auth print-identity-token`.
3. Electron creates an analysis job containing the source duration, proxy size,
   and SHA-256 digest.
4. The proxy is streamed directly to the short-lived signed Cloud Storage URL.
   The Cloud Run bearer token is never attached to this request.
5. Electron confirms the upload and polls the private job endpoint while Cloud
   Tasks runs Gemini. A retrying job reports its bounded reason and next attempt
   instead of appearing as a new generic queue wait.
6. Completed detections are schema-validated, written to the private analysis
   work directory, loaded through the existing path-free preload method, and
   the cloud job and proxy are deleted.

No `GEMINI_API_KEY`, signed upload URL, or Google identity token is exposed to
the renderer.

## Development authentication

The current desktop authentication provider is intended for development and
sponsor verification. The workstation must have Google Cloud CLI installed and
the signed-in account must have `roles/run.invoker` on
`apexiel-analysis-service`.

```powershell
gcloud auth login
gcloud config set project project-53ab0446-caac-4099-97d
gcloud auth print-identity-token | Out-Null
```

Do not place a service-account key, Gemini key, long-lived bearer token, or
administrator token in `config.json` or the packaged application. An
installer-grade release must replace the `createGcloudIdentityToken` provider
with Apexiel's approved interactive user-authentication flow.

## Desktop configuration

```json
{
  "pythonPath": "python",
  "analyzeScript": "pipeline/analyze.py",
  "ffmpegPath": "ffmpeg",
  "analysisStallTimeoutSeconds": 300,
  "analysisMaxTimeoutSeconds": 2700,
  "analysisServiceUrl": "https://apexiel-analysis-service-316801639479.us-west1.run.app",
  "analysisGcloudPath": "gcloud.cmd",
  "analysisPollIntervalSeconds": 5,
  "analysisRequestTimeoutSeconds": 30,
  "useDevStub": false
}
```

`analysisServiceUrl` must use HTTPS outside localhost. The gcloud path can be a
PATH command or an explicit executable path. Polling is bounded to 60 seconds
and individual authenticated requests are bounded to 120 seconds by config
validation. The existing stall and absolute watchdogs cover proxy creation,
authentication, upload, polling, result parsing, and cleanup as one run.

## Queue and retry guardrails

The Cloud Tasks queue intentionally runs one analysis at a time to limit Gemini
cost and request pressure. Starting detection from Windows and macOS
simultaneously therefore places one job behind the other; the second desktop
must remain at **Queued in cloud** until the first task reaches a terminal state.

Cloud mode uses three durable Cloud Tasks attempts and exactly one Gemini
provider attempt per task. Gemini HTTP work has a five-minute request deadline.
This replaces the previous nested policy, where five SDK attempts inside each of
three task attempts could keep the single worker occupied for an excessive
period.

## Automated verification

From the repository root:

```powershell
npm test
python -m unittest pipeline.tests.test_cp2
```

The Node suite verifies response contracts, token isolation from signed uploads,
Windows gcloud invocation, polling, remote error mapping, cleanup, and the
existing application behavior. The Python suite verifies that proxy-only mode
does not import Gemini stages.

Confirm private-service authentication without uploading video or calling
Gemini:

```powershell
node -e "const {createGcloudIdentityToken,CloudAnalysisClient}=require('./cloud-analysis-client'); (async()=>{const token=await createGcloudIdentityToken({gcloudPath:'gcloud.cmd'}); const client=new CloudAnalysisClient({serviceUrl:'https://apexiel-analysis-service-316801639479.us-west1.run.app',identityToken:token}); console.log(await client.request('/v1/capabilities',{stage:'authentication'}));})().catch(error=>{console.error(error.message);process.exit(1)})"
```

All four capability flags must be `true`.

## Manual application verification

Start from a shell with no local Gemini key:

```powershell
Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue
gcloud auth print-identity-token | Out-Null
npm start
```

1. Open a project and import or select a video.
2. Select **Detect Vehicles**.
3. Confirm the status advances through Creating proxy, Uploading, Processing,
   Analyzing, and Parsing results.
4. Confirm detections populate the Analysis panel and timeline and that **Save
   Changes** becomes available.
5. Save, reload the project, and confirm the detections persist.
6. Run detection a second time and confirm the validated proxy cache is reused.

The Electron console must not report a missing `GEMINI_API_KEY`. A failed or
expired gcloud login must produce an `authentication` error rather than falling
back to a local Gemini call.

After a completed run, verify cleanup:

```powershell
gcloud storage ls 'gs://apexiel-analysis-proxies-316801639479/**'
```

The command should print no objects when no other analyses are active.

## Cancellation boundary

Canceling during proxy creation terminates the local process tree. Canceling
during hashing, upload, confirmation, or queued polling deletes the cloud job
and proxy. Canceling while the worker is `processing` returns `202`, stores a
terminal `canceled` job, and deletes the proxy. The already-issued Gemini HTTP
request cannot be interrupted from another process, but it is bounded to five
minutes; when it returns, the worker discards the result, acknowledges the task,
and does not retry. The retained job record prevents redelivery from reviving
the job and expires through the seven-day bucket lifecycle.

## Two-device regression test

Run this only after redeploying the analysis service with the current code:

1. Start detection on Windows and wait until it reports **Cloud analysis**.
2. Start detection on macOS. Confirm it remains at **Queued in cloud** while the
   Windows job owns the single worker.
3. Cancel the Windows analysis. Confirm the Windows UI returns to idle without
   an error dialog.
4. Confirm the macOS job begins cloud analysis after the canceled provider call
   returns or reaches its five-minute deadline.
5. In Cloud Run logs, confirm the canceled job reports cancellation and never
   logs a second attempt. If the other job retries, the desktop must show the
   retry reason and an attempt count no higher than `3/3`.
6. Confirm the macOS job completes normally and its detections load.

Restarting either computer must not be required. A restart has no direct effect
on Cloud Tasks; only terminal task acknowledgement clears the worker slot.
