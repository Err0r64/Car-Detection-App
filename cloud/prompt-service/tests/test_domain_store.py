from __future__ import annotations

import json
from pathlib import Path
import uuid
import unittest

from prompt_service.domain import PromptConflictError, PromptDomainError, build_revision
from prompt_service.store import InMemoryPromptStore, JsonPromptStore


VALID_DRAFT = {
    "profile_id": "motorsports-default",
    "name": "Motorsports default",
    "instructions": "Report participating race vehicles.",
    "release_notes": "Initial validated profile.",
    "minimum_client_version": "0.1.0",
}


class PromptDomainTests(unittest.TestCase):
    def test_rejects_invalid_profile_fields(self) -> None:
        with self.assertRaisesRegex(PromptDomainError, "profileId"):
            build_revision(version=1, status="draft", **{**VALID_DRAFT, "profile_id": "NO"})
        with self.assertRaisesRegex(PromptDomainError, "instructions"):
            build_revision(version=1, status="draft", **{**VALID_DRAFT, "instructions": ""})
        with self.assertRaisesRegex(PromptDomainError, "semantic version"):
            build_revision(
                version=1,
                status="draft",
                **{**VALID_DRAFT, "minimum_client_version": "version one"},
            )

    def test_packaged_seed_is_valid_and_keeps_identity_guards(self) -> None:
        seed_path = Path(__file__).resolve().parents[1] / "seed" / "motorsports-default.json"
        payload = json.loads(seed_path.read_text(encoding="utf-8"))
        revision = build_revision(
            profile_id=payload.get("profileId"),
            version=1,
            name=payload.get("name"),
            instructions=payload.get("instructions"),
            release_notes=payload.get("releaseNotes", ""),
            minimum_client_version=payload.get("minimumClientVersion"),
            status="draft",
        )

        self.assertEqual(revision.profile_id, "motorsports-default")
        self.assertIn(
            "APPEARANCES AND VEHICLE IDENTITY -- HIGHEST PRIORITY",
            revision.instructions,
        )
        self.assertIn("Never return one appearance from 12 to 52", revision.instructions)
    def test_etag_changes_when_prompt_content_changes(self) -> None:
        first = build_revision(version=1, status="draft", **VALID_DRAFT)
        second = build_revision(
            version=2,
            status="draft",
            **{**VALID_DRAFT, "instructions": "Different instructions."},
        )
        self.assertNotEqual(first.etag(), second.etag())


class PromptStoreTests(unittest.TestCase):
    def test_creates_versions_and_archives_the_previous_publication(self) -> None:
        store = InMemoryPromptStore()
        first = store.create_draft(**VALID_DRAFT)
        first_published = store.publish(first.profile_id, first.version)
        second = store.create_draft(
            **{**VALID_DRAFT, "instructions": "Second revision."}
        )
        second_published = store.publish(second.profile_id, second.version)

        self.assertEqual(first.version, 1)
        self.assertEqual(second.version, 2)
        self.assertEqual(second_published.status, "published")
        self.assertEqual(store.get_active(), second_published)
        history = store.list_revisions("motorsports-default")
        self.assertEqual(
            {revision.version: revision.status for revision in history},
            {1: "archived", 2: "published"},
        )
        self.assertEqual(
            store.publish(second.profile_id, second.version),
            second_published,
        )
        with self.assertRaises(PromptConflictError):
            store.publish(first.profile_id, first.version)

    def test_json_store_persists_an_active_revision_atomically(self) -> None:
        temporary_root = Path(__file__).resolve().parents[3] / ".tmp"
        temporary_root.mkdir(exist_ok=True)
        path = temporary_root / f"prompt-store-{uuid.uuid4().hex}.json"
        try:
            store = JsonPromptStore(path)
            draft = store.create_draft(**VALID_DRAFT)
            published = store.publish(draft.profile_id, draft.version)

            reopened = JsonPromptStore(path)
            self.assertEqual(reopened.get_active(), published)
            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(payload["schemaVersion"], 1)
            self.assertFalse(path.with_name(f".{path.name}.tmp").exists())
        finally:
            path.unlink(missing_ok=True)
            path.with_name(f".{path.name}.tmp").unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()

