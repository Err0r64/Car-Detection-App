"""Persistent stores for analysis job metadata."""

from __future__ import annotations

import json
from threading import Lock
from typing import Callable, Protocol

from .domain import AnalysisJob, JobDomainError


class JobNotFoundError(LookupError):
    pass


class JobConflictError(RuntimeError):
    pass


class JobStore(Protocol):
    def create(self, job: AnalysisJob) -> tuple[AnalysisJob, bool]: ...

    def get(self, job_id: str) -> AnalysisJob: ...

    def update(self, job_id: str, mutate: Callable[[AnalysisJob], AnalysisJob]) -> AnalysisJob: ...

    def delete(self, job_id: str) -> bool: ...


class InMemoryJobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, AnalysisJob] = {}
        self._lock = Lock()

    def create(self, job: AnalysisJob) -> tuple[AnalysisJob, bool]:
        with self._lock:
            existing = self._jobs.get(job.job_id)
            if existing is not None:
                return existing, False
            self._jobs[job.job_id] = job
            return job, True

    def get(self, job_id: str) -> AnalysisJob:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise JobNotFoundError("Analysis job was not found.")
            return job

    def update(
        self,
        job_id: str,
        mutate: Callable[[AnalysisJob], AnalysisJob],
    ) -> AnalysisJob:
        with self._lock:
            current = self._jobs.get(job_id)
            if current is None:
                raise JobNotFoundError("Analysis job was not found.")
            updated = mutate(current)
            self._jobs[job_id] = updated
            return updated

    def delete(self, job_id: str) -> bool:
        with self._lock:
            return self._jobs.pop(job_id, None) is not None


class GcsJobStore:
    """Optimistic JSON job records stored in the private proxy bucket."""

    def __init__(self, bucket_name: str, client: object | None = None) -> None:
        if client is None:
            from google.cloud import storage

            client = storage.Client()
        self._bucket = client.bucket(bucket_name)

    @staticmethod
    def _object_name(job_id: str) -> str:
        return f"jobs/{job_id}.json"

    @staticmethod
    def _encode(job: AnalysisJob) -> str:
        return json.dumps(
            job.record_dict(),
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        )

    def _load(self, job_id: str) -> tuple[AnalysisJob, int]:
        blob = self._bucket.get_blob(self._object_name(job_id))
        if blob is None:
            raise JobNotFoundError("Analysis job was not found.")
        generation = int(blob.generation)
        try:
            payload = blob.download_as_bytes(if_generation_match=generation)
            value = json.loads(payload.decode("utf-8"))
            return AnalysisJob.from_record(value), generation
        except JobDomainError:
            raise
        except Exception as error:
            raise RuntimeError("Stored analysis job could not be read.") from error

    def create(self, job: AnalysisJob) -> tuple[AnalysisJob, bool]:
        from google.api_core.exceptions import PreconditionFailed

        blob = self._bucket.blob(self._object_name(job.job_id))
        try:
            blob.upload_from_string(
                self._encode(job),
                content_type="application/json",
                if_generation_match=0,
            )
            return job, True
        except PreconditionFailed:
            return self.get(job.job_id), False

    def get(self, job_id: str) -> AnalysisJob:
        job, _generation = self._load(job_id)
        return job

    def update(
        self,
        job_id: str,
        mutate: Callable[[AnalysisJob], AnalysisJob],
    ) -> AnalysisJob:
        from google.api_core.exceptions import PreconditionFailed

        for _attempt in range(3):
            current, generation = self._load(job_id)
            updated = mutate(current)
            blob = self._bucket.blob(self._object_name(job_id))
            try:
                blob.upload_from_string(
                    self._encode(updated),
                    content_type="application/json",
                    if_generation_match=generation,
                )
                return updated
            except PreconditionFailed:
                continue
        raise JobConflictError("Analysis job changed concurrently; retry the request.")

    def delete(self, job_id: str) -> bool:
        from google.api_core.exceptions import NotFound

        blob = self._bucket.get_blob(self._object_name(job_id))
        if blob is None:
            return False
        try:
            blob.delete(if_generation_match=int(blob.generation))
            return True
        except NotFound:
            return False
