"""Local and in-memory prompt profile stores."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import threading
from typing import Protocol

from .domain import (
    PromptConflictError,
    PromptDomainError,
    PromptNotFoundError,
    PromptRevision,
    build_revision,
    utc_now,
)


STORE_SCHEMA_VERSION = 1


class PromptStore(Protocol):
    def create_draft(
        self,
        *,
        profile_id: str,
        name: str,
        instructions: str,
        release_notes: str,
        minimum_client_version: str,
    ) -> PromptRevision: ...

    def publish(self, profile_id: str, version: int) -> PromptRevision: ...

    def get_active(self) -> PromptRevision | None: ...

    def list_revisions(self, profile_id: str | None = None) -> list[PromptRevision]: ...


@dataclass
class _StoreState:
    revisions: list[PromptRevision]
    active: tuple[str, int] | None


def _create_draft(
    state: _StoreState,
    *,
    profile_id: str,
    name: str,
    instructions: str,
    release_notes: str,
    minimum_client_version: str,
) -> PromptRevision:
    latest_version = max(
        (
            revision.version
            for revision in state.revisions
            if revision.profile_id == profile_id
        ),
        default=0,
    )
    revision = build_revision(
        profile_id=profile_id,
        version=latest_version + 1,
        name=name,
        instructions=instructions,
        release_notes=release_notes,
        minimum_client_version=minimum_client_version,
    )
    state.revisions.append(revision)
    return revision


def _find_revision(
    state: _StoreState,
    profile_id: str,
    version: int,
) -> tuple[int, PromptRevision]:
    for index, revision in enumerate(state.revisions):
        if revision.profile_id == profile_id and revision.version == version:
            return index, revision
    raise PromptNotFoundError(f"Prompt revision {profile_id} v{version} was not found")


def _publish(
    state: _StoreState,
    profile_id: str,
    version: int,
) -> PromptRevision:
    target_index, target = _find_revision(state, profile_id, version)
    target_key = (profile_id, version)
    if state.active == target_key and target.status == "published":
        return target
    if target.status != "draft":
        raise PromptConflictError("Only a draft prompt revision can be published")

    if state.active is not None:
        active_index, active = _find_revision(state, *state.active)
        state.revisions[active_index] = active.with_status("archived")

    published = target.with_status("published", utc_now())
    state.revisions[target_index] = published
    state.active = target_key
    return published


def _get_active(state: _StoreState) -> PromptRevision | None:
    if state.active is None:
        return None
    _, revision = _find_revision(state, *state.active)
    if revision.status != "published":
        raise RuntimeError("The active prompt revision is not published")
    return revision


def _list_revisions(
    state: _StoreState,
    profile_id: str | None,
) -> list[PromptRevision]:
    revisions = [
        revision
        for revision in state.revisions
        if profile_id is None or revision.profile_id == profile_id
    ]
    return sorted(
        revisions,
        key=lambda revision: (revision.created_at, revision.profile_id, revision.version),
        reverse=True,
    )


class InMemoryPromptStore:
    def __init__(self) -> None:
        self._state = _StoreState([], None)
        self._lock = threading.RLock()

    def create_draft(self, **values: str) -> PromptRevision:
        with self._lock:
            return _create_draft(self._state, **values)

    def publish(self, profile_id: str, version: int) -> PromptRevision:
        with self._lock:
            return _publish(self._state, profile_id, version)

    def get_active(self) -> PromptRevision | None:
        with self._lock:
            return _get_active(self._state)

    def list_revisions(self, profile_id: str | None = None) -> list[PromptRevision]:
        with self._lock:
            return _list_revisions(self._state, profile_id)


class JsonPromptStore:
    """Atomic local store used for development, demos, and API tests."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = threading.RLock()

    def _load(self) -> _StoreState:
        if not self.path.exists():
            return _StoreState([], None)
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Could not read prompt store {self.path}: {error}") from error
        if not isinstance(payload, dict) or payload.get("schemaVersion") != STORE_SCHEMA_VERSION:
            raise RuntimeError("The local prompt store has an unsupported schema")
        try:
            revisions = [
                PromptRevision.from_record(value)
                for value in payload.get("revisions", [])
            ]
            active_value = payload.get("active")
            active = None
            if active_value is not None:
                active = (
                    active_value["profileId"],
                    int(active_value["version"]),
                )
            state = _StoreState(revisions, active)
            _get_active(state)
            return state
        except (KeyError, TypeError, ValueError, PromptDomainError) as error:
            raise RuntimeError(f"The local prompt store is invalid: {error}") from error

    def _save(self, state: _StoreState) -> None:
        payload = {
            "schemaVersion": STORE_SCHEMA_VERSION,
            "active": (
                {
                    "profileId": state.active[0],
                    "version": state.active[1],
                }
                if state.active is not None
                else None
            ),
            "revisions": [revision.record_dict() for revision in state.revisions],
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = self.path.with_name(f".{self.path.name}.tmp")
        try:
            temporary_path.write_text(
                json.dumps(payload, indent=2, ensure_ascii=True) + "\n",
                encoding="utf-8",
            )
            os.replace(temporary_path, self.path)
        except OSError:
            temporary_path.unlink(missing_ok=True)
            raise

    def create_draft(self, **values: str) -> PromptRevision:
        with self._lock:
            state = self._load()
            revision = _create_draft(state, **values)
            self._save(state)
            return revision

    def publish(self, profile_id: str, version: int) -> PromptRevision:
        with self._lock:
            state = self._load()
            revision = _publish(state, profile_id, version)
            self._save(state)
            return revision

    def get_active(self) -> PromptRevision | None:
        with self._lock:
            return _get_active(self._load())

    def list_revisions(self, profile_id: str | None = None) -> list[PromptRevision]:
        with self._lock:
            return _list_revisions(self._load(), profile_id)

