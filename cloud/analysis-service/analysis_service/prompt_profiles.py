"""Strict client for the published remote prompt profile."""

from __future__ import annotations

from dataclasses import dataclass
import re
from urllib.parse import urlparse

import httpx


PROFILE_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{2,63}$")
ETAG_PATTERN = re.compile(r"^[0-9a-f]{64}$")
MAX_RESPONSE_BYTES = 20_000
MAX_INSTRUCTIONS_LENGTH = 12_000


class PromptProfileError(RuntimeError):
    """The active prompt could not be fetched or validated."""


@dataclass(frozen=True)
class PromptProfile:
    profile_id: str
    version: int
    instructions: str
    etag: str


class HttpPromptProfileProvider:
    def __init__(
        self,
        service_url: str,
        *,
        client: httpx.Client | None = None,
        timeout_seconds: float = 10.0,
    ) -> None:
        parsed = urlparse(service_url)
        local = parsed.hostname in {"127.0.0.1", "localhost"}
        if parsed.scheme != "https" and not (local and parsed.scheme == "http"):
            raise ValueError("PROMPT_SERVICE_URL must use HTTPS")
        if parsed.query or parsed.fragment or not parsed.netloc:
            raise ValueError("PROMPT_SERVICE_URL must be an origin URL")
        self._url = (
            f"{service_url.rstrip('/')}/v1/prompt-profiles/active"
        )
        self._client = client or httpx.Client(
            timeout=timeout_seconds,
            follow_redirects=False,
        )

    def load(self) -> PromptProfile:
        try:
            response = self._client.get(
                self._url,
                headers={"Accept": "application/json"},
            )
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise PromptProfileError("The active prompt service is unavailable.") from error

        if len(response.content) > MAX_RESPONSE_BYTES:
            raise PromptProfileError("The active prompt response is too large.")
        try:
            body = response.json()
            if body.get("schemaVersion") != 1:
                raise ValueError("schema version")
            profile = body["profile"]
            profile_id = profile["profileId"]
            version = profile["version"]
            instructions = profile["instructions"]
            etag = profile["etag"]
        except (KeyError, TypeError, ValueError) as error:
            raise PromptProfileError("The active prompt response is invalid.") from error

        if not isinstance(profile_id, str) or not PROFILE_ID_PATTERN.fullmatch(
            profile_id
        ):
            raise PromptProfileError("The active prompt profile ID is invalid.")
        if not isinstance(version, int) or isinstance(version, bool) or version < 1:
            raise PromptProfileError("The active prompt version is invalid.")
        if not isinstance(instructions, str):
            raise PromptProfileError("The active prompt instructions are invalid.")
        instructions = instructions.replace("\r\n", "\n").replace("\r", "\n").strip()
        if (
            not instructions
            or len(instructions) > MAX_INSTRUCTIONS_LENGTH
            or "\x00" in instructions
        ):
            raise PromptProfileError("The active prompt instructions are invalid.")
        if not isinstance(etag, str) or not ETAG_PATTERN.fullmatch(etag):
            raise PromptProfileError("The active prompt ETag is invalid.")
        response_etag = response.headers.get("etag", "").strip('"')
        if response_etag != etag:
            raise PromptProfileError("The active prompt ETag did not match its payload.")
        return PromptProfile(profile_id, version, instructions, etag)
