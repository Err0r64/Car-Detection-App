"""Durable Cloud Tasks dispatch for server-side analysis workers."""

from __future__ import annotations

from datetime import timedelta
import json
import re
from typing import Mapping, Protocol


TASK_ID_PATTERN = re.compile(r"^analysis-[0-9a-f]{32}$")


class TaskDispatchError(RuntimeError):
    """The durable worker task could not be created."""


class TaskDispatcher(Protocol):
    enabled: bool

    def dispatch(self, job_id: str) -> None: ...

    def accepts(self, headers: Mapping[str, str]) -> bool: ...


class DisabledTaskDispatcher:
    enabled = False

    def dispatch(self, job_id: str) -> None:
        raise TaskDispatchError("Analysis task dispatch is not configured.")

    def accepts(self, headers: Mapping[str, str]) -> bool:
        return False


class InMemoryTaskDispatcher:
    enabled = True

    def __init__(self, queue_name: str = "analysis-test") -> None:
        self.queue_name = queue_name
        self.dispatched: list[str] = []
        self.fail_dispatch = False

    def dispatch(self, job_id: str) -> None:
        if self.fail_dispatch:
            raise TaskDispatchError("Test task dispatch failed.")
        if job_id not in self.dispatched:
            self.dispatched.append(job_id)

    def accepts(self, headers: Mapping[str, str]) -> bool:
        task_name = headers.get("x-cloudtasks-taskname", "")
        queue_name = headers.get("x-cloudtasks-queuename", "")
        return queue_name == self.queue_name and bool(task_name)

    def headers(self, *, retry_count: int = 0) -> dict[str, str]:
        return {
            "X-CloudTasks-QueueName": self.queue_name,
            "X-CloudTasks-TaskName": "analysis-test-task",
            "X-CloudTasks-TaskRetryCount": str(retry_count),
        }


class GoogleCloudTaskDispatcher:
    enabled = True

    def __init__(
        self,
        *,
        queue_path: str,
        service_url: str,
        invoker_service_account: str,
        client: object | None = None,
        dispatch_deadline_seconds: int = 1800,
    ) -> None:
        if not queue_path.startswith("projects/") or "/queues/" not in queue_path:
            raise ValueError("ANALYSIS_TASK_QUEUE must be a full Cloud Tasks queue path")
        if not service_url.startswith("https://"):
            raise ValueError("ANALYSIS_SERVICE_URL must use HTTPS")
        if "@" not in invoker_service_account:
            raise ValueError("ANALYSIS_TASK_INVOKER_SERVICE_ACCOUNT is invalid")
        if not 60 <= dispatch_deadline_seconds <= 1800:
            raise ValueError("Cloud Tasks dispatch deadline must be 60-1800 seconds")

        if client is None:
            from google.cloud import tasks_v2

            client = tasks_v2.CloudTasksClient()
        self._client = client
        self._queue_path = queue_path.rstrip("/")
        self._queue_name = self._queue_path.rsplit("/", 1)[-1]
        self._service_url = service_url.rstrip("/")
        self._invoker_service_account = invoker_service_account
        self._dispatch_deadline = timedelta(seconds=dispatch_deadline_seconds)

    def dispatch(self, job_id: str) -> None:
        from google.api_core.exceptions import AlreadyExists
        from google.cloud import tasks_v2

        task_id = f"analysis-{job_id.replace('-', '')}"
        task = {
            "name": f"{self._queue_path}/tasks/{task_id}",
            "http_request": {
                "http_method": tasks_v2.HttpMethod.POST,
                "url": (
                    f"{self._service_url}/v1/internal/analysis/jobs/{job_id}/run"
                ),
                "headers": {"Content-Type": "application/json"},
                "body": json.dumps(
                    {"schemaVersion": 1},
                    separators=(",", ":"),
                ).encode("utf-8"),
                "oidc_token": {
                    "service_account_email": self._invoker_service_account,
                    "audience": self._service_url,
                },
            },
            "dispatch_deadline": self._dispatch_deadline,
        }
        try:
            self._client.create_task(parent=self._queue_path, task=task)
        except AlreadyExists:
            return
        except Exception as error:
            raise TaskDispatchError("Could not enqueue the analysis worker.") from error

    def accepts(self, headers: Mapping[str, str]) -> bool:
        task_name = headers.get("x-cloudtasks-taskname", "")
        queue_name = headers.get("x-cloudtasks-queuename", "")
        task_id = task_name.rsplit("/", 1)[-1]
        return queue_name == self._queue_name and bool(
            TASK_ID_PATTERN.fullmatch(task_id)
        )
