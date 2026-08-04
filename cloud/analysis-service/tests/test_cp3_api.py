from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import unittest

from fastapi.testclient import TestClient

from analysis_service.app import create_app
from analysis_service.store import InMemoryJobStore
from analysis_service.tasks import InMemoryTaskDispatcher
from analysis_service.uploads import InMemoryProxyUploads
from analysis_service.worker import WorkerError, WorkerResult


NOW = datetime(2026, 8, 4, 12, 0, tzinfo=timezone.utc)
JOB_ID = "40cc540a-fd0e-4fc0-9dd5-71bf29cf983b"
PROXY = b"small deterministic proxy"
REQUEST = {
    "schemaVersion": 1,
    "clientRequestId": JOB_ID,
    "sourceDurationS": 15.0,
    "proxySizeBytes": len(PROXY),
    "proxySha256": hashlib.sha256(PROXY).hexdigest(),
    "proxyContentType": "video/mp4",
}
DETECTION = {
    "car_number": "27",
    "start_s": 1.25,
    "end_s": 5.5,
    "subject": True,
    "confidence": 0.93,
    "notes": "Red race car",
}


class FakeWorker:
    enabled = True

    def __init__(self, failure: WorkerError | None = None) -> None:
        self.failure = failure
        self.calls = 0

    def run(self, job):
        self.calls += 1
        if self.failure is not None:
            raise self.failure
        return WorkerResult(
            detections=(DETECTION,),
            model="gemini-3.6-flash",
            prompt_profile_id="motorsports-default",
            prompt_profile_version=2,
            prompt_etag="b" * 64,
            input_tokens=123,
            output_tokens=45,
        )


class Cp3ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = InMemoryJobStore()
        self.uploads = InMemoryProxyUploads()
        self.tasks = InMemoryTaskDispatcher()
        self.worker = FakeWorker()
        self.client = TestClient(
            create_app(
                store=self.store,
                uploads=self.uploads,
                tasks=self.tasks,
                worker=self.worker,
                clock=lambda: NOW,
            )
        )

    def upload_and_queue(self):
        created = self.client.post("/v1/analysis/jobs", json=REQUEST)
        self.assertEqual(created.status_code, 201)
        job = self.store.get(JOB_ID)
        self.uploads.put(job, data=PROXY, generation=9)
        completed = self.client.post(
            f"/v1/analysis/jobs/{JOB_ID}/upload-complete"
        )
        self.assertEqual(completed.status_code, 200)
        return completed

    def run_task(self, *, retry_count: int = 0):
        return self.client.post(
            f"/v1/internal/analysis/jobs/{JOB_ID}/run",
            json={"schemaVersion": 1},
            headers=self.tasks.headers(retry_count=retry_count),
        )

    def test_upload_confirmation_enqueues_one_idempotent_task(self) -> None:
        completed = self.upload_and_queue()
        self.assertEqual(completed.json()["job"]["state"], "queued")
        self.assertEqual(self.tasks.dispatched, [JOB_ID])

        repeated = self.client.post(
            f"/v1/analysis/jobs/{JOB_ID}/upload-complete"
        )
        self.assertEqual(repeated.status_code, 200)
        self.assertEqual(repeated.json()["job"]["state"], "queued")
        self.assertEqual(self.tasks.dispatched, [JOB_ID])

    def test_worker_completes_and_persists_results_and_provenance(self) -> None:
        self.upload_and_queue()
        response = self.run_task()
        self.assertEqual(response.status_code, 200)
        job = response.json()["job"]
        self.assertEqual(job["state"], "completed")
        self.assertTrue(job["proxy"]["sha256Verified"])
        self.assertEqual(job["results"]["detections"], [DETECTION])
        self.assertEqual(job["analysis"]["model"], "gemini-3.6-flash")
        self.assertEqual(job["analysis"]["prompt"]["version"], 2)
        self.assertEqual(job["analysis"]["inputTokens"], 123)

        persisted = self.client.get(f"/v1/analysis/jobs/{JOB_ID}")
        self.assertEqual(persisted.json()["job"], job)

    def test_internal_worker_requires_cloud_tasks_headers(self) -> None:
        self.upload_and_queue()
        response = self.client.post(
            f"/v1/internal/analysis/jobs/{JOB_ID}/run",
            json={"schemaVersion": 1},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.store.get(JOB_ID).state, "queued")

    def test_retryable_worker_failure_is_bounded_and_becomes_terminal(self) -> None:
        self.worker.failure = WorkerError(
            "prompt",
            "prompt_unavailable",
            "The active prompt service is unavailable.",
            retryable=True,
            proxy_verified=True,
        )
        self.upload_and_queue()

        self.assertEqual(self.run_task().status_code, 503)
        self.assertEqual(self.store.get(JOB_ID).state, "queued")
        self.assertEqual(self.run_task(retry_count=1).status_code, 503)
        terminal = self.run_task(retry_count=2)
        self.assertEqual(terminal.status_code, 200)
        job = terminal.json()["job"]
        self.assertEqual(job["state"], "failed")
        self.assertEqual(job["analysis"]["attempts"], 3)
        self.assertEqual(job["error"]["code"], "prompt_unavailable")
        self.assertTrue(job["proxy"]["sha256Verified"])

    def test_terminal_worker_failure_does_not_retry(self) -> None:
        self.worker.failure = WorkerError(
            "integrity",
            "proxy_hash_mismatch",
            "The uploaded proxy failed SHA-256 verification.",
        )
        self.upload_and_queue()
        response = self.run_task()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["job"]["state"], "failed")
        self.assertEqual(self.worker.calls, 1)

    def test_processing_jobs_reject_delete_and_duplicate_initial_delivery(self) -> None:
        self.upload_and_queue()
        self.store.update(JOB_ID, lambda job: job.with_processing(NOW))

        duplicate = self.run_task()
        self.assertEqual(duplicate.status_code, 409)
        deletion = self.client.delete(f"/v1/analysis/jobs/{JOB_ID}")
        self.assertEqual(deletion.status_code, 409)


if __name__ == "__main__":
    unittest.main()
