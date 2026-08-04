from __future__ import annotations

from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
import hashlib
from pathlib import Path
import unittest
from uuid import UUID

from analysis_service.analyzer import AnalyzerError, AnalyzerResult
from analysis_service.domain import new_job
from analysis_service.prompt_profiles import PromptProfile, PromptProfileError
from analysis_service.uploads import ProxyDownload
from analysis_service.worker import ServerAnalysisWorker, WorkerError


NOW = datetime(2026, 8, 4, 12, 0, tzinfo=timezone.utc)
PROXY = b"verified proxy bytes"


class FakeProxyUploads:
    enabled = True

    def __init__(self) -> None:
        self.data = PROXY

    def download_to(self, object_name, generation, destination):
        return ProxyDownload(
            size_bytes=len(self.data),
            sha256=hashlib.sha256(self.data).hexdigest(),
        )


class FakePromptProvider:
    def __init__(self) -> None:
        self.error: Exception | None = None
        self.profile = PromptProfile(
            "motorsports-default",
            2,
            "Report each physical race vehicle separately.",
            "c" * 64,
        )

    def load(self):
        if self.error is not None:
            raise self.error
        return self.profile


class FakeAnalyzer:
    enabled = True

    def __init__(self) -> None:
        self.error: Exception | None = None
        self.received_path: Path | None = None

    def analyze(self, proxy_path: Path, *, duration_s: float, prompt_instructions: str):
        if self.error is not None:
            raise self.error
        self.received_path = proxy_path
        return AnalyzerResult(
            detections=(
                {
                    "car_number": "",
                    "start_s": 1.0,
                    "end_s": 2.0,
                    "subject": False,
                    "confidence": None,
                    "notes": "Blue car",
                },
            ),
            model="gemini-3.6-flash",
            input_tokens=50,
            output_tokens=20,
        )


def make_job():
    job = new_job(
        client_request_id=UUID("da87398d-cdd3-413c-84de-3a83abbb3d45"),
        source_duration_s=15.0,
        proxy_size_bytes=len(PROXY),
        proxy_sha256=hashlib.sha256(PROXY).hexdigest(),
        proxy_content_type="video/mp4",
        now=NOW,
        upload_ttl=timedelta(minutes=15),
        job_ttl=timedelta(days=7),
    )
    return job.with_uploaded(7, NOW)


class WorkerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.job = make_job()
        self.uploads = FakeProxyUploads()
        self.prompts = FakePromptProvider()
        self.analyzer = FakeAnalyzer()
        self.worker = ServerAnalysisWorker(
            uploads=self.uploads,
            prompt_provider=self.prompts,
            analyzer=self.analyzer,
            scratch_factory=lambda: nullcontext(str(Path(__file__).resolve().parent)),
        )

    def test_hashes_exact_generation_before_analysis(self) -> None:
        result = self.worker.run(self.job)
        self.assertEqual(self.analyzer.received_path.name, "proxy.mp4")
        self.assertEqual(result.prompt_profile_version, 2)
        self.assertEqual(result.model, "gemini-3.6-flash")

    def test_hash_mismatch_is_terminal_before_prompt_or_gemini(self) -> None:
        self.uploads.data = b"tampered"
        with self.assertRaises(WorkerError) as raised:
            self.worker.run(self.job)
        self.assertEqual(raised.exception.code, "proxy_hash_mismatch")
        self.assertFalse(raised.exception.retryable)
        self.assertIsNone(self.analyzer.received_path)

    def test_prompt_outage_is_retryable_after_integrity_check(self) -> None:
        self.prompts.error = PromptProfileError("Prompt service unavailable.")
        with self.assertRaises(WorkerError) as raised:
            self.worker.run(self.job)
        self.assertEqual(raised.exception.stage, "prompt")
        self.assertTrue(raised.exception.retryable)
        self.assertTrue(raised.exception.proxy_verified)

    def test_analyzer_error_preserves_retryability_without_credentials(self) -> None:
        self.analyzer.error = AnalyzerError(
            "analyzing",
            "Gemini overloaded.",
            retryable=True,
        )
        with self.assertRaises(WorkerError) as raised:
            self.worker.run(self.job)
        self.assertEqual(raised.exception.code, "gemini_failed")
        self.assertTrue(raised.exception.retryable)
        self.assertNotIn("key", raised.exception.message.lower())


if __name__ == "__main__":
    unittest.main()
