from __future__ import annotations

import json
import unittest

import httpx

from analysis_service.prompt_profiles import HttpPromptProfileProvider, PromptProfileError


def response(profile: dict[str, object], status: int = 200) -> httpx.Response:
    return httpx.Response(
        status,
        content=json.dumps({"schemaVersion": 1, "profile": profile}).encode(),
        headers={
            "Content-Type": "application/json",
            "ETag": f'"{profile.get("etag", "")}"',
        },
    )


VALID_PROFILE = {
    "profileId": "motorsports-default",
    "version": 2,
    "instructions": "Report each physical race vehicle separately.",
    "etag": "d" * 64,
}


class PromptProfileProviderTests(unittest.TestCase):
    def provider(self, handler):
        return HttpPromptProfileProvider(
            "https://prompt.example.test",
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        )

    def test_loads_strict_active_profile(self) -> None:
        provider = self.provider(lambda request: response(VALID_PROFILE))
        profile = provider.load()
        self.assertEqual(profile.profile_id, "motorsports-default")
        self.assertEqual(profile.version, 2)
        self.assertEqual(profile.etag, "d" * 64)

    def test_rejects_redirects_and_invalid_profiles(self) -> None:
        redirect = self.provider(
            lambda request: httpx.Response(
                302,
                headers={"Location": "https://unexpected.example/"},
            )
        )
        with self.assertRaises(PromptProfileError):
            redirect.load()

        invalid = self.provider(
            lambda request: response({**VALID_PROFILE, "instructions": ""})
        )
        with self.assertRaises(PromptProfileError):
            invalid.load()

    def test_requires_https_except_for_local_development(self) -> None:
        with self.assertRaises(ValueError):
            HttpPromptProfileProvider("http://prompt.example.test")
        HttpPromptProfileProvider("http://127.0.0.1:8080")


if __name__ == "__main__":
    unittest.main()
