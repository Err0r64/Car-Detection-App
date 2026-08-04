from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from analysis_service.app import MAX_REQUEST_BYTES, create_app


VALID_JOB_REQUEST = {
    "schemaVersion": 1,
    "clientRequestId": "d4aec38e-c840-4b6f-9754-47e7e118e730",
    "sourceDurationS": 364.25,
    "proxySizeBytes": 12_345_678,
    "proxySha256": "a" * 64,
    "proxyContentType": "video/mp4",
}


class AnalysisApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(create_app())

    def test_health_and_capabilities_report_scaffold_state(self) -> None:
        health = self.client.get("/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(
            health.json(),
            {
                "status": "ok",
                "schemaVersion": 1,
                "service": "apexiel-analysis-service",
            },
        )
        self.assertEqual(health.headers["cache-control"], "no-store")
        self.assertEqual(health.headers["x-content-type-options"], "nosniff")

        capabilities = self.client.get("/v1/capabilities")
        self.assertEqual(capabilities.status_code, 200)
        self.assertFalse(capabilities.json()["analysisJobs"])
        self.assertFalse(capabilities.json()["proxyUploads"])
        self.assertFalse(capabilities.json()["geminiAnalysis"])

    def test_valid_job_metadata_is_rejected_until_checkpoint_two(self) -> None:
        response = self.client.post("/v1/analysis/jobs", json=VALID_JOB_REQUEST)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json()["detail"],
            "Analysis job creation is not configured.",
        )

    def test_job_contract_rejects_unknown_and_invalid_fields(self) -> None:
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

        response = self.client.post(
            "/v1/analysis/jobs",
            json={**VALID_JOB_REQUEST, "sourceDurationS": 0},
        )
        self.assertEqual(response.status_code, 422)

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
