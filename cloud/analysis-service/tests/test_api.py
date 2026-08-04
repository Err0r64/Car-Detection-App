from __future__ import annotations

from datetime import datetime, timedelta, timezone
import unittest

from fastapi.testclient import TestClient

from analysis_service.app import MAX_REQUEST_BYTES, create_app
from analysis_service.store import InMemoryJobStore
from analysis_service.uploads import DisabledProxyUploads, InMemoryProxyUploads


NOW = datetime(2026, 8, 3, 20, 0, tzinfo=timezone.utc)
JOB_ID = "d4aec38e-c840-4b6f-9754-47e7e118e730"
VALID_JOB_REQUEST = {
    "schemaVersion": 1,
    "clientRequestId": JOB_ID,
    "sourceDurationS": 364.25,
    "proxySizeBytes": 12_345_678,
    "proxySha256": "a" * 64,
    "proxyContentType": "video/mp4",
}


class AnalysisApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.now = NOW
        self.store = InMemoryJobStore()
        self.uploads = InMemoryProxyUploads()
        self.client = TestClient(
            create_app(
                store=self.store,
                uploads=self.uploads,
                clock=lambda: self.now,
                upload_ttl_seconds=900,
                job_ttl_hours=168,
            )
        )

    def create_job(self):
        return self.client.post("/v1/analysis/jobs", json=VALID_JOB_REQUEST)

    def test_health_and_capabilities_report_upload_support(self) -> None:
        health = self.client.get("/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["service"], "apexiel-analysis-service")
        self.assertEqual(health.headers["cache-control"], "no-store")
        self.assertEqual(health.headers["x-content-type-options"], "nosniff")

        capabilities = self.client.get("/v1/capabilities")
        self.assertEqual(capabilities.status_code, 200)
        self.assertTrue(capabilities.json()["analysisJobs"])
        self.assertTrue(capabilities.json()["proxyUploads"])
        self.assertFalse(capabilities.json()["geminiAnalysis"])

    def test_create_returns_a_bound_short_lived_upload_grant(self) -> None:
        response = self.create_job()
        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertEqual(body["job"]["jobId"], JOB_ID)
        self.assertEqual(body["job"]["state"], "awaiting_upload")
        self.assertNotIn("proxyObject", body["job"])
        self.assertEqual(body["upload"]["method"], "PUT")
        self.assertEqual(
            body["upload"]["requiredHeaders"]["x-goog-if-generation-match"],
            "0",
        )
        self.assertEqual(
            body["upload"]["requiredHeaders"]["x-goog-meta-apexiel-job-id"],
            JOB_ID,
        )
        self.assertEqual(body["upload"]["expiresAt"], "2026-08-03T20:15:00Z")

        get_response = self.client.get(f"/v1/analysis/jobs/{JOB_ID}")
        self.assertEqual(get_response.status_code, 200)
        self.assertNotIn("upload", get_response.json())

    def test_create_is_idempotent_but_rejects_metadata_collisions(self) -> None:
        self.assertEqual(self.create_job().status_code, 201)
        self.assertEqual(self.create_job().status_code, 200)

        collision = self.client.post(
            "/v1/analysis/jobs",
            json={**VALID_JOB_REQUEST, "proxySizeBytes": 99},
        )
        self.assertEqual(collision.status_code, 409)

    def test_missing_upload_cannot_advance_the_job(self) -> None:
        self.create_job()
        response = self.client.post(
            f"/v1/analysis/jobs/{JOB_ID}/upload-complete"
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.store.get(JOB_ID).state, "awaiting_upload")

    def test_matching_upload_advances_the_job_idempotently(self) -> None:
        self.create_job()
        job = self.store.get(JOB_ID)
        self.uploads.put(job, generation=42)

        response = self.client.post(
            f"/v1/analysis/jobs/{JOB_ID}/upload-complete"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["job"]["state"], "uploaded")
        self.assertFalse(response.json()["job"]["proxy"]["sha256Verified"])
        self.assertEqual(self.store.get(JOB_ID).object_generation, 42)

        repeat = self.client.post(
            f"/v1/analysis/jobs/{JOB_ID}/upload-complete"
        )
        self.assertEqual(repeat.status_code, 200)
        self.assertEqual(repeat.json()["job"]["state"], "uploaded")

    def test_mismatched_upload_is_deleted_and_job_remains_pending(self) -> None:
        self.create_job()
        job = self.store.get(JOB_ID)
        self.uploads.put(job, size_bytes=job.proxy_size_bytes + 1, generation=7)

        response = self.client.post(
            f"/v1/analysis/jobs/{JOB_ID}/upload-complete"
        )
        self.assertEqual(response.status_code, 400)
        self.assertIsNone(self.uploads.inspect(job.proxy_object))
        self.assertIn(job.proxy_object, self.uploads.deleted)
        self.assertEqual(self.store.get(JOB_ID).state, "awaiting_upload")

    def test_delete_cleans_up_proxy_and_job_record(self) -> None:
        self.create_job()
        job = self.store.get(JOB_ID)
        self.uploads.put(job)

        response = self.client.delete(f"/v1/analysis/jobs/{JOB_ID}")
        self.assertEqual(response.status_code, 204)
        self.assertEqual(
            self.client.get(f"/v1/analysis/jobs/{JOB_ID}").status_code,
            404,
        )
        self.assertIsNone(self.uploads.inspect(job.proxy_object))

    def test_expired_jobs_return_gone_until_lifecycle_cleanup(self) -> None:
        self.create_job()
        self.now = NOW + timedelta(days=8)
        response = self.client.get(f"/v1/analysis/jobs/{JOB_ID}")
        self.assertEqual(response.status_code, 410)

    def test_job_contract_rejects_credentials_and_invalid_fields(self) -> None:
        response = self.client.post(
            "/v1/analysis/jobs",
            json={**VALID_JOB_REQUEST, "geminiApiKey": "must-not-be-accepted"},
        )
        self.assertEqual(response.status_code, 422)

        response = self.client.post(
            "/v1/analysis/jobs",
            json={**VALID_JOB_REQUEST, "proxySha256": "not-a-sha256"},
        )
        self.assertEqual(response.status_code, 422)

    def test_disabled_local_service_retains_checkpoint_boundary(self) -> None:
        client = TestClient(
            create_app(
                store=InMemoryJobStore(),
                uploads=DisabledProxyUploads(),
            )
        )
        response = client.post("/v1/analysis/jobs", json=VALID_JOB_REQUEST)
        self.assertEqual(response.status_code, 503)

    def test_oversized_requests_are_rejected_before_routing(self) -> None:
        response = self.client.post(
            "/v1/analysis/jobs",
            content=b"{}",
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(MAX_REQUEST_BYTES + 1),
            },
        )
        self.assertEqual(response.status_code, 413)


if __name__ == "__main__":
    unittest.main()
