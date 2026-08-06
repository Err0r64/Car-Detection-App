from __future__ import annotations

from datetime import datetime, timedelta, timezone
import unittest
from uuid import UUID

from analysis_service.domain import AnalysisJob, JobDomainError, new_job
from analysis_service.tasks import GoogleCloudTaskDispatcher


NOW = datetime(2026, 8, 4, 12, 0, tzinfo=timezone.utc)
JOB_ID = UUID("0b252937-8399-4615-89e2-ea3e7549c6b2")
DETECTION = {
    "car_number": "88",
    "start_s": 2.0,
    "end_s": 4.5,
    "subject": True,
    "confidence": 0.8,
    "notes": "Black coupe",
}


def processing_job():
    job = new_job(
        client_request_id=JOB_ID,
        source_duration_s=15.0,
        proxy_size_bytes=10,
        proxy_sha256="a" * 64,
        proxy_content_type="video/mp4",
        now=NOW,
        upload_ttl=timedelta(minutes=15),
        job_ttl=timedelta(days=7),
    )
    return job.with_uploaded(5, NOW).with_queued(NOW).with_processing(NOW)


class Cp3DomainTests(unittest.TestCase):
    def test_completed_job_round_trips_with_results(self) -> None:
        completed = processing_job().with_completed(
            detections=[DETECTION],
            model="gemini-3.6-flash",
            prompt_profile_id="motorsports-default",
            prompt_profile_version=2,
            prompt_etag="b" * 64,
            input_tokens=100,
            output_tokens=20,
            updated_at=NOW,
        )
        restored = AnalysisJob.from_record(completed.record_dict())
        self.assertEqual(restored, completed)
        self.assertEqual(restored.public_dict()["results"]["detections"], [DETECTION])

    def test_failed_job_round_trips_without_results(self) -> None:
        failed = processing_job().with_failed(
            stage="integrity",
            code="proxy_hash_mismatch",
            message="Proxy hash mismatch.",
            proxy_verified=False,
            updated_at=NOW,
        )
        restored = AnalysisJob.from_record(failed.record_dict())
        self.assertEqual(restored, failed)
        self.assertNotIn("results", restored.public_dict())

    def test_retry_details_round_trip_and_clear_on_next_attempt(self) -> None:
        retrying = processing_job().with_retry_queued(
            NOW,
            stage="analyzing",
            code="provider_unavailable",
            message="Gemini is temporarily unavailable.",
        )
        restored = AnalysisJob.from_record(retrying.record_dict())
        self.assertEqual(restored, retrying)
        self.assertEqual(
            restored.public_dict()["analysis"]["retry"]["code"],
            "provider_unavailable",
        )

        processing = restored.with_processing(NOW)
        self.assertIsNone(processing.public_dict()["analysis"]["retry"])

    def test_canceled_job_is_terminal_and_round_trips(self) -> None:
        canceled = processing_job().with_canceled(NOW)
        restored = AnalysisJob.from_record(canceled.record_dict())
        self.assertEqual(restored, canceled)
        self.assertEqual(restored.public_dict()["state"], "canceled")
        self.assertEqual(
            restored.public_dict()["analysis"]["completedAt"],
            NOW.isoformat().replace("+00:00", "Z"),
        )

    def test_invalid_detection_cannot_be_persisted(self) -> None:
        with self.assertRaises(JobDomainError):
            processing_job().with_completed(
                detections=[{**DETECTION, "end_s": 20.0}],
                model="gemini-3.6-flash",
                prompt_profile_id="motorsports-default",
                prompt_profile_version=2,
                prompt_etag="b" * 64,
                input_tokens=100,
                output_tokens=20,
                updated_at=NOW,
            )

    def test_cloud_task_headers_are_bound_to_configured_queue_and_task_id(self) -> None:
        dispatcher = GoogleCloudTaskDispatcher(
            queue_path=(
                "projects/example/locations/us-west1/queues/apexiel-analysis"
            ),
            service_url="https://analysis.example.test",
            invoker_service_account="worker@example.iam.gserviceaccount.com",
            client=object(),
        )
        valid = {
            "x-cloudtasks-queuename": "apexiel-analysis",
            "x-cloudtasks-taskname": (
                "projects/example/locations/us-west1/queues/apexiel-analysis/tasks/"
                "analysis-0b2529378399461589e2ea3e7549c6b2"
            ),
        }
        self.assertTrue(dispatcher.accepts(valid))
        self.assertFalse(
            dispatcher.accepts({**valid, "x-cloudtasks-queuename": "other"})
        )
        self.assertFalse(
            dispatcher.accepts({**valid, "x-cloudtasks-taskname": "analysis-manual"})
        )


if __name__ == "__main__":
    unittest.main()
