# Apexiel Analysis Service

This private Cloud Run service is the server-side boundary for vehicle-analysis
jobs. Clients upload locally generated proxies and receive schema-validated
detections without receiving or storing the Gemini credential.

Checkpoint 1 established the authenticated Cloud Run boundary. Checkpoint 2
adds private proxy storage, persistent job records, 15-minute V4 upload URLs,
upload metadata validation, cancellation cleanup, and bucket lifecycle rules.
Checkpoint 3 adds streamed SHA-256 verification, durable Cloud Tasks dispatch,
the published remote prompt, a Secret Manager-backed Gemini worker, bounded
retries, and persistent terminal results.

## Current API

- `GET /health` reports service availability.
- `GET /v1/capabilities` reports upload, asynchronous job, and Gemini support.
- `POST /v1/analysis/jobs` creates an idempotent job and returns a signed upload
  URL with its required headers.
- `GET /v1/analysis/jobs/{jobId}` returns persistent job metadata without an
  upload URL or Cloud Storage object name.
- `POST /v1/analysis/jobs/{jobId}/upload-complete` verifies the uploaded
  object's exact size, content type, signed job metadata, and generation before
  advancing the job to `queued` and dispatching one deterministic task.
- `POST /v1/internal/analysis/jobs/{jobId}/run` is the OIDC-authenticated Cloud
  Tasks worker route. It publishes `completed` results or a bounded `failed`
  error and is not a desktop endpoint.
- `DELETE /v1/analysis/jobs/{jobId}` deletes the proxy and job record.
  Processing jobs return `409` because CP3 does not provide remote cancellation.

The job identifier is the normalized client request UUID. Repeating an identical
create request is safe and returns a replacement upload URL when the job still
awaits upload. Reusing the UUID with different metadata returns `409`.

## Security boundary

- Cloud Run's invoker IAM check protects every route. The service has no public
  IAM principal.
- The proxy bucket enforces public-access prevention and uniform bucket-level
  access.
- The runtime has `roles/storage.objectUser` only on the proxy bucket and can
  sign only as its own service account.
- The developer account has bucket-scoped `roles/storage.admin`; inherited
  legacy project viewer/editor bucket bindings were removed.
- The API derives `jobs/{uuid}.json` and `uploads/{uuid}/proxy.mp4` itself. A
  caller cannot provide a bucket or object name.
- V4 upload URLs expire after 15 minutes, allow `PUT` to one object, require the
  returned headers, and use an object-generation precondition to prevent
  overwrite.
- Signed URLs are temporary bearer capabilities. Do not log, persist, or send
  them to any party other than the uploading client.
- Unknown request fields are rejected. The API never accepts a Gemini key,
  administrator token, prompt, or model selection.
- Proxies are limited to 512 MiB and source durations to six hours.
- The worker reads only the server-derived object name and exact stored
  generation. It calculates SHA-256 while streaming to scratch storage before
  making any prompt or Gemini request.
- The Gemini key is injected from a pinned Secret Manager version and is never
  stored in an image, request, job record, result, or log.
- Terminal results include the model and prompt profile ID/version/ETag for
  reproducibility but never include prompt instructions or raw Gemini output.

The bucket deletes `uploads/` objects after one day and `jobs/` records after
seven days. Lifecycle execution is asynchronous, so explicit cancellation still
deletes both immediately. Soft delete is disabled because these are temporary,
reproducible objects; deletion cannot be undone.

## Local verification

From `cloud\analysis-service` in PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt

$env:PYTHONPATH = $PWD.Path
python -m unittest discover -s tests -v
python -m uvicorn analysis_service.app:app --reload --port 8081
```

Without cloud environment variables, local Uvicorn intentionally reports all
capability flags as `false`. The automated suite injects in-memory storage,
task, prompt, and worker adapters and must pass 32 tests. In a second terminal:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8081/health'
Invoke-RestMethod 'http://127.0.0.1:8081/v1/capabilities'
```

