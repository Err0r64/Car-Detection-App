"""Analysis job state, transitions, and wire representations."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
import math
import re
from typing import Any
from uuid import UUID


VALID_STATES = frozenset(
    {
        "awaiting_upload",
        "uploaded",
        "queued",
        "processing",
        "completed",
        "failed",
        "canceled",
    }
)
PROFILE_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{2,63}$")
ETAG_PATTERN = re.compile(r"^[0-9a-f]{64}$")
ERROR_CODE_PATTERN = re.compile(r"^[a-z][a-z0-9_]{2,63}$")
MAX_DETECTIONS = 1000


class JobDomainError(ValueError):
    """A stored job or requested state transition is invalid."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _timestamp(value: Any, field: str) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise JobDomainError(f"{field} must be a timestamp") from error
    else:
        raise JobDomainError(f"{field} must be a timestamp")
    if parsed.tzinfo is None:
        raise JobDomainError(f"{field} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _optional_timestamp(value: Any, field: str) -> datetime | None:
    return None if value is None else _timestamp(value, field)


def _wire_timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _nonnegative_integer(value: Any, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise JobDomainError(f"{field} must be a nonnegative integer")
    return value


def _optional_nonnegative_integer(value: Any, field: str) -> int | None:
    return None if value is None else _nonnegative_integer(value, field)


def _clean_error_text(value: Any, field: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise JobDomainError(f"{field} must be a string")
    cleaned = " ".join(value.split())
    if not cleaned or len(cleaned) > maximum:
        raise JobDomainError(f"{field} is invalid")
    return cleaned


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise JobDomainError(f"{field} must be numeric")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise JobDomainError(f"{field} must be numeric") from error
    if not math.isfinite(number):
        raise JobDomainError(f"{field} must be finite")
    return number


def _clean_detections(
    value: Any,
    source_duration_s: float,
) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, (list, tuple)) or len(value) > MAX_DETECTIONS:
        raise JobDomainError("detections must be a bounded array")
    required = {"car_number", "start_s", "end_s", "subject", "confidence", "notes"}
    detections: list[dict[str, Any]] = []
    for index, item in enumerate(value, start=1):
        if not isinstance(item, dict) or set(item) != required:
            raise JobDomainError(f"Detection {index} is not schema-conformant")
        car_number = item["car_number"]
        notes = item["notes"]
        subject = item["subject"]
        confidence = item["confidence"]
        if not isinstance(car_number, str) or len(car_number) > 100:
            raise JobDomainError(f"Detection {index} has an invalid car number")
        if not isinstance(notes, str) or len(notes) > 2000 or "\x00" in notes:
            raise JobDomainError(f"Detection {index} has invalid notes")
        if not isinstance(subject, bool):
            raise JobDomainError(f"Detection {index} has an invalid subject flag")
        start_s = _number(item["start_s"], f"Detection {index} start")
        end_s = _number(item["end_s"], f"Detection {index} end")
        if not 0 <= start_s < end_s <= source_duration_s:
            raise JobDomainError(f"Detection {index} has invalid bounds")
        if confidence is not None:
            confidence = _number(confidence, f"Detection {index} confidence")
            if not 0 <= confidence <= 1:
                raise JobDomainError(f"Detection {index} has invalid confidence")
        detections.append(
            {
                "car_number": car_number,
                "start_s": start_s,
                "end_s": end_s,
                "subject": subject,
                "confidence": confidence,
                "notes": notes,
            }
        )
    return tuple(detections)


@dataclass(frozen=True)
class AnalysisJob:
    job_id: str
    client_request_id: str
    state: str
    source_duration_s: float
    proxy_size_bytes: int
    proxy_sha256: str
    proxy_content_type: str
    proxy_object: str
    created_at: datetime
    updated_at: datetime
    upload_expires_at: datetime
    expires_at: datetime
    object_generation: int | None = None
    sha256_verified_at: datetime | None = None
    analysis_attempts: int = 0
    analysis_started_at: datetime | None = None
    analysis_completed_at: datetime | None = None
    model: str | None = None
    prompt_profile_id: str | None = None
    prompt_profile_version: int | None = None
    prompt_etag: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    detections: tuple[dict[str, Any], ...] | None = None
    error_stage: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    retry_stage: str | None = None
    retry_code: str | None = None
    retry_message: str | None = None

    def same_request(
        self,
        *,
        source_duration_s: float,
        proxy_size_bytes: int,
        proxy_sha256: str,
        proxy_content_type: str,
    ) -> bool:
        return (
            self.source_duration_s == source_duration_s
            and self.proxy_size_bytes == proxy_size_bytes
            and self.proxy_sha256 == proxy_sha256
            and self.proxy_content_type == proxy_content_type
        )

    def with_upload_expiration(
        self,
        upload_expires_at: datetime,
        updated_at: datetime,
    ) -> "AnalysisJob":
        if self.state != "awaiting_upload":
            raise JobDomainError("Only awaiting-upload jobs can issue an upload URL")
        return replace(
            self,
            upload_expires_at=upload_expires_at,
            updated_at=updated_at,
        )

    def with_uploaded(self, generation: int, updated_at: datetime) -> "AnalysisJob":
        if generation < 1:
            raise JobDomainError("Object generation must be positive")
        if self.state == "uploaded":
            return self
        if self.state != "awaiting_upload":
            raise JobDomainError(f"Unsupported job state transition from {self.state}")
        return replace(
            self,
            state="uploaded",
            object_generation=generation,
            updated_at=updated_at,
        )

    def with_queued(self, updated_at: datetime) -> "AnalysisJob":
        if self.state == "queued":
            return self
        if self.state != "uploaded":
            raise JobDomainError(f"Unsupported job state transition from {self.state}")
        return replace(self, state="queued", updated_at=updated_at)

    def with_processing(
        self,
        updated_at: datetime,
        *,
        allow_retry: bool = False,
    ) -> "AnalysisJob":
        allowed = self.state == "queued" or (allow_retry and self.state == "processing")
        if not allowed:
            raise JobDomainError(f"Unsupported job state transition from {self.state}")
        return replace(
            self,
            state="processing",
            analysis_attempts=self.analysis_attempts + 1,
            analysis_started_at=updated_at,
            analysis_completed_at=None,
            updated_at=updated_at,
            error_stage=None,
            error_code=None,
            error_message=None,
            retry_stage=None,
            retry_code=None,
            retry_message=None,
        )

    def with_retry_queued(
        self, updated_at: datetime, *, stage: str, code: str, message: str
    ) -> "AnalysisJob":
        if self.state != "processing":
            raise JobDomainError("Only processing jobs can be retried")
        stage = _clean_error_text(stage, "retry stage", 32)
        if not ERROR_CODE_PATTERN.fullmatch(code):
            raise JobDomainError("retry code is invalid")
        message = _clean_error_text(message, "retry message", 500)
        return replace(
            self,
            state="queued",
            analysis_started_at=None,
            updated_at=updated_at,
            retry_stage=stage,
            retry_code=code,
            retry_message=message,
        )

    def with_canceled(self, updated_at: datetime) -> "AnalysisJob":
        if self.state == "canceled":
            return self
        if self.state != "processing":
            raise JobDomainError("Only processing jobs can be canceled")
        return replace(
            self,
            state="canceled",
            analysis_completed_at=updated_at,
            detections=None,
            error_stage=None,
            error_code=None,
            error_message=None,
            retry_stage=None,
            retry_code=None,
            retry_message=None,
            updated_at=updated_at,
        )

    def with_completed(
        self,
        *,
        detections: Any,
        model: str,
        prompt_profile_id: str,
        prompt_profile_version: int,
        prompt_etag: str,
        input_tokens: int,
        output_tokens: int,
        updated_at: datetime,
    ) -> "AnalysisJob":
        if self.state != "processing":
            raise JobDomainError("Only processing jobs can complete")
        cleaned_detections = _clean_detections(detections, self.source_duration_s)
        if not isinstance(model, str) or not model.strip() or len(model) > 100:
            raise JobDomainError("Analysis model is invalid")
        if not PROFILE_ID_PATTERN.fullmatch(prompt_profile_id):
            raise JobDomainError("Prompt profile ID is invalid")
        if (
            not isinstance(prompt_profile_version, int)
            or isinstance(prompt_profile_version, bool)
            or prompt_profile_version < 1
        ):
            raise JobDomainError("Prompt profile version is invalid")
        if not ETAG_PATTERN.fullmatch(prompt_etag):
            raise JobDomainError("Prompt profile ETag is invalid")
        return replace(
            self,
            state="completed",
            sha256_verified_at=updated_at,
            analysis_completed_at=updated_at,
            model=model.strip(),
            prompt_profile_id=prompt_profile_id,
            prompt_profile_version=prompt_profile_version,
            prompt_etag=prompt_etag,
            input_tokens=_nonnegative_integer(input_tokens, "inputTokens"),
            output_tokens=_nonnegative_integer(output_tokens, "outputTokens"),
            detections=cleaned_detections,
            updated_at=updated_at,
            retry_stage=None,
            retry_code=None,
            retry_message=None,
        )

    def with_failed(
        self,
        *,
        stage: str,
        code: str,
        message: str,
        proxy_verified: bool,
        updated_at: datetime,
    ) -> "AnalysisJob":
        if self.state != "processing":
            raise JobDomainError("Only processing jobs can fail")
        stage = _clean_error_text(stage, "error stage", 32)
        if not ERROR_CODE_PATTERN.fullmatch(code):
            raise JobDomainError("error code is invalid")
        message = _clean_error_text(message, "error message", 500)
        return replace(
            self,
            state="failed",
            sha256_verified_at=updated_at if proxy_verified else None,
            analysis_completed_at=updated_at,
            detections=None,
            error_stage=stage,
            error_code=code,
            error_message=message,
            updated_at=updated_at,
            retry_stage=None,
            retry_code=None,
            retry_message=None,
        )

    def public_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "schemaVersion": 1,
            "jobId": self.job_id,
            "clientRequestId": self.client_request_id,
            "state": self.state,
            "sourceDurationS": self.source_duration_s,
            "proxy": {
                "sizeBytes": self.proxy_size_bytes,
                "sha256": self.proxy_sha256,
                "contentType": self.proxy_content_type,
                "sha256Verified": self.sha256_verified_at is not None,
            },
            "createdAt": _wire_timestamp(self.created_at),
            "updatedAt": _wire_timestamp(self.updated_at),
            "expiresAt": _wire_timestamp(self.expires_at),
        }
        if self.state in {
            "queued",
            "processing",
            "completed",
            "failed",
            "canceled",
        }:
            result["analysis"] = {
                "attempts": self.analysis_attempts,
                "startedAt": _wire_timestamp(self.analysis_started_at),
                "completedAt": _wire_timestamp(self.analysis_completed_at),
                "model": self.model,
                "prompt": (
                    {
                        "profileId": self.prompt_profile_id,
                        "version": self.prompt_profile_version,
                        "etag": self.prompt_etag,
                    }
                    if self.prompt_profile_id is not None
                    else None
                ),
                "inputTokens": self.input_tokens,
                "outputTokens": self.output_tokens,
                "retry": (
                    {
                        "stage": self.retry_stage,
                        "code": self.retry_code,
                        "message": self.retry_message,
                    }
                    if self.retry_code is not None
                    else None
                ),
            }
        if self.state == "completed":
            result["results"] = {
                "detections": [dict(detection) for detection in self.detections or ()]
            }
        if self.state == "failed":
            result["error"] = {
                "stage": self.error_stage,
                "code": self.error_code,
                "message": self.error_message,
            }
        return result

    def record_dict(self) -> dict[str, Any]:
        result = {
            "schemaVersion": 1,
            "jobId": self.job_id,
            "clientRequestId": self.client_request_id,
            "state": self.state,
            "sourceDurationS": self.source_duration_s,
            "proxySizeBytes": self.proxy_size_bytes,
            "proxySha256": self.proxy_sha256,
            "proxyContentType": self.proxy_content_type,
            "proxyObject": self.proxy_object,
            "createdAt": _wire_timestamp(self.created_at),
            "updatedAt": _wire_timestamp(self.updated_at),
            "uploadExpiresAt": _wire_timestamp(self.upload_expires_at),
            "expiresAt": _wire_timestamp(self.expires_at),
            "objectGeneration": self.object_generation,
            "sha256VerifiedAt": _wire_timestamp(self.sha256_verified_at),
            "analysisAttempts": self.analysis_attempts,
            "analysisStartedAt": _wire_timestamp(self.analysis_started_at),
            "analysisCompletedAt": _wire_timestamp(self.analysis_completed_at),
            "model": self.model,
            "promptProfileId": self.prompt_profile_id,
            "promptProfileVersion": self.prompt_profile_version,
            "promptEtag": self.prompt_etag,
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "detections": (
                [dict(detection) for detection in self.detections]
                if self.detections is not None
                else None
            ),
            "error": (
                {
                    "stage": self.error_stage,
                    "code": self.error_code,
                    "message": self.error_message,
                }
                if self.error_code is not None
                else None
            ),
            "retry": (
                {
                    "stage": self.retry_stage,
                    "code": self.retry_code,
                    "message": self.retry_message,
                }
                if self.retry_code is not None
                else None
            ),
        }
        return result

    @classmethod
    def from_record(cls, value: Any) -> "AnalysisJob":
        if not isinstance(value, dict) or value.get("schemaVersion") != 1:
            raise JobDomainError("Stored job must use schemaVersion 1")
        try:
            job_id = str(UUID(str(value["jobId"])))
            client_request_id = str(UUID(str(value["clientRequestId"])))
            state = value["state"]
            source_duration_s = _number(value["sourceDurationS"], "sourceDurationS")
            proxy_size_bytes = value["proxySizeBytes"]
            proxy_sha256 = value["proxySha256"]
            proxy_content_type = value["proxyContentType"]
            proxy_object = value["proxyObject"]
            generation = value.get("objectGeneration")
        except (KeyError, TypeError, ValueError) as error:
            raise JobDomainError("Stored job fields are invalid") from error

        if state not in VALID_STATES:
            raise JobDomainError("Stored job state is invalid")
        if not 0 < source_duration_s <= 6 * 60 * 60:
            raise JobDomainError("Stored source duration is invalid")
        if (
            not isinstance(proxy_size_bytes, int)
            or isinstance(proxy_size_bytes, bool)
            or not 0 < proxy_size_bytes <= 512 * 1024 * 1024
        ):
            raise JobDomainError("Stored proxy size is invalid")
        if (
            not isinstance(proxy_sha256, str)
            or len(proxy_sha256) != 64
            or any(character not in "0123456789abcdef" for character in proxy_sha256)
        ):
            raise JobDomainError("Stored proxy SHA-256 is invalid")
        if proxy_content_type != "video/mp4":
            raise JobDomainError("Stored proxy content type is invalid")
        if proxy_object != f"uploads/{job_id}/proxy.mp4":
            raise JobDomainError("Stored proxy object does not match the job")
        if generation is not None and (
            not isinstance(generation, int)
            or isinstance(generation, bool)
            or generation < 1
        ):
            raise JobDomainError("Stored object generation is invalid")
        if state != "awaiting_upload" and generation is None:
            raise JobDomainError("Uploaded jobs require an object generation")

        sha256_verified_at = _optional_timestamp(
            value.get("sha256VerifiedAt"), "sha256VerifiedAt"
        )
        analysis_attempts = _nonnegative_integer(
            value.get("analysisAttempts", 0), "analysisAttempts"
        )
        analysis_started_at = _optional_timestamp(
            value.get("analysisStartedAt"), "analysisStartedAt"
        )
        analysis_completed_at = _optional_timestamp(
            value.get("analysisCompletedAt"), "analysisCompletedAt"
        )
        model = value.get("model")
        prompt_profile_id = value.get("promptProfileId")
        prompt_profile_version = value.get("promptProfileVersion")
        prompt_etag = value.get("promptEtag")
        input_tokens = _optional_nonnegative_integer(value.get("inputTokens"), "inputTokens")
        output_tokens = _optional_nonnegative_integer(
            value.get("outputTokens"), "outputTokens"
        )
        detections = value.get("detections")
        error = value.get("error")
        retry = value.get("retry")

        if state == "processing" and analysis_started_at is None:
            raise JobDomainError("Processing jobs require a start timestamp")
        if state == "completed":
            if (
                sha256_verified_at is None
                or analysis_completed_at is None
                or not isinstance(model, str)
                or not isinstance(prompt_profile_id, str)
                or not PROFILE_ID_PATTERN.fullmatch(prompt_profile_id)
                or not isinstance(prompt_profile_version, int)
                or isinstance(prompt_profile_version, bool)
                or prompt_profile_version < 1
                or not isinstance(prompt_etag, str)
                or not ETAG_PATTERN.fullmatch(prompt_etag)
                or input_tokens is None
                or output_tokens is None
            ):
                raise JobDomainError("Completed job metadata is invalid")
            detections = _clean_detections(detections, source_duration_s)
        elif detections is not None:
            raise JobDomainError("Only completed jobs may store detections")

        error_stage = error_code = error_message = None
        if state == "failed":
            if not isinstance(error, dict) or analysis_completed_at is None:
                raise JobDomainError("Failed job metadata is invalid")
            error_stage = _clean_error_text(error.get("stage"), "error stage", 32)
            error_code = error.get("code")
            if not isinstance(error_code, str) or not ERROR_CODE_PATTERN.fullmatch(error_code):
                raise JobDomainError("Stored error code is invalid")
            error_message = _clean_error_text(
                error.get("message"), "error message", 500
            )
        elif error is not None:
            raise JobDomainError("Only failed jobs may store an error")

        retry_stage = retry_code = retry_message = None
        if retry is not None:
            if state != "queued" or not isinstance(retry, dict):
                raise JobDomainError("Only queued jobs may store retry details")
            retry_stage = _clean_error_text(
                retry.get("stage"), "retry stage", 32
            )
            retry_code = retry.get("code")
            if not isinstance(retry_code, str) or not ERROR_CODE_PATTERN.fullmatch(
                retry_code
            ):
                raise JobDomainError("Stored retry code is invalid")
            retry_message = _clean_error_text(
                retry.get("message"), "retry message", 500
            )

        if state == "canceled" and analysis_completed_at is None:
            raise JobDomainError("Canceled job metadata is invalid")

        return cls(
            job_id=job_id,
            client_request_id=client_request_id,
            state=state,
            source_duration_s=source_duration_s,
            proxy_size_bytes=proxy_size_bytes,
            proxy_sha256=proxy_sha256,
            proxy_content_type=proxy_content_type,
            proxy_object=proxy_object,
            created_at=_timestamp(value.get("createdAt"), "createdAt"),
            updated_at=_timestamp(value.get("updatedAt"), "updatedAt"),
            upload_expires_at=_timestamp(
                value.get("uploadExpiresAt"), "uploadExpiresAt"
            ),
            expires_at=_timestamp(value.get("expiresAt"), "expiresAt"),
            object_generation=generation,
            sha256_verified_at=sha256_verified_at,
            analysis_attempts=analysis_attempts,
            analysis_started_at=analysis_started_at,
            analysis_completed_at=analysis_completed_at,
            model=model,
            prompt_profile_id=prompt_profile_id,
            prompt_profile_version=prompt_profile_version,
            prompt_etag=prompt_etag,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            detections=detections,
            error_stage=error_stage,
            error_code=error_code,
            error_message=error_message,
            retry_stage=retry_stage,
            retry_code=retry_code,
            retry_message=retry_message,
        )


def new_job(
    *,
    client_request_id: UUID,
    source_duration_s: float,
    proxy_size_bytes: int,
    proxy_sha256: str,
    proxy_content_type: str,
    now: datetime,
    upload_ttl: timedelta,
    job_ttl: timedelta,
) -> AnalysisJob:
    job_id = str(client_request_id)
    return AnalysisJob(
        job_id=job_id,
        client_request_id=job_id,
        state="awaiting_upload",
        source_duration_s=source_duration_s,
        proxy_size_bytes=proxy_size_bytes,
        proxy_sha256=proxy_sha256,
        proxy_content_type=proxy_content_type,
        proxy_object=f"uploads/{job_id}/proxy.mp4",
        created_at=now,
        updated_at=now,
        upload_expires_at=now + upload_ttl,
        expires_at=now + job_ttl,
    )
