from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from prompt_service.app import create_app
from prompt_service.store import InMemoryPromptStore


ADMIN_TOKEN = "test-admin-token-with-at-least-32-characters"
AUTHORIZATION = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
VALID_REQUEST = {
    "profileId": "motorsports-default",
    "name": "Motorsports default",
    "instructions": "Report participating race vehicles.",
    "releaseNotes": "Initial validated profile.",
    "minimumClientVersion": "0.1.0",
}


class PromptApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(
            create_app(
                store=InMemoryPromptStore(),
                admin_token=ADMIN_TOKEN,
            )
        )

    def test_health_and_empty_active_profile(self) -> None:
        health = self.client.get("/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["status"], "ok")
        self.assertEqual(
            self.client.get("/v1/prompt-profiles/active").status_code,
            404,
        )

    def test_admin_routes_require_the_bearer_token(self) -> None:
        response = self.client.post(
            "/v1/admin/prompt-profiles/drafts",
            json=VALID_REQUEST,
        )
        self.assertEqual(response.status_code, 401)

    def test_draft_publish_history_and_etag_flow(self) -> None:
        draft_response = self.client.post(
            "/v1/admin/prompt-profiles/drafts",
            json=VALID_REQUEST,
            headers=AUTHORIZATION,
        )
        self.assertEqual(draft_response.status_code, 201)
        revision = draft_response.json()["revision"]
        self.assertEqual(revision["version"], 1)
        self.assertEqual(revision["status"], "draft")

        publish_response = self.client.post(
            "/v1/admin/prompt-profiles/motorsports-default/revisions/1/publish",
            headers=AUTHORIZATION,
        )
        self.assertEqual(publish_response.status_code, 200)
        profile = publish_response.json()["profile"]
        self.assertEqual(profile["version"], 1)

        active_response = self.client.get("/v1/prompt-profiles/active")
        self.assertEqual(active_response.status_code, 200)
        self.assertEqual(active_response.json()["profile"], profile)
        self.assertEqual(
            active_response.headers["etag"],
            f'"{profile["etag"]}"',
        )

        cached_response = self.client.get(
            "/v1/prompt-profiles/active",
            headers={"If-None-Match": active_response.headers["etag"]},
        )
        self.assertEqual(cached_response.status_code, 304)

        history_response = self.client.get(
            "/v1/admin/prompt-profiles",
            headers=AUTHORIZATION,
        )
        self.assertEqual(history_response.status_code, 200)
        self.assertEqual(len(history_response.json()["revisions"]), 1)

    def test_unknown_fields_and_bad_domain_values_are_rejected(self) -> None:
        response = self.client.post(
            "/v1/admin/prompt-profiles/drafts",
            json={**VALID_REQUEST, "model": "gemini-change-not-allowed"},
            headers=AUTHORIZATION,
        )
        self.assertEqual(response.status_code, 422)

        response = self.client.post(
            "/v1/admin/prompt-profiles/drafts",
            json={**VALID_REQUEST, "profileId": "Invalid ID"},
            headers=AUTHORIZATION,
        )
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()

