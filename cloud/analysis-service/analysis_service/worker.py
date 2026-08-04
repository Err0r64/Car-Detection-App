"""Server-side analysis orchestration over trusted storage objects."""

from __future__ import annotations

from contextlib import AbstractContextManager
from dataclasses import dataclass
from pathlib import Path
import tempfile
from typing import Any, Callable, Protocol

from .analyzer import Analyzer, AnalyzerError
from .domain import AnalysisJob
from .prompt_profiles import HttpPromptProfileProvider, PromptProfileError
from .uploads import ProxyUploads


class WorkerError(RuntimeError):
    def __init__(
        self,
        stage: str,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        proxy_verified: bool = False,
    ) -> None:
        super().__init__(message)
        self.stage = stage
        self.code = code
        self.message = message
        self.retryable = retryable
        self.proxy_verified = proxy_verified


@dataclass(frozen=True)
class WorkerResult:
    detections: tuple[dict[str, Any], ...]
    model: str
    prompt_profile_id: str
    prompt_profile_version: int
    prompt_etag: str
    input_tokens: int
    output_tokens: int


class AnalysisWorker(Protocol):
    enabled: bool

    def run(self, job: AnalysisJob) -> WorkerResult: ...


class DisabledAnalysisWorker:
    enabled = False

    def run(self, job: AnalysisJob) -> WorkerResult:
        raise WorkerError("startup", "worker_disabled", "Analysis is not configured.")


class ServerAnalysisWorker:
    enabled = True

    def __init__(
        self,
        *,
        uploads: ProxyUploads,
        prompt_provider: HttpPromptProfileProvider,
        analyzer: Analyzer,
        temporary_directory: Path | None = None,
        scratch_factory: Callable[[], AbstractContextManager[str]] | None = None,
    ) -> None:
        self._uploads = uploads
        self._prompt_provider = prompt_provider
        self._analyzer = analyzer
        self._temporary_directory = temporary_directory
        self._scratch_factory = scratch_factory

    def _scratch(self) -> AbstractContextManager[str]:
        if self._scratch_factory is not None:
            return self._scratch_factory()
        return tempfile.TemporaryDirectory(
            prefix="apexiel-analysis-",
            dir=self._temporary_directory,
            ignore_cleanup_errors=True,
        )

    def run(self, job: AnalysisJob) -> WorkerResult:
        if job.object_generation is None:
            raise WorkerError(
                "integrity",
                "missing_proxy_generation",
                "The uploaded proxy generation is missing.",
            )

        with self._scratch() as directory:
            proxy_path = Path(directory) / "proxy.mp4"
            try:
                downloaded = self._uploads.download_to(
                    job.proxy_object,
                    job.object_generation,
                    proxy_path,
                )
            except Exception as error:
                raise WorkerError(
                    "integrity",
                    "proxy_download_failed",
                    "The uploaded proxy could not be read.",
                    retryable=True,
                ) from error

            if (
                downloaded.size_bytes != job.proxy_size_bytes
                or downloaded.sha256 != job.proxy_sha256
            ):
                raise WorkerError(
                    "integrity",
                    "proxy_hash_mismatch",
                    "The uploaded proxy failed SHA-256 verification.",
                )

            try:
                prompt = self._prompt_provider.load()
            except PromptProfileError as error:
                raise WorkerError(
                    "prompt",
                    "prompt_unavailable",
                    str(error),
                    retryable=True,
                    proxy_verified=True,
                ) from error

            try:
                result = self._analyzer.analyze(
                    proxy_path,
                    duration_s=job.source_duration_s,
                    prompt_instructions=prompt.instructions,
                )
            except AnalyzerError as error:
                raise WorkerError(
                    error.stage,
                    "gemini_failed",
                    error.message,
                    retryable=error.retryable,
                    proxy_verified=True,
                ) from error

            return WorkerResult(
                detections=result.detections,
                model=result.model,
                prompt_profile_id=prompt.profile_id,
                prompt_profile_version=prompt.version,
                prompt_etag=prompt.etag,
                input_tokens=result.input_tokens,
                output_tokens=result.output_tokens,
            )
