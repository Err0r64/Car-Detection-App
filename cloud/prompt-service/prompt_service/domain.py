"""Prompt profile validation and wire representations."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timezone
import hashlib
import json
import re
from typing import Any


PROFILE_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{2,63}$")
SEMVER_PATTERN = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"
)
MAX_NAME_LENGTH = 80
MAX_INSTRUCTIONS_LENGTH = 12_000
MAX_RELEASE_NOTES_LENGTH = 500
VALID_STATUSES = frozenset({"draft", "published", "archived"})


class PromptDomainError(ValueError):
    """Base class for errors that can be returned to an API caller."""


class PromptNotFoundError(PromptDomainError):
    """The requested profile or revision does not exist."""


class PromptConflictError(PromptDomainError):
    """The requested state transition is invalid."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _clean_single_line(value: Any, field: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise PromptDomainError(f"{field} must be a string")
    cleaned = value.strip()
    if not cleaned:
        raise PromptDomainError(f"{field} must not be empty")
    if len(cleaned) > maximum:
        raise PromptDomainError(f"{field} must be no more than {maximum} characters")
    if any(ord(character) < 32 for character in cleaned):
        raise PromptDomainError(f"{field} must not contain control characters")
    return cleaned


def _clean_optional_text(value: Any, field: str, maximum: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise PromptDomainError(f"{field} must be a string")
    cleaned = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(cleaned) > maximum:
        raise PromptDomainError(f"{field} must be no more than {maximum} characters")
    if "\x00" in cleaned:
        raise PromptDomainError(f"{field} must not contain null characters")
    return cleaned


def validate_profile_id(value: Any) -> str:
    if not isinstance(value, str) or not PROFILE_ID_PATTERN.fullmatch(value):
        raise PromptDomainError(
            "profileId must be 3-64 lowercase letters, numbers, or hyphens "
            "and start with a letter"
        )
    return value


def validate_client_version(value: Any) -> str:
    if not isinstance(value, str) or not SEMVER_PATTERN.fullmatch(value):
        raise PromptDomainError("minimumClientVersion must be a semantic version")
    return value


@dataclass(frozen=True)
class PromptRevision:
    profile_id: str
    version: int
    name: str
    instructions: str
    release_notes: str
    minimum_client_version: str
    status: str
    created_at: str
    published_at: str | None = None

    def with_status(self, status: str, published_at: str | None = None) -> "PromptRevision":
        if status not in VALID_STATUSES:
            raise PromptDomainError(f"Unsupported prompt status: {status}")
        return replace(self, status=status, published_at=published_at)

    def etag(self) -> str:
        canonical = json.dumps(
            self.public_dict(include_etag=False),
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def public_dict(self, *, include_etag: bool = True) -> dict[str, Any]:
        result: dict[str, Any] = {
            "profileId": self.profile_id,
            "version": self.version,
            "name": self.name,
            "instructions": self.instructions,
            "releaseNotes": self.release_notes,
            "minimumClientVersion": self.minimum_client_version,
            "publishedAt": self.published_at,
        }
        if include_etag:
            result["etag"] = self.etag()
        return result

    def admin_dict(self) -> dict[str, Any]:
        return {
            **self.public_dict(),
            "status": self.status,
            "createdAt": self.created_at,
        }

    def record_dict(self) -> dict[str, Any]:
        return {
            "profileId": self.profile_id,
            "version": self.version,
            "name": self.name,
            "instructions": self.instructions,
            "releaseNotes": self.release_notes,
            "minimumClientVersion": self.minimum_client_version,
            "status": self.status,
            "createdAt": self.created_at,
            "publishedAt": self.published_at,
        }

    @classmethod
    def from_record(cls, value: Any) -> "PromptRevision":
        if not isinstance(value, dict):
            raise PromptDomainError("Stored prompt revision must be an object")
        return build_revision(
            profile_id=value.get("profileId"),
            version=value.get("version"),
            name=value.get("name"),
            instructions=value.get("instructions"),
            release_notes=value.get("releaseNotes", ""),
            minimum_client_version=value.get("minimumClientVersion"),
            status=value.get("status"),
            created_at=value.get("createdAt"),
            published_at=value.get("publishedAt"),
        )


def build_revision(
    *,
    profile_id: Any,
    version: Any,
    name: Any,
    instructions: Any,
    release_notes: Any,
    minimum_client_version: Any,
    status: Any = "draft",
    created_at: Any | None = None,
    published_at: Any | None = None,
) -> PromptRevision:
    validated_profile_id = validate_profile_id(profile_id)
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise PromptDomainError("version must be a positive integer")
    validated_name = _clean_single_line(name, "name", MAX_NAME_LENGTH)
    validated_instructions = _clean_optional_text(
        instructions,
        "instructions",
        MAX_INSTRUCTIONS_LENGTH,
    )
    if not validated_instructions:
        raise PromptDomainError("instructions must not be empty")
    validated_release_notes = _clean_optional_text(
        release_notes,
        "releaseNotes",
        MAX_RELEASE_NOTES_LENGTH,
    )
    validated_minimum_version = validate_client_version(minimum_client_version)
    if status not in VALID_STATUSES:
        raise PromptDomainError(f"Unsupported prompt status: {status}")
    if created_at is None:
        created_at = utc_now()
    if not isinstance(created_at, str) or not created_at:
        raise PromptDomainError("createdAt must be a timestamp string")
    if published_at is not None and (not isinstance(published_at, str) or not published_at):
        raise PromptDomainError("publishedAt must be a timestamp string or null")
    if status == "published" and published_at is None:
        raise PromptDomainError("Published revisions require publishedAt")

    return PromptRevision(
        profile_id=validated_profile_id,
        version=version,
        name=validated_name,
        instructions=validated_instructions,
        release_notes=validated_release_notes,
        minimum_client_version=validated_minimum_version,
        status=status,
        created_at=created_at,
        published_at=published_at,
    )

