"""Cloud Run REST API for versioned Apexiel prompt profiles."""

from __future__ import annotations

import hmac
import os
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from .domain import PromptConflictError, PromptDomainError, PromptNotFoundError
from .store import JsonPromptStore, PromptStore


API_SCHEMA_VERSION = 1
MAX_REQUEST_BYTES = 16_384
MIN_ADMIN_TOKEN_LENGTH = 32


class DraftPromptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profileId: str
    name: str
    instructions: str
    releaseNotes: str = ""
    minimumClientVersion: str


def build_store_from_environment() -> PromptStore:
    backend = os.getenv("PROMPT_STORE_BACKEND")
    if backend is None:
        backend = "firestore" if os.getenv("K_SERVICE") else "json"
    if backend == "firestore":
        from .firestore_store import FirestorePromptStore

        return FirestorePromptStore(os.getenv("GOOGLE_CLOUD_PROJECT"))
    if backend == "json":
        path = os.getenv(
            "PROMPT_FILE_STORE_PATH",
            os.fspath(Path(__file__).resolve().parent.parent / "data" / "profiles.json"),
        )
        return JsonPromptStore(path)
    raise RuntimeError("PROMPT_STORE_BACKEND must be 'firestore' or 'json'")


def create_app(
    *,
    store: PromptStore | None = None,
    admin_token: str | None = None,
) -> FastAPI:
    prompt_store = store or build_store_from_environment()
    configured_admin_token = (
        admin_token if admin_token is not None else os.getenv("PROMPT_ADMIN_TOKEN")
    )
    if (
        configured_admin_token is not None
        and len(configured_admin_token) < MIN_ADMIN_TOKEN_LENGTH
    ):
        raise RuntimeError(
            f"PROMPT_ADMIN_TOKEN must contain at least {MIN_ADMIN_TOKEN_LENGTH} characters"
        )

    service = FastAPI(
        title="Apexiel Prompt Service",
        version="1.0.0",
        description="Versioned prompt profile publishing for the Apexiel video editor.",
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
        return await call_next(request)

    def require_admin(
        authorization: Annotated[str | None, Header()] = None,
    ) -> None:
        if configured_admin_token is None:
            raise HTTPException(
                status_code=503,
                detail="Administrative access is not configured.",
            )
        scheme, separator, supplied_token = (authorization or "").partition(" ")
        if (
            separator != " "
            or scheme.lower() != "bearer"
            or not hmac.compare_digest(supplied_token, configured_admin_token)
        ):
            raise HTTPException(status_code=401, detail="Invalid administrator token.")

    @service.exception_handler(PromptNotFoundError)
    async def handle_not_found(_request: Request, error: PromptNotFoundError):
        return JSONResponse(status_code=404, content={"detail": str(error)})

    @service.exception_handler(PromptConflictError)
    async def handle_conflict(_request: Request, error: PromptConflictError):
        return JSONResponse(status_code=409, content={"detail": str(error)})

    @service.exception_handler(PromptDomainError)
    async def handle_domain_error(_request: Request, error: PromptDomainError):
        return JSONResponse(status_code=400, content={"detail": str(error)})

    @service.get("/health")
    def health() -> dict[str, object]:
        return {"status": "ok", "schemaVersion": API_SCHEMA_VERSION}

    @service.get("/v1/prompt-profiles/active")
    def get_active(request: Request) -> Response:
        revision = prompt_store.get_active()
        if revision is None:
            raise HTTPException(
                status_code=404,
                detail="No prompt profile has been published.",
            )
        etag = revision.etag()
        headers = {
            "Cache-Control": "public, max-age=300",
            "ETag": f'"{etag}"',
        }
        if request.headers.get("if-none-match") == f'"{etag}"':
            return Response(status_code=304, headers=headers)
        return JSONResponse(
            content={
                "schemaVersion": API_SCHEMA_VERSION,
                "profile": revision.public_dict(),
            },
            headers=headers,
        )

    @service.get(
        "/v1/admin/prompt-profiles",
        dependencies=[Depends(require_admin)],
    )
    def list_profiles(profileId: str | None = None) -> dict[str, object]:
        revisions = prompt_store.list_revisions(profileId)
        return {
            "schemaVersion": API_SCHEMA_VERSION,
            "revisions": [revision.admin_dict() for revision in revisions],
        }

    @service.post(
        "/v1/admin/prompt-profiles/drafts",
        status_code=201,
        dependencies=[Depends(require_admin)],
    )
    def create_draft(request: DraftPromptRequest) -> dict[str, object]:
        revision = prompt_store.create_draft(
            profile_id=request.profileId,
            name=request.name,
            instructions=request.instructions,
            release_notes=request.releaseNotes,
            minimum_client_version=request.minimumClientVersion,
        )
        return {
            "schemaVersion": API_SCHEMA_VERSION,
            "revision": revision.admin_dict(),
        }

    @service.post(
        "/v1/admin/prompt-profiles/{profile_id}/revisions/{version}/publish",
        dependencies=[Depends(require_admin)],
    )
    def publish(profile_id: str, version: int) -> dict[str, object]:
        revision = prompt_store.publish(profile_id, version)
        return {
            "schemaVersion": API_SCHEMA_VERSION,
            "profile": revision.public_dict(),
        }

    return service


app = create_app()

