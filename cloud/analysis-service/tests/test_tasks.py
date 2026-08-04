from __future__ import annotations

from datetime import timedelta
import json
import unittest

from analysis_service.tasks import GoogleCloudTaskDispatcher


JOB_ID = "0b252937-8399-4615-89e2-ea3e7549c6b2"


class FakeTasksClient:
    def __init__(self) -> None:
        self.parent = None
        self.task = None

    def create_task(self, *, parent, task):
        self.parent = parent
        self.task = task
        return object()


class TaskDispatcherTests(unittest.TestCase):
    def test_dispatches_deterministic_oidc_authenticated_task(self) -> None:
        client = FakeTasksClient()
        dispatcher = GoogleCloudTaskDispatcher(
            queue_path=(
                "projects/example/locations/us-west1/queues/apexiel-analysis"
            ),
            service_url="https://analysis.example.test/",
            invoker_service_account="worker@example.iam.gserviceaccount.com",
            client=client,
        )
        dispatcher.dispatch(JOB_ID)

        self.assertEqual(
            client.parent,
            "projects/example/locations/us-west1/queues/apexiel-analysis",
        )
        task = client.task
        self.assertTrue(
            task["name"].endswith(
                "/tasks/analysis-0b2529378399461589e2ea3e7549c6b2"
            )
        )
        request = task["http_request"]
        self.assertEqual(
            request["url"],
            f"https://analysis.example.test/v1/internal/analysis/jobs/{JOB_ID}/run",
        )
        self.assertEqual(json.loads(request["body"]), {"schemaVersion": 1})
        self.assertEqual(
            request["oidc_token"]["service_account_email"],
            "worker@example.iam.gserviceaccount.com",
        )
        self.assertEqual(
            request["oidc_token"]["audience"],
            "https://analysis.example.test",
        )
        self.assertEqual(task["dispatch_deadline"], timedelta(minutes=30))


if __name__ == "__main__":
    unittest.main()