Stop Uvicorn with `Ctrl+C`.

## Google Cloud variables

The deployed development resources use:

```powershell
$projectId = 'project-53ab0446-caac-4099-97d'
$region = 'us-west1'
$serviceName = 'apexiel-analysis-service'
$serviceAccountName = 'apexiel-analysis-service'
$buildServiceAccountName = 'apexiel-analysis-builder'
$bucketName = 'apexiel-analysis-proxies-316801639479'
$developerAccount = (gcloud config get-value account).Trim()

$serviceAccount = "$serviceAccountName@$projectId.iam.gserviceaccount.com"
$buildServiceAccount = "$buildServiceAccountName@$projectId.iam.gserviceaccount.com"

gcloud config set project $projectId
gcloud services enable `
  run.googleapis.com `
  cloudbuild.googleapis.com `
  artifactregistry.googleapis.com `
  storage.googleapis.com `
  iamcredentials.googleapis.com
```

## Service identities

Create the dedicated identities once:

```powershell
gcloud iam service-accounts create $serviceAccountName `
  --display-name='Apexiel Analysis Service'

gcloud iam service-accounts create $buildServiceAccountName `
  --display-name='Apexiel Analysis Builder'

gcloud projects add-iam-policy-binding $projectId `
  --member="serviceAccount:$buildServiceAccount" `
  --role='roles/run.builder'
```

New service accounts and grants can take about a minute to propagate. If the
first source deployment says the builder cannot read the `run-sources` object,
wait briefly and retry without adding a broader storage role.

## Private bucket

Create the temporary-data bucket and apply the checked-in lifecycle file:

```powershell
gcloud storage buckets create "gs://$bucketName" `
  --project=$projectId `
  --location=$region `
  --default-storage-class=STANDARD `
  --uniform-bucket-level-access `
  --public-access-prevention `
  --soft-delete-duration=0s

gcloud storage buckets update "gs://$bucketName" `
  --lifecycle-file='infrastructure/proxy-lifecycle.json'

gcloud storage buckets add-iam-policy-binding "gs://$bucketName" `
  --member="serviceAccount:$serviceAccount" `
  --role='roles/storage.objectUser'

gcloud iam service-accounts add-iam-policy-binding $serviceAccount `
  --project=$projectId `
  --member="serviceAccount:$serviceAccount" `
  --role='roles/iam.serviceAccountTokenCreator'
```

Give the operator bucket-scoped administration before removing the convenience
bindings created with a new bucket:

```powershell
gcloud storage buckets add-iam-policy-binding "gs://$bucketName" `
  --member="user:$developerAccount" `
  --role='roles/storage.admin'

gcloud storage buckets remove-iam-policy-binding "gs://$bucketName" --member="projectViewer:$projectId" --role='roles/storage.legacyObjectReader'
gcloud storage buckets remove-iam-policy-binding "gs://$bucketName" --member="projectViewer:$projectId" --role='roles/storage.legacyBucketReader'
gcloud storage buckets remove-iam-policy-binding "gs://$bucketName" --member="projectEditor:$projectId" --role='roles/storage.legacyObjectOwner'
gcloud storage buckets remove-iam-policy-binding "gs://$bucketName" --member="projectOwner:$projectId" --role='roles/storage.legacyObjectOwner'
gcloud storage buckets remove-iam-policy-binding "gs://$bucketName" --member="projectEditor:$projectId" --role='roles/storage.legacyBucketOwner'
gcloud storage buckets remove-iam-policy-binding "gs://$bucketName" --member="projectOwner:$projectId" --role='roles/storage.legacyBucketOwner'
```

## Deploy CP2

From `cloud\analysis-service`:

```powershell
gcloud run deploy $serviceName `
  --source . `
  --project=$projectId `
  --region=$region `
  --build-service-account="projects/$projectId/serviceAccounts/$buildServiceAccount" `
  --service-account=$serviceAccount `
  --default-url `
  --ingress=all `
  --no-allow-unauthenticated `
  --invoker-iam-check `
  --set-env-vars="ANALYSIS_BUCKET=$bucketName,ANALYSIS_SERVICE_ACCOUNT_EMAIL=$serviceAccount,ANALYSIS_UPLOAD_TTL_SECONDS=900,ANALYSIS_JOB_TTL_HOURS=168" `
  --cpu=1 `
  --memory=512Mi `
  --concurrency=20 `
  --min-instances=0 `
  --max-instances=3 `
  --timeout=60

