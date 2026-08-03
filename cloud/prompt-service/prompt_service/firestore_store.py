"""Firestore-backed prompt profile store for Cloud Run."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from .domain import (
    PromptConflictError,
    PromptNotFoundError,
    PromptRevision,
    build_revision,
    utc_now,
)


class FirestorePromptStore:
    def __init__(self, project: str | None = None) -> None:
        try:
            from google.cloud import firestore
        except ImportError as error:
            raise RuntimeError(
                "google-cloud-firestore is required for the Firestore prompt store"
            ) from error
        self._firestore = firestore
        self._client = firestore.Client(project=project)
        self._profiles = self._client.collection("promptProfiles")
        self._settings = self._client.collection("promptServiceSettings")

    def create_draft(
        self,
        *,
        profile_id: str,
        name: str,
        instructions: str,
        release_notes: str,
        minimum_client_version: str,
    ) -> PromptRevision:
        profile_ref = self._profiles.document(profile_id)
        transaction = self._client.transaction()
        firestore = self._firestore

        @firestore.transactional
        def create(transaction: Any) -> PromptRevision:
            profile_snapshot = profile_ref.get(transaction=transaction)
            latest_version = (
                int(profile_snapshot.get("latestVersion"))
                if profile_snapshot.exists
                else 0
            )
            revision = build_revision(
                profile_id=profile_id,
                version=latest_version + 1,
                name=name,
                instructions=instructions,
                release_notes=release_notes,
                minimum_client_version=minimum_client_version,
            )
            revision_ref = profile_ref.collection("revisions").document(
                str(revision.version)
            )
            transaction.set(
                profile_ref,
                {
                    "profileId": profile_id,
                    "latestVersion": revision.version,
                    "updatedAt": revision.created_at,
                },
                merge=True,
            )
            transaction.set(revision_ref, revision.record_dict())
            return revision

        return create(transaction)

    def publish(self, profile_id: str, version: int) -> PromptRevision:
        profile_ref = self._profiles.document(profile_id)
        revision_ref = profile_ref.collection("revisions").document(str(version))
        active_ref = self._settings.document("activePrompt")
        transaction = self._client.transaction()
        firestore = self._firestore

        @firestore.transactional
        def publish(transaction: Any) -> PromptRevision:
            target_snapshot = revision_ref.get(transaction=transaction)
            active_snapshot = active_ref.get(transaction=transaction)
            if not target_snapshot.exists:
                raise PromptNotFoundError(
                    f"Prompt revision {profile_id} v{version} was not found"
                )
            target = PromptRevision.from_record(target_snapshot.to_dict())
            active_value = active_snapshot.to_dict() if active_snapshot.exists else None
            active_key = (
                (active_value["profileId"], int(active_value["version"]))
                if active_value
                else None
            )
            target_key = (profile_id, version)
            if active_key == target_key and target.status == "published":
                return target
            if target.status != "draft":
                raise PromptConflictError("Only a draft prompt revision can be published")

            previous_ref = None
            previous = None
            if active_key is not None:
                previous_ref = (
                    self._profiles.document(active_key[0])
                    .collection("revisions")
                    .document(str(active_key[1]))
                )
                previous_snapshot = previous_ref.get(transaction=transaction)
                if previous_snapshot.exists:
                    previous = PromptRevision.from_record(previous_snapshot.to_dict())

            published_at = utc_now()
            published = replace(
                target,
                status="published",
                published_at=published_at,
            )
            if previous_ref is not None and previous is not None:
                transaction.set(
                    previous_ref,
                    replace(previous, status="archived").record_dict(),
                )
            transaction.set(revision_ref, published.record_dict())
            transaction.set(
                active_ref,
                {
                    "profileId": profile_id,
                    "version": version,
                    "publishedAt": published_at,
                },
            )
            return published

        return publish(transaction)

    def get_active(self) -> PromptRevision | None:
        active_snapshot = self._settings.document("activePrompt").get()
        if not active_snapshot.exists:
            return None
        active = active_snapshot.to_dict()
        revision_snapshot = (
            self._profiles.document(active["profileId"])
            .collection("revisions")
            .document(str(active["version"]))
            .get()
        )
        if not revision_snapshot.exists:
            raise RuntimeError("The active Firestore prompt revision does not exist")
        revision = PromptRevision.from_record(revision_snapshot.to_dict())
        if revision.status != "published":
            raise RuntimeError("The active Firestore prompt revision is not published")
        return revision

    def list_revisions(self, profile_id: str | None = None) -> list[PromptRevision]:
        revisions: list[PromptRevision] = []
        profiles = (
            [self._profiles.document(profile_id).get()]
            if profile_id is not None
            else list(self._profiles.stream())
        )
        for profile in profiles:
            if not profile.exists:
                continue
            revision_documents = profile.reference.collection("revisions").stream()
            revisions.extend(
                PromptRevision.from_record(document.to_dict())
                for document in revision_documents
            )
        return sorted(
            revisions,
            key=lambda revision: (
                revision.created_at,
                revision.profile_id,
                revision.version,
            ),
            reverse=True,
        )

