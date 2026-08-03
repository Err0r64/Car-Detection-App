# Apexiel Prompt Service

This service is the cloud control plane for versioned analysis prompts. It runs
independently from the Electron application so Apexiel can publish prompt changes
without rebuilding or redistributing the desktop installer.

This checkpoint only hosts prompt profiles. The desktop still creates the proxy
and calls Gemini locally until the next integration checkpoint.

## Service boundary

- `GET /health` is public.
- `GET /v1/prompt-profiles/active` is public and returns only the active
  published profile.
- `/v1/admin/*` requires `Authorization: Bearer <PROMPT_ADMIN_TOKEN>`.
- Revisions are immutable. Editing creates the next draft version.
- Publishing archives the previously active revision.
- Firestore is used on Cloud Run. An atomic JSON file is used for local
  development.
- Profiles can change domain instructions, but cannot set the Gemini model,
  output schema, endpoint, credentials, or application behavior.

## Local development

From `cloud\prompt-service` in PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt

$env:PROMPT_STORE_BACKEND = 'json'
$env:PROMPT_FILE_STORE_PATH = (Join-Path $PWD 'data\profiles.json')
$env:PROMPT_ADMIN_TOKEN = 'replace-with-a-local-token-at-least-32-characters'

python -m uvicorn prompt_service.app:app --reload --port 8080
```

Open `http://127.0.0.1:8080/docs` for the generated OpenAPI interface. In a
second PowerShell terminal, set the same token and create the initial draft:

```powershell
$env:PROMPT_ADMIN_TOKEN = 'replace-with-a-local-token-at-least-32-characters'

python scripts\prompt_admin.py `
  --service-url 'http://127.0.0.1:8080' `
  create `
  --file seed\motorsports-default.json

python scripts\prompt_admin.py `
  --service-url 'http://127.0.0.1:8080' `
  publish `
  --profile-id 'motorsports-default' `
  --version 1

python scripts\prompt_admin.py `
  --service-url 'http://127.0.0.1:8080' `
  active
```

The final command must return `schemaVersion: 1`, profile version `1`, and an
`etag`. Stop Uvicorn with `Ctrl+C`.

Run the service tests from the same directory:

```powershell
$env:PYTHONPATH = $PWD.Path
python -m unittest discover -s tests -v
```

## Google Cloud prerequisites

Use a dedicated Google Cloud project while this is under development. The
project requires billing, the
[Google Cloud CLI](https://cloud.google.com/sdk/docs/install-sdk#windows), and a
Firestore Native Mode database. Install `gcloud`, close and reopen PowerShell,
and confirm `gcloud --version` works before continuing. The commands below
assume:

```powershell
$projectId = 'YOUR_UNIQUE_GOOGLE_CLOUD_PROJECT_ID'
$region = 'us-west1'
$serviceName = 'apexiel-prompt-service'
$serviceAccountName = 'apexiel-prompt-service'
$buildServiceAccountName = 'apexiel-prompt-builder'
$secretName = 'apexiel-prompt-admin-token'
```

Authenticate and enable the required services:

```powershell
gcloud auth login
gcloud config set project $projectId

gcloud services enable `
  run.googleapis.com `
  cloudbuild.googleapis.com `
  artifactregistry.googleapis.com `
  firestore.googleapis.com `
  secretmanager.googleapis.com
```

Create the default Firestore database once. If the project already has a
default Firestore or Datastore database, inspect it before running this command:

```powershell
gcloud firestore databases create `
  --database='(default)' `
  --location=$region `
  --type=firestore-native `
  --delete-protection
```

Firestore location is effectively permanent for the default database. Select
the region Apexiel intends to use before creating the production database.

## Service identity and secret

Create a dedicated service account and grant only Firestore access:

```powershell
$serviceAccount = "$serviceAccountName@$projectId.iam.gserviceaccount.com"

gcloud iam service-accounts create $serviceAccountName `
  --display-name='Apexiel Prompt Service'

gcloud projects add-iam-policy-binding $projectId `
  --member="serviceAccount:$serviceAccount" `
  --role='roles/datastore.user'

$buildServiceAccount = "$buildServiceAccountName@$projectId.iam.gserviceaccount.com"

gcloud iam service-accounts create $buildServiceAccountName `
  --display-name='Apexiel Prompt Builder'

gcloud projects add-iam-policy-binding $projectId `
  --member="serviceAccount:$buildServiceAccount" `
  --role='roles/run.builder'
```

Generate a high-entropy administrator token locally. This token is for prompt
administrators only and must never be included in Electron, committed to Git, or
sent in a prompt response:

```powershell
$adminTokenBytes = New-Object byte[] 48
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
$random.GetBytes($adminTokenBytes)
$random.Dispose()
$adminToken = [Convert]::ToBase64String($adminTokenBytes)
$secretFile = Join-Path $env:TEMP 'apexiel-prompt-admin-token.txt'
[IO.File]::WriteAllText($secretFile, $adminToken)

gcloud secrets create $secretName --replication-policy='automatic'
gcloud secrets versions add $secretName --data-file=$secretFile
Remove-Item -LiteralPath $secretFile

gcloud secrets add-iam-policy-binding $secretName `
  --member="serviceAccount:$serviceAccount" `
  --role='roles/secretmanager.secretAccessor'
```

