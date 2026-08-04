"""Authenticated Cloud Run API for Apexiel analysis jobs."""

from __future__ import annotations

from datetime import datetime, timedelta
import logging
import os
from typing import Callable, Literal
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .analyzer import GeminiAnalyzer
from .domain import JobDomainError, new_job, utc_now
from .prompt_profiles import HttpPromptProfileProvider
from .store import (
    GcsJobStore,
    InMemoryJobStore,
    JobConflictError,
    JobNotFoundError,
    JobStore,
)
from .tasks import (
    DisabledTaskDispatcher,
    GoogleCloudTaskDispatcher,
    TaskDispatchError,
    TaskDispatcher,
)
from .uploads import (
    DisabledProxyUploads,
    GoogleCloudProxyUploads,
    JOB_METADATA_KEY,
    ProxyUploads,
    SHA256_METADATA_KEY,
)
from .worker import (
    AnalysisWorker,
    DisabledAnalysisWorker,
    ServerAnalysisWorker,
    WorkerError,
)


LOGGER = logging.getLogger(__name__)
API_SCHEMA_VERSION = 1
MAX_REQUEST_BYTES = 64 * 1024
MAX_PROXY_BYTES = 512 * 1024 * 1024
MAX_SOURCE_DURATION_S = 6 * 60 * 60
MAX_WORKER_ATTEMPTS = 3
DEFAULT_UPLOAD_TTL_SECONDS = 15 * 60
DEFAULT_JOB_TTL_HOURS = 7 * 24
DEFAULT_TASK_DEADLINE_SECONDS = 30 * 60


class CreateAnalysisJobRequest(BaseModel):
    """Metadata required before issuing a proxy upload location."""

    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1]
    clientRequestId: UUID
    sourceDurationS: float = Field(gt=0, le=MAX_SOURCE_DURATION_S)
    proxySizeBytes: int = Field(gt=0, le=MAX_PROXY_BYTES)
    proxySha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    proxyContentType: Literal["video/mp4"]


class WorkerTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1]


