# Checkpoint 3 Operations

Checkpoint 3 runs Gemini behind the private analysis-service boundary. Upload
confirmation queues an authenticated Cloud Tasks request. The worker downloads
the exact Cloud Storage generation while calculating SHA-256, fetches the
published prompt profile, calls the existing validated Gemini harness, validates
the normalized detections, and persists `completed` or `failed`.

The desktop still uses its local pipeline until the client-migration checkpoint.

## Runtime resources

The development deployment uses:

```powershell
$projectId = 'project-53ab0446-caac-4099-97d'
$projectNumber = '316801639479'
$region = 'us-west1'
$serviceName = 'apexiel-analysis-service'
$queueName = 'apexiel-analysis'
$bucketName = 'apexiel-analysis-proxies-316801639479'
$secretName = 'apexiel-gemini-api-key'
$serviceAccount = "apexiel-analysis-service@$projectId.iam.gserviceaccount.com"
$taskInvoker = "apexiel-analysis-task-invoker@$projectId.iam.gserviceaccount.com"
$buildServiceAccount = "apexiel-analysis-builder@$projectId.iam.gserviceaccount.com"
$queuePath = "projects/$projectId/locations/$region/queues/$queueName"
$serviceUrl = gcloud run services describe $serviceName `
  --project=$projectId `
  --region=$region `
  --format='value(status.url)'
$promptServiceUrl = gcloud run services describe apexiel-prompt-service `
  --project=$projectId `
  --region=$region `
  --format='value(status.url)'
```

The queue permits one concurrent worker, up to `0.1` dispatches per second, and
three attempts with bounded backoff. A task request may run for at most 30
minutes. The Cloud Run service uses the second-generation environment and 2 GiB
of memory because the generation-pinned proxy is staged on ephemeral disk before
the Gemini Files API upload.

## Gemini secret

The `apexiel-gemini-api-key` secret exists without a value until an operator adds
version 1. Do not place the key in source, a command argument, an Electron build,
or a job request.

In Google Cloud Console, open **Security > Secret Manager**, select
`apexiel-gemini-api-key`, choose **New version**, paste the Gemini API key, and
add the version. The runtime account is the only secret accessor.

For PowerShell, this avoids putting the key in shell history and deletes the
temporary plaintext file immediately:

```powershell
$secureKey = Read-Host 'Gemini API key' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
$temporaryKeyFile = [IO.Path]::GetTempFileName()
try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  [IO.File]::WriteAllText(
    $temporaryKeyFile,
    $plainKey,
    [Text.UTF8Encoding]::new($false)
  )
  gcloud secrets versions add $secretName `
    --project=$projectId `
    --data-file=$temporaryKeyFile
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $plainKey = $null
  Remove-Item -LiteralPath $temporaryKeyFile -Force
}
```

Confirm that exactly one enabled version exists without reading its value:

```powershell
gcloud secrets versions list $secretName `
  --project=$projectId `
  --filter='state=ENABLED'
```

## Build and deploy

Run these commands from the repository root. The root `.gcloudignore` and
`.dockerignore` limit the build context, while the image copies the existing
`pipeline/gemini_harness` instead of maintaining a second prompt implementation.

```powershell
$image = "$region-docker.pkg.dev/$projectId/cloud-run-source-deploy/$serviceName`:cp3"

gcloud builds submit . `
  --project=$projectId `
  --config='cloud/analysis-service/cloudbuild.yaml' `
  --substitutions="_IMAGE=$image" `
  --service-account="projects/$projectId/serviceAccounts/$buildServiceAccount"

gcloud run deploy $serviceName `
  --image=$image `
  --project=$projectId `
  --region=$region `
  --service-account=$serviceAccount `
  --default-url `
  --ingress=all `
  --no-allow-unauthenticated `
  --invoker-iam-check `
  --execution-environment=gen2 `
  --set-env-vars="ANALYSIS_BUCKET=$bucketName,ANALYSIS_SERVICE_ACCOUNT_EMAIL=$serviceAccount,ANALYSIS_TASK_QUEUE=$queuePath,ANALYSIS_SERVICE_URL=$serviceUrl,ANALYSIS_TASK_INVOKER_SERVICE_ACCOUNT=$taskInvoker,PROMPT_SERVICE_URL=$promptServiceUrl,ANALYSIS_UPLOAD_TTL_SECONDS=900,ANALYSIS_JOB_TTL_HOURS=168,ANALYSIS_TASK_DEADLINE_SECONDS=1800" `
  --update-secrets="GEMINI_API_KEY=$secretName`:1" `
  --cpu=1 `
  --memory=2Gi `
  --concurrency=4 `
  --min-instances=0 `
  --max-instances=3 `
  --timeout=1800
```

