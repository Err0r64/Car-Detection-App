"""Proxy upload grants, inspection, and generation-pinned downloads."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
from pathlib import Path
from typing import Mapping, Protocol

from .domain import AnalysisJob


JOB_METADATA_KEY = "apexiel-job-id"
SHA256_METADATA_KEY = "apexiel-proxy-sha256"
DOWNLOAD_CHUNK_BYTES = 1024 * 1024


@dataclass(frozen=True)
class UploadGrant:
    url: str
    expires_at: datetime
    required_headers: Mapping[str, str]


@dataclass(frozen=True)
class StoredProxy:
    size_bytes: int
    content_type: str
    metadata: Mapping[str, str]
    generation: int


@dataclass(frozen=True)
class ProxyDownload:
    size_bytes: int
    sha256: str


class ProxyUploads(Protocol):
    enabled: bool

    def create_grant(self, job: AnalysisJob) -> UploadGrant: ...

    def inspect(self, object_name: str) -> StoredProxy | None: ...

    def download_to(
        self,
        object_name: str,
        generation: int,
        destination: Path,
    ) -> ProxyDownload: ...

    def delete(self, object_name: str, generation: int | None = None) -> None: ...


class DisabledProxyUploads:
    enabled = False

    def create_grant(self, job: AnalysisJob) -> UploadGrant:
        raise RuntimeError("Proxy uploads are not configured.")

    def inspect(self, object_name: str) -> StoredProxy | None:
        return None

    def download_to(
        self,
        object_name: str,
        generation: int,
        destination: Path,
    ) -> ProxyDownload:
        raise RuntimeError("Proxy downloads are not configured.")

    def delete(self, object_name: str, generation: int | None = None) -> None:
        return None


class InMemoryProxyUploads:
    enabled = True

    def __init__(self) -> None:
        self.objects: dict[str, StoredProxy] = {}
        self.contents: dict[str, bytes] = {}
        self.deleted: list[str] = []

    def create_grant(self, job: AnalysisJob) -> UploadGrant:
        return UploadGrant(
            url=f"https://upload.invalid/{job.job_id}",
            expires_at=job.upload_expires_at,
            required_headers={
                "Content-Type": job.proxy_content_type,
                "x-goog-if-generation-match": "0",
                f"x-goog-meta-{JOB_METADATA_KEY}": job.job_id,
                f"x-goog-meta-{SHA256_METADATA_KEY}": job.proxy_sha256,
            },
        )

    def put(
        self,
        job: AnalysisJob,
        *,
        data: bytes | None = None,
        size_bytes: int | None = None,
        content_type: str | None = None,
        job_id: str | None = None,
        sha256: str | None = None,
        generation: int = 1,
    ) -> None:
        if size_bytes is None:
            size_bytes = len(data) if data is not None else job.proxy_size_bytes
        self.objects[job.proxy_object] = StoredProxy(
            size_bytes=size_bytes,
            content_type=job.proxy_content_type if content_type is None else content_type,
            metadata={
                JOB_METADATA_KEY: job.job_id if job_id is None else job_id,
                SHA256_METADATA_KEY: job.proxy_sha256 if sha256 is None else sha256,
            },
            generation=generation,
        )
        if data is not None:
            self.contents[job.proxy_object] = data

    def inspect(self, object_name: str) -> StoredProxy | None:
        return self.objects.get(object_name)

    def download_to(
        self,
        object_name: str,
        generation: int,
        destination: Path,
    ) -> ProxyDownload:
        stored = self.objects.get(object_name)
        data = self.contents.get(object_name)
        if stored is None or data is None or stored.generation != generation:
            raise FileNotFoundError("Stored proxy generation was not found")
        destination.write_bytes(data)
        return ProxyDownload(
            size_bytes=len(data),
            sha256=hashlib.sha256(data).hexdigest(),
        )

    def delete(self, object_name: str, generation: int | None = None) -> None:
        stored = self.objects.get(object_name)
        if stored is not None and (generation is None or stored.generation == generation):
            self.objects.pop(object_name, None)
            self.contents.pop(object_name, None)
            self.deleted.append(object_name)


class GoogleCloudProxyUploads:
    enabled = True

    def __init__(
        self,
        bucket_name: str,
        service_account_email: str,
        client: object | None = None,
        signing_credentials: object | None = None,
    ) -> None:
        if client is None or signing_credentials is None:
            import google.auth
            from google.auth import iam
            from google.auth.transport import requests
            from google.cloud import storage
            from google.oauth2 import service_account

            credentials, _project = google.auth.default(
                scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )
            if client is None:
                client = storage.Client(credentials=credentials)
            if signing_credentials is None:
                signer = iam.Signer(
                    requests.Request(),
                    credentials,
                    service_account_email,
                )
                signing_credentials = service_account.Credentials(
                    signer=signer,
                    service_account_email=service_account_email,
                    token_uri="https://oauth2.googleapis.com/token",
                )
        self._bucket = client.bucket(bucket_name)
        self._signing_credentials = signing_credentials

    def create_grant(self, job: AnalysisJob) -> UploadGrant:
        required_headers = {
            "Content-Type": job.proxy_content_type,
            "x-goog-if-generation-match": "0",
            f"x-goog-meta-{JOB_METADATA_KEY}": job.job_id,
            f"x-goog-meta-{SHA256_METADATA_KEY}": job.proxy_sha256,
        }
        blob = self._bucket.blob(job.proxy_object)
        url = blob.generate_signed_url(
            version="v4",
            expiration=job.upload_expires_at,
            method="PUT",
            content_type=job.proxy_content_type,
            headers={
                key: value
                for key, value in required_headers.items()
                if key.lower() != "content-type"
            },
            credentials=self._signing_credentials,
        )
        return UploadGrant(
            url=url,
            expires_at=job.upload_expires_at,
            required_headers=required_headers,
        )

    def inspect(self, object_name: str) -> StoredProxy | None:
        blob = self._bucket.get_blob(object_name)
        if blob is None:
            return None
        return StoredProxy(
            size_bytes=int(blob.size),
            content_type=blob.content_type or "",
            metadata=dict(blob.metadata or {}),
            generation=int(blob.generation),
        )

    def download_to(
        self,
        object_name: str,
        generation: int,
        destination: Path,
    ) -> ProxyDownload:
        blob = self._bucket.blob(object_name, generation=generation)
        digest = hashlib.sha256()
        total = 0
        with blob.open("rb") as source, destination.open("xb") as target:
            while True:
                chunk = source.read(DOWNLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                digest.update(chunk)
                target.write(chunk)
                total += len(chunk)
        return ProxyDownload(size_bytes=total, sha256=digest.hexdigest())

    def delete(self, object_name: str, generation: int | None = None) -> None:
        from google.api_core.exceptions import NotFound, PreconditionFailed

        blob = self._bucket.blob(object_name)
        try:
            blob.delete(if_generation_match=generation)
        except (NotFound, PreconditionFailed):
            return