gcloud run services add-iam-policy-binding $serviceName `
  --project=$projectId `
  --region=$region `
  --member="user:$developerAccount" `
  --role='roles/run.invoker'
```

## Deployed-service verification

Read the service URL and create a development identity token:

```powershell
$serviceUrl = gcloud run services describe $serviceName `
  --project=$projectId `
  --region=$region `
  --format='value(status.url)'

$identityToken = gcloud auth print-identity-token
$apiHeaders = @{ Authorization = "Bearer $identityToken" }
```

An unauthenticated request must return `401` or `403`. Authenticated capabilities
must report `analysisJobs: true`, `proxyUploads: true`, and
`geminiAnalysis: false`:

```powershell
Invoke-RestMethod "$serviceUrl/v1/capabilities" -Headers $apiHeaders
```

Use an existing local MP4 proxy for the end-to-end upload check:

```powershell
$proxyPath = (Resolve-Path 'C:\path\to\results.proxy.mp4').Path
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

$job = Invoke-RestMethod "$serviceUrl/v1/analysis/jobs" `
  -Method Post `
  -Headers $apiHeaders `
  -ContentType 'application/json' `
  -Body ($request | ConvertTo-Json -Compress)

$uploadHeaders = @{}
foreach ($property in $job.upload.requiredHeaders.PSObject.Properties) {
  if ($property.Name -ne 'Content-Type') {
    $uploadHeaders[$property.Name] = [string]$property.Value
  }
}

Invoke-WebRequest $job.upload.url `
  -Method Put `
  -Headers $uploadHeaders `
  -ContentType 'video/mp4' `
  -InFile $proxyPath `
  -UseBasicParsing

Invoke-RestMethod "$serviceUrl/v1/analysis/jobs/$jobId/upload-complete" `
  -Method Post `
  -Headers $apiHeaders

Invoke-RestMethod "$serviceUrl/v1/analysis/jobs/$jobId" `
  -Headers $apiHeaders

Invoke-WebRequest "$serviceUrl/v1/analysis/jobs/$jobId" `
  -Method Delete `
  -Headers $apiHeaders `
  -UseBasicParsing
```

The upload returns HTTP `200`, confirmation returns state `uploaded`, the read
returns the same persisted state, and deletion returns `204`. Do not print or
save `job.upload.url`.

Verify infrastructure independently:

```powershell
gcloud storage buckets describe "gs://$bucketName" --format=json
gcloud storage buckets get-iam-policy "gs://$bucketName" --format=json
gcloud run services get-iam-policy $serviceName `
  --project=$projectId `
  --region=$region `
  --format=json
```

The bucket must show regional `US-WEST1`, uniform access `true`, public access
prevention `enforced`, soft-delete retention `0`, and two lifecycle rules. The
bucket policy contains only the operator's bucket administrator and the runtime
object-user binding. Neither bucket nor service policy contains `allUsers` or
`allAuthenticatedUsers`.

`gcloud` identity tokens are for development verification only. Production
desktop authentication remains a later checkpoint.

## Checkpoint 3

The worker implementation and cloud operations are documented in
`CP3-OPERATIONS.md`. The desktop still uses its local Gemini pipeline until the
client-migration checkpoint.

## Next checkpoint

Checkpoint 4 will migrate Electron to the cloud job API, add polling and remote
error mapping, and remove the desktop requirement for `GEMINI_API_KEY`.