Keep `$adminToken` only in the current PowerShell session or a password manager.
It is needed to publish the first profile.

## Deploy to Cloud Run

From `cloud\prompt-service`, deploy the Dockerfile:

```powershell
gcloud run deploy $serviceName `
  --source . `
  --project=$projectId `
  --region=$region `
  --build-service-account="projects/$projectId/serviceAccounts/$buildServiceAccount" `
  --service-account=$serviceAccount `
  --no-invoker-iam-check `
  --default-url `
  --ingress=all `
  --set-env-vars='PROMPT_STORE_BACKEND=firestore' `
  --set-secrets="PROMPT_ADMIN_TOKEN=$secretName`:1" `
  --cpu=1 `
  --memory=512Mi `
  --concurrency=40 `
  --min-instances=0 `
  --max-instances=3 `
  --timeout=60
```

The service disables Cloud Run's platform invoker IAM check because installed
desktop clients need the read-only active-profile route without a Google
identity. Mutation routes remain protected by the application administrator
bearer token. Secret Manager version 1 is pinned explicitly; later rotations
must deploy the specific replacement version rather than `latest`.

Read and verify the deployed URL:

```powershell
$serviceUrl = gcloud run services describe $serviceName `
  --project=$projectId `
  --region=$region `
  --format='value(status.url)'

Invoke-RestMethod "$serviceUrl/health"
```

The response must be:

```json
{
  "status": "ok",
  "schemaVersion": 1
}
```

## Publish the initial profile

Retrieve the pinned administrator token into the current PowerShell process
without printing it:

```powershell
$env:PROMPT_ADMIN_TOKEN = gcloud secrets versions access 1 `
  --project=$projectId `
  --secret=$secretName

python scripts\prompt_admin.py `
  --service-url $serviceUrl `
  create `
  --file seed\motorsports-default.json

python scripts\prompt_admin.py `
  --service-url $serviceUrl `
  publish `
  --profile-id 'motorsports-default' `
  --version 1

python scripts\prompt_admin.py `
  --service-url $serviceUrl `
  active
```

For later edits, update a local JSON profile file, run `create`, and publish the
new version reported by the create response. A failed or unapproved draft does
not affect desktop clients.

List the complete revision history:

```powershell
python scripts\prompt_admin.py `
  --service-url $serviceUrl `
  list `
  --profile-id 'motorsports-default'
```

## Security properties and limits

- Cloud Run terminates HTTPS for the service.
- Only the administrator token can create or publish revisions.
- Token comparison is constant-time and the request body is limited to 16 KiB.
- Prompt names, identifiers, semantic client versions, instruction length, and
  unknown request fields are validated.
- Firestore publication uses a transaction, so clients cannot observe a partial
  active-profile update.
- The desktop will cache the last valid profile and retain a built-in fallback
  in the next checkpoint.
- The prompt is configuration, not a secret. The public endpoint intentionally
  allows it to be read.

The shared administrator token is acceptable for a personal prototype with one
operator. Before production handoff, replace it with Apexiel identity and
per-user administrator authorization, or place the admin API in a separate
private Cloud Run service. Add API Gateway or Cloud Armor if public-read traffic
requires quotas or abuse protection.

Do not store the Gemini key in this service yet. When analysis moves to the
cloud, create a separate Secret Manager secret and ensure Gemini calls are made
only by the server-side analysis worker.

## Token rotation

Generate a replacement token, add it as a new secret version, and deploy a new
Cloud Run revision:

```powershell
$replacementBytes = New-Object byte[] 48
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
$random.GetBytes($replacementBytes)
$random.Dispose()
$replacementToken = [Convert]::ToBase64String($replacementBytes)
$secretFile = Join-Path $env:TEMP 'apexiel-prompt-admin-token.txt'
[IO.File]::WriteAllText($secretFile, $replacementToken)

$versionName = gcloud secrets versions add $secretName `
  --data-file=$secretFile `
  --format='value(name)'
Remove-Item -LiteralPath $secretFile
$replacementVersion = ($versionName -split '/')[-1]

gcloud run services update $serviceName `
  --project=$projectId `
  --region=$region `
  --set-secrets="PROMPT_ADMIN_TOKEN=$secretName`:$replacementVersion"
```

Discard the old token after the new revision passes its health and admin tests.

## Apexiel handoff

The cleanest handoff is to deploy this service into an Apexiel-owned Google
Cloud project rather than transferring your personal project.

1. Apexiel selects its project, billing account, region, and administrators.
2. Repeat the Firestore, service account, secret, and deployment steps there.
3. Publish the validated active prompt in the Apexiel service.
4. Point the desktop configuration at the Apexiel Cloud Run URL.
5. Verify active-profile retrieval and one full analysis.
6. Remove the desktop configuration for your development service.
7. Delete or disable your personal Cloud Run service after the cutover.

Never transfer your personal Google credentials or service-account key files.
Cloud Run uses its service identity directly and does not require a downloaded
service-account key.

## Google Cloud references

- [Deploy Cloud Run services from source](https://cloud.google.com/run/docs/deploying-source-code)
- [Create and manage Firestore databases](https://cloud.google.com/firestore/docs/manage-databases)
- [Configure Secret Manager secrets for Cloud Run](https://cloud.google.com/run/docs/configuring/services/secrets)
- [Cloud Run service identities](https://cloud.google.com/run/docs/securing/service-identity)