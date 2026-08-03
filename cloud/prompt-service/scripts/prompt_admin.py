"""Small administrator CLI for the prompt profile REST API."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def request_json(
    method: str,
    url: str,
    *,
    token: str | None = None,
    payload: dict[str, object] | None = None,
) -> dict[str, object]:
    headers = {"Accept": "application/json"}
    body = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode("utf-8")
    request = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"Could not reach the prompt service: {error.reason}") from error


def admin_token() -> str:
    token = os.getenv("PROMPT_ADMIN_TOKEN")
    if not token:
        raise RuntimeError("Set PROMPT_ADMIN_TOKEN before using an admin command")
    return token


def base_url(value: str) -> str:
    return value.rstrip("/")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Manage cloud prompt profiles")
    parser.add_argument(
        "--service-url",
        required=True,
        help="Cloud Run service URL, such as https://service.run.app",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    create = commands.add_parser("create", help="create a draft from a JSON file")
    create.add_argument("--file", required=True, type=Path)

    publish = commands.add_parser("publish", help="publish one draft revision")
    publish.add_argument("--profile-id", required=True)
    publish.add_argument("--version", required=True, type=int)

    list_command = commands.add_parser("list", help="list prompt revision history")
    list_command.add_argument("--profile-id")

    commands.add_parser("active", help="read the public active profile")

    args = parser.parse_args(argv)
    service_url = base_url(args.service_url)
    try:
        if args.command == "create":
            payload = json.loads(args.file.read_text(encoding="utf-8"))
            result = request_json(
                "POST",
                f"{service_url}/v1/admin/prompt-profiles/drafts",
                token=admin_token(),
                payload=payload,
            )
        elif args.command == "publish":
            result = request_json(
                "POST",
                (
                    f"{service_url}/v1/admin/prompt-profiles/"
                    f"{args.profile_id}/revisions/{args.version}/publish"
                ),
                token=admin_token(),
            )
        elif args.command == "list":
            suffix = f"?profileId={args.profile_id}" if args.profile_id else ""
            result = request_json(
                "GET",
                f"{service_url}/v1/admin/prompt-profiles{suffix}",
                token=admin_token(),
            )
        else:
            result = request_json(
                "GET",
                f"{service_url}/v1/prompt-profiles/active",
            )
    except (OSError, ValueError, RuntimeError) as error:
        print(error, file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

