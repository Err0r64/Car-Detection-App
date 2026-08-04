from __future__ import annotations

from datetime import datetime, timedelta, timezone
import unittest
from uuid import UUID

from analysis_service.domain import AnalysisJob, JobDomainError, new_job
from analysis_service.store import InMemoryJobStore


NOW = datetime(2026, 8, 3, 20, 0, tzinfo=timezone.utc)
JOB_ID = UUID("d4aec38e-c840-4b6f-9754-47e7e118e730")


def make_job():
    return new_job(
        client_request_id=JOB_ID,
        source_duration_s=364.25,
        proxy_size_bytes=12345,
        proxy_sha256="a" * 64,
        proxy_content_type="video/mp4",
        now=NOW,
        upload_ttl=timedelta(minutes=15),
        job_ttl=timedelta(days=7),
    )


class AnalysisDomainStoreTests(unittest.TestCase):
    def test_job_record_round_trips_without_exposing_storage_names(self) -> None:
        job = make_job()
        restored = AnalysisJob.from_record(job.record_dict())
        self.assertEqual(restored, job)
        self.assertNotIn("proxyObject", restored.public_dict())

    def test_record_rejects_an_object_outside_the_job_prefix(self) -> None:
        record = make_job().record_dict()
        record["proxyObject"] = "uploads/another-job/proxy.mp4"
        with self.assertRaises(JobDomainError):
            AnalysisJob.from_record(record)

    def test_in_memory_store_create_and_update_are_atomic(self) -> None:
        store = InMemoryJobStore()
        job = make_job()
        self.assertEqual(store.create(job), (job, True))
        self.assertEqual(store.create(job), (job, False))

        updated = store.update(
            job.job_id,
            lambda current: current.with_uploaded(9, NOW + timedelta(minutes=1)),
        )
        self.assertEqual(updated.state, "uploaded")
        self.assertEqual(store.get(job.job_id).object_generation, 9)


if __name__ == "__main__":
    unittest.main()
