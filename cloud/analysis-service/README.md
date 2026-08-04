# Apexiel Analysis Service

This private Cloud Run service is the server-side boundary for vehicle-analysis
jobs. The desktop will eventually upload a locally generated proxy and receive
schema-validated detections without receiving or storing the Gemini credential.

Checkpoint 1 establishes the authenticated service and request contract only.
`POST /v1/analysis/jobs` validates metadata and then returns `503` until proxy
storage and the analysis worker are implemented in Checkpoint 2.

## Security boundary

- Deploy this as a separate Cloud Run service from the public prompt service.
- Keep the Cloud Run invoker IAM check enabled. Do not grant `allUsers` access.
- The runtime uses a dedicated service account with no project roles in this
  checkpoint.
- Local FastAPI execution does not emulate Cloud Run IAM. Authentication is
  verified against the deployed service.
- No Gemini key, administrator token, proxy, or detection result is accepted or
  stored yet.
- The metadata contract rejects unknown fields, credentials, unsupported media
  types, invalid hashes, proxies over 512 MiB, and videos over six hours.

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

In a second terminal:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8081/health'
Invoke-RestMethod 'http://127.0.0.1:8081/v1/capabilities'
```

Stop Uvicorn with `Ctrl+C`.

## Google Cloud deployment

Do not use the Cloud Console's **Create service** source selector for this
checkpoint. Deploying from source through `gcloud` sends this directory to
Cloud Build, which builds the Dockerfile and publishes the resulting image.

The commands below use the existing development project:

```powershell
$projectId = 'project-53ab0446-caac-4099-97d'
$region = 'us-west1'
$serviceName = 'apexiel-analysis-service'
$serviceAccountName = 'apexiel-analysis-service'
$buildServiceAccountName = 'apexiel-analysis-builder'
$developerAccount = (gcloud config get-value account).Trim()

gcloud config set project $projectId
gcloud services enable `
  run.googleapis.com `
  cloudbuild.googleapis.com `
  artifactregistry.googleapis.com
```

Create dedicated runtime and build identities once:

```powershell
$serviceAccount = "$serviceAccountName@$projectId.iam.gserviceaccount.com"
$buildServiceAccount = "$buildServiceAccountName@$projectId.iam.gserviceaccount.com"

gcloud iam service-accounts create $serviceAccountName `
  --display-name='Apexiel Analysis Service'

gcloud iam service-accounts create $buildServiceAccountName `
  --display-name='Apexiel Analysis Builder'

gcloud projects add-iam-policy-binding $projectId `
  --member="serviceAccount:$buildServiceAccount" `
  --role='roles/run.builder'
```

New service accounts and role grants can take about a minute to propagate. If
the first deployment reports that the builder cannot read the `run-sources`
object, wait briefly and retry the same deployment; do not grant a broader
storage role.

From `cloud\analysis-service`, deploy without enabling public access:

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
  --cpu=1 `
  --memory=512Mi `
  --concurrency=20 `
  --min-instances=0 `
  --max-instances=3 `
  --timeout=60

gcloud run services update $serviceName `
  --project=$projectId `
  --region=$region `
  --invoker-iam-check
```

Grant only the current developer account permission to invoke this service:

```powershell
gcloud run services add-iam-policy-binding $serviceName `
  --project=$projectId `
  --region=$region `
  --member="user:$developerAccount" `
  --role='roles/run.invoker'
```

## Deployed-service verification

Read the service URL:

```powershell
$serviceUrl = gcloud run services describe $serviceName `
  --project=$projectId `
  --region=$region `
  --format='value(status.url)'

$serviceUrl
```

An unauthenticated request must fail with HTTP `401` or `403`:

```powershell
try {
  Invoke-RestMethod "$serviceUrl/health"
  throw 'Expected the private service to reject this request.'
} catch {
  $statusCode = [int]$_.Exception.Response.StatusCode
  if ($statusCode -notin 401, 403) { throw }
  "Unauthenticated request rejected with HTTP $statusCode"
}
```

An authenticated request must return the analysis-service health document:

```powershell
$identityToken = gcloud auth print-identity-token
$headers = @{ Authorization = "Bearer $identityToken" }

Invoke-RestMethod "$serviceUrl/health" -Headers $headers
Invoke-RestMethod "$serviceUrl/v1/capabilities" -Headers $headers
```

Expected health fields are `status: ok`, `schemaVersion: 1`, and
`service: apexiel-analysis-service`. All three capability flags must be `false`
in Checkpoint 1.

Finally, confirm that no public principal has invocation permission:

```powershell
gcloud run services get-iam-policy $serviceName `
  --project=$projectId `
  --region=$region `
  --format=json
```

The policy must not contain `allUsers` or `allAuthenticatedUsers`. A locally
generated `gcloud` identity token is appropriate only for development testing;
the production desktop authentication design remains a later checkpoint.

## Next checkpoint

Checkpoint 2 will add a private Cloud Storage bucket, short-lived proxy uploads,
job persistence, and object lifecycle cleanup. Secret Manager access and the
Gemini worker follow only after the upload and authorization boundaries pass
manual verification.
