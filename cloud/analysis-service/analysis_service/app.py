"""Authenticated Cloud Run boundary for Apexiel analysis jobs."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field


API_SCHEMA_VERSION = 1
MAX_REQUEST_BYTES = 64 * 1024
MAX_PROXY_BYTES = 512 * 1024 * 1024
MAX_SOURCE_DURATION_S = 6 * 60 * 60


class CreateAnalysisJobRequest(BaseModel):
    """Metadata required before issuing a proxy upload location."""

    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1]
    clientRequestId: UUID
    sourceDurationS: float = Field(gt=0, le=MAX_SOURCE_DURATION_S)
    proxySizeBytes: int = Field(gt=0, le=MAX_PROXY_BYTES)
    proxySha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    proxyContentType: Literal["video/mp4"]


def create_app() -> FastAPI:
    service = FastAPI(
        title="Apexiel Analysis Service",
        version="0.1.0",
        description="Private job boundary for cloud-backed vehicle analysis.",
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
            "analysisJobs": False,
            "proxyUploads": False,
            "geminiAnalysis": False,
        }

    @service.post("/v1/analysis/jobs")
    def create_analysis_job(_request: CreateAnalysisJobRequest) -> None:
        raise HTTPException(
            status_code=503,
            detail="Analysis job creation is not configured.",
        )

    return service


app = create_app()