def _positive_environment_integer(
    name: str,
    default: int,
    *,
    minimum: int,
    maximum: int,
) -> int:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
    except ValueError as error:
        raise RuntimeError(f"{name} must be an integer") from error
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _required_environment(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if not value:
        raise RuntimeError(f"{name} is required on Cloud Run")
    return value


def _build_services_from_environment(
) -> tuple[JobStore, ProxyUploads, TaskDispatcher, AnalysisWorker]:
    bucket_name = (os.getenv("ANALYSIS_BUCKET") or "").strip()
    if not bucket_name and not os.getenv("K_SERVICE"):
        uploads = DisabledProxyUploads()
        return (
            InMemoryJobStore(),
            uploads,
            DisabledTaskDispatcher(),
            DisabledAnalysisWorker(),
        )

    bucket_name = _required_environment("ANALYSIS_BUCKET")
    service_account_email = _required_environment(
        "ANALYSIS_SERVICE_ACCOUNT_EMAIL"
    )
    queue_path = _required_environment("ANALYSIS_TASK_QUEUE")
    service_url = _required_environment("ANALYSIS_SERVICE_URL")
    invoker_service_account = _required_environment(
        "ANALYSIS_TASK_INVOKER_SERVICE_ACCOUNT"
    )
    prompt_service_url = _required_environment("PROMPT_SERVICE_URL")
    task_deadline_seconds = _positive_environment_integer(
        "ANALYSIS_TASK_DEADLINE_SECONDS",
        DEFAULT_TASK_DEADLINE_SECONDS,
        minimum=60,
        maximum=1800,
    )

    uploads = GoogleCloudProxyUploads(bucket_name, service_account_email)
    tasks = GoogleCloudTaskDispatcher(
        queue_path=queue_path,
        service_url=service_url,
        invoker_service_account=invoker_service_account,
        dispatch_deadline_seconds=task_deadline_seconds,
    )
    worker = ServerAnalysisWorker(
        uploads=uploads,
        prompt_provider=HttpPromptProfileProvider(prompt_service_url),
        analyzer=GeminiAnalyzer(),
    )
    return GcsJobStore(bucket_name), uploads, tasks, worker


def _wire_timestamp(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _task_retry_count(request: Request) -> int:
    raw_value = request.headers.get("x-cloudtasks-taskretrycount", "0")
    try:
        return max(0, int(raw_value))
    except ValueError:
        return 0


def create_app(
    *,
    store: JobStore | None = None,
    uploads: ProxyUploads | None = None,
    tasks: TaskDispatcher | None = None,
    worker: AnalysisWorker | None = None,
    clock: Callable[[], datetime] = utc_now,
    upload_ttl_seconds: int | None = None,
    job_ttl_hours: int | None = None,
) -> FastAPI:
    if (store is None) != (uploads is None):
        raise RuntimeError("store and uploads must be configured together")
    if store is None or uploads is None:
        if tasks is not None or worker is not None:
            raise RuntimeError("all service dependencies must be configured together")
        store, uploads, tasks, worker = _build_services_from_environment()
    else:
        tasks = tasks or DisabledTaskDispatcher()
        worker = worker or DisabledAnalysisWorker()
    if tasks.enabled != worker.enabled:
        raise RuntimeError("task dispatch and analysis worker must be enabled together")

    upload_ttl_seconds = upload_ttl_seconds or _positive_environment_integer(
        "ANALYSIS_UPLOAD_TTL_SECONDS",
        DEFAULT_UPLOAD_TTL_SECONDS,
        minimum=60,
        maximum=60 * 60,
    )
    job_ttl_hours = job_ttl_hours or _positive_environment_integer(
        "ANALYSIS_JOB_TTL_HOURS",
        DEFAULT_JOB_TTL_HOURS,
        minimum=24,
        maximum=30 * 24,
    )
    upload_ttl = timedelta(seconds=upload_ttl_seconds)
    job_ttl = timedelta(hours=job_ttl_hours)

    service = FastAPI(
        title="Apexiel Analysis Service",
        version="0.3.0",
        description="Private upload and server-side Gemini analysis service.",
    )

    @service.middleware("http")
    async def enforce_request_size(request: Request, call_next):
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > MAX_REQUEST_BYTES:
                    return JSONResponse(
                        status_code=413,
                        content={"detail": "Request body is too large."},
                    )
            except ValueError:
                return JSONResponse(
                    status_code=400,
                    content={"detail": "Invalid Content-Length header."},
                )

        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @service.exception_handler(JobNotFoundError)
    async def handle_job_not_found(_request: Request, error: JobNotFoundError):
        return JSONResponse(status_code=404, content={"detail": str(error)})

    @service.exception_handler(JobConflictError)
    async def handle_job_conflict(_request: Request, error: JobConflictError):
        return JSONResponse(status_code=409, content={"detail": str(error)})

    @service.exception_handler(JobDomainError)
    async def handle_job_domain(_request: Request, error: JobDomainError):
        return JSONResponse(status_code=400, content={"detail": str(error)})

    def active_job(job_id: str):
        job = store.get(job_id)
        if job.expires_at <= clock():
            raise HTTPException(status_code=410, detail="Analysis job has expired.")
        return job

    @service.get("/health")
    def health() -> dict[str, object]:
        return {
            "status": "ok",
            "schemaVersion": API_SCHEMA_VERSION,
            "service": "apexiel-analysis-service",
        }

    @service.get("/v1/capabilities")
    def capabilities() -> dict[str, object]:
        return {
            "schemaVersion": API_SCHEMA_VERSION,
            "analysisJobs": uploads.enabled,
            "proxyUploads": uploads.enabled,
            "geminiAnalysis": worker.enabled,
            "asynchronousAnalysis": tasks.enabled,
        }

    @service.post("/v1/analysis/jobs")
    def create_analysis_job(
        request: CreateAnalysisJobRequest,
        response: Response,
    ) -> dict[str, object]:
        if not uploads.enabled:
            raise HTTPException(
                status_code=503,
                detail="Analysis job creation is not configured.",
            )

        now = clock()
        candidate = new_job(
            client_request_id=request.clientRequestId,
            source_duration_s=request.sourceDurationS,
            proxy_size_bytes=request.proxySizeBytes,
            proxy_sha256=request.proxySha256,
            proxy_content_type=request.proxyContentType,
            now=now,
            upload_ttl=upload_ttl,
            job_ttl=job_ttl,
        )
        job, created = store.create(candidate)
        if not job.same_request(
            source_duration_s=request.sourceDurationS,
            proxy_size_bytes=request.proxySizeBytes,
            proxy_sha256=request.proxySha256,
            proxy_content_type=request.proxyContentType,
        ):
            raise JobConflictError(
                "clientRequestId is already associated with different proxy metadata."
            )
        if job.expires_at <= now:
            raise HTTPException(status_code=410, detail="Analysis job has expired.")

        if job.state != "awaiting_upload":
            response.status_code = 200
            return {"schemaVersion": API_SCHEMA_VERSION, "job": job.public_dict()}

        upload_expires_at = min(now + upload_ttl, job.expires_at)
        job = store.update(
            job.job_id,
            lambda current: current.with_upload_expiration(upload_expires_at, now),
        )
        grant = uploads.create_grant(job)
        response.status_code = 201 if created else 200
        return {
            "schemaVersion": API_SCHEMA_VERSION,
            "job": job.public_dict(),
            "upload": {
                "url": grant.url,
                "method": "PUT",
                "requiredHeaders": dict(grant.required_headers),
                "expiresAt": _wire_timestamp(grant.expires_at),
            },
        }

    @service.get("/v1/analysis/jobs/{job_id}")
    def get_analysis_job(job_id: UUID) -> dict[str, object]:
        job = active_job(str(job_id))
        return {"schemaVersion": API_SCHEMA_VERSION, "job": job.public_dict()}

    @service.post("/v1/analysis/jobs/{job_id}/upload-complete")
    def complete_proxy_upload(job_id: UUID) -> dict[str, object]:
        job = active_job(str(job_id))
        if job.state == "awaiting_upload":
            stored = uploads.inspect(job.proxy_object)
            if stored is None:
                raise JobConflictError("The proxy upload has not completed.")

            valid = (
                stored.size_bytes == job.proxy_size_bytes
                and stored.content_type == job.proxy_content_type
                and stored.metadata.get(JOB_METADATA_KEY) == job.job_id
                and stored.metadata.get(SHA256_METADATA_KEY) == job.proxy_sha256
            )
            if not valid:
                uploads.delete(job.proxy_object, stored.generation)
                raise HTTPException(
                    status_code=400,
                    detail="Uploaded proxy metadata did not match the analysis job.",
                )

            now = clock()
            job = store.update(
                job.job_id,
                lambda current: current.with_uploaded(stored.generation, now),
            )

        if tasks.enabled and job.state == "uploaded":
            now = clock()
            job = store.update(
                job.job_id,
                lambda current: current.with_queued(now),
            )
        if tasks.enabled and job.state == "queued":
            try:
                tasks.dispatch(job.job_id)
            except TaskDispatchError as error:
                raise HTTPException(status_code=503, detail=str(error)) from error

        return {"schemaVersion": API_SCHEMA_VERSION, "job": job.public_dict()}

    @service.post("/v1/internal/analysis/jobs/{job_id}/run")
    def run_analysis_worker(
        job_id: UUID,
        task_request: WorkerTaskRequest,
        request: Request,
    ) -> dict[str, object]:
        del task_request
        if not tasks.enabled or not worker.enabled:
            raise HTTPException(status_code=503, detail="Analysis worker is disabled.")
        if not tasks.accepts(request.headers):
            raise HTTPException(status_code=403, detail="Cloud Tasks request required.")

        try:
            job = store.get(str(job_id))
        except JobNotFoundError:
            return {"schemaVersion": API_SCHEMA_VERSION, "status": "discarded"}
        if job.expires_at <= clock():
            return {"schemaVersion": API_SCHEMA_VERSION, "status": "expired"}
        if job.state in {"completed", "failed"}:
            return {"schemaVersion": API_SCHEMA_VERSION, "job": job.public_dict()}
        if job.state == "processing" and _task_retry_count(request) == 0:
            raise HTTPException(status_code=409, detail="Analysis is already processing.")
        if job.state not in {"queued", "processing"}:
            raise HTTPException(status_code=409, detail="Analysis job is not queued.")

        now = clock()
        job = store.update(
            job.job_id,
            lambda current: current.with_processing(
                now,
                allow_retry=current.state == "processing" and _task_retry_count(request) > 0,
            ),
        )
        try:
            result = worker.run(job)
            completed_at = clock()
            try:
                job = store.update(
                    job.job_id,
                    lambda current: current.with_completed(
                        detections=result.detections,
                        model=result.model,
                        prompt_profile_id=result.prompt_profile_id,
                        prompt_profile_version=result.prompt_profile_version,
                        prompt_etag=result.prompt_etag,
                        input_tokens=result.input_tokens,
                        output_tokens=result.output_tokens,
                        updated_at=completed_at,
                    ),
                )
            except JobDomainError as error:
                raise WorkerError(
                    "parsing",
                    "invalid_results",
                    "Gemini returned invalid detection results.",
                ) from error
        except WorkerError as error:
            current = store.get(job.job_id)
            failed_at = clock()
            if error.retryable and current.analysis_attempts < MAX_WORKER_ATTEMPTS:
                store.update(
                    job.job_id,
                    lambda active: active.with_retry_queued(failed_at),
                )
                raise HTTPException(status_code=503, detail="Analysis will be retried.")
            job = store.update(
                job.job_id,
                lambda current: current.with_failed(
                    stage=error.stage,
                    code=error.code,
                    message=error.message,
                    proxy_verified=error.proxy_verified,
                    updated_at=failed_at,
                ),
            )
        except Exception:
            LOGGER.exception("Unexpected analysis worker failure for job %s", job.job_id)
            current = store.get(job.job_id)
            failed_at = clock()
            if current.analysis_attempts < MAX_WORKER_ATTEMPTS:
                store.update(
                    job.job_id,
                    lambda active: active.with_retry_queued(failed_at),
                )
                raise HTTPException(status_code=503, detail="Analysis will be retried.")
            job = store.update(
                job.job_id,
                lambda current: current.with_failed(
                    stage="internal",
                    code="worker_internal_error",
                    message="The analysis worker failed unexpectedly.",
                    proxy_verified=False,
                    updated_at=failed_at,
                ),
            )
        return {"schemaVersion": API_SCHEMA_VERSION, "job": job.public_dict()}

    @service.delete("/v1/analysis/jobs/{job_id}", status_code=204)
    def delete_analysis_job(job_id: UUID) -> Response:
        job = store.get(str(job_id))
        if job.state == "processing":
            raise JobConflictError("A processing analysis job cannot be deleted.")
        stored = uploads.inspect(job.proxy_object)
        if stored is not None:
            uploads.delete(job.proxy_object, stored.generation)
        store.delete(job.job_id)
        return Response(status_code=204)

    return service


app = create_app()