Secret version `1` is deliberately pinned. Rotate the key by adding a new secret
version and deploying a new Cloud Run revision pinned to that version.

## Automated verification

From `cloud\analysis-service`:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt

$env:PYTHONPATH = "$PWD;$((Resolve-Path '..\..\pipeline').Path)"
python -m unittest discover -s tests -v
```

All 32 tests must pass. They cover CP2 compatibility, task construction,
idempotent queueing, task-route protection, streamed integrity outcomes,
strict prompt loading, bounded retries, terminal failures, normalized results,
and persistent round trips.

## Deployed verification

Create an authenticated development header and confirm CP3 capabilities:

```powershell
$identityToken = gcloud auth print-identity-token
$apiHeaders = @{ Authorization = "Bearer $identityToken" }

Invoke-RestMethod "$serviceUrl/v1/capabilities" -Headers $apiHeaders
```

`analysisJobs`, `proxyUploads`, `geminiAnalysis`, and
`asynchronousAnalysis` must all be `true`.

Use an existing MP4 proxy for the complete workflow:

```powershell
$proxyPath = (Resolve-Path '.\cp1-output\results.proxy.mp4').Path
$proxyFile = Get-Item -LiteralPath $proxyPath
$jobId = [guid]::NewGuid().ToString()
$proxyHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $proxyPath).Hash.ToLowerInvariant()

$request = @{
  schemaVersion = 1
  clientRequestId = $jobId
  sourceDurationS = 15.0
  proxySizeBytes = $proxyFile.Length
  proxySha256 = $proxyHash
  proxyContentType = 'video/mp4'
}

$created = Invoke-RestMethod "$serviceUrl/v1/analysis/jobs" `
  -Method Post `
  -Headers $apiHeaders `
  -ContentType 'application/json' `
  -Body ($request | ConvertTo-Json -Compress)

$uploadHeaders = @{}
foreach ($property in $created.upload.requiredHeaders.PSObject.Properties) {
  if ($property.Name -ne 'Content-Type') {
    $uploadHeaders[$property.Name] = [string]$property.Value
  }
}

Invoke-WebRequest $created.upload.url `
  -Method Put `
  -Headers $uploadHeaders `
  -ContentType 'video/mp4' `
  -InFile $proxyPath `
  -UseBasicParsing

$queued = Invoke-RestMethod "$serviceUrl/v1/analysis/jobs/$jobId/upload-complete" `
  -Method Post `
  -Headers $apiHeaders
$queued.job.state

$deadline = (Get-Date).AddMinutes(30)
do {
  Start-Sleep -Seconds 5
  $status = Invoke-RestMethod "$serviceUrl/v1/analysis/jobs/$jobId" `
    -Headers $apiHeaders
  $status.job.state
} while (
  $status.job.state -notin @('completed', 'failed') -and
  (Get-Date) -lt $deadline
)

$status.job | ConvertTo-Json -Depth 8
```

The confirmation state is `queued`. A successful terminal job is `completed`,
sets `proxy.sha256Verified` to `true`, records the Gemini model and remote prompt
profile/version/ETag, reports token counts, and contains `results.detections`.
A terminal failure contains a bounded `error` object and never includes a key,
signed URL, bucket name, object name, prompt instructions, or raw Gemini text.

Delete the test data after inspection:

```powershell
Invoke-WebRequest "$serviceUrl/v1/analysis/jobs/$jobId" `
  -Method Delete `
  -Headers $apiHeaders `
  -UseBasicParsing
```

Do not print or save the signed upload URL. `gcloud` identity tokens remain for
development verification only; production desktop authentication is a later
checkpoint.
