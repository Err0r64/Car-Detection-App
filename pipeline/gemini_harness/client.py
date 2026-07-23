"""One-call Gemini client adapted from the research harness."""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
import sys
import time
from typing import Any, Callable

from . import config
from .schema import RunConfig, RunMeta


Observer = Callable[[str, dict[str, Any]], None]


class _ProgressReader(io.BufferedReader):
    def __init__(self, path: Path, observer: Observer) -> None:
        super().__init__(path.open("rb"))
        self._total = path.stat().st_size
        self._reported = 0
        self._observer = observer

    def read(self, size: int = -1) -> bytes:
        data = super().read(size)
        if data:
            self._reported += len(data)
            self._observer(
                "upload_progress",
                {"bytesUploaded": min(self._reported, self._total), "bytesTotal": self._total},
            )
        return data


class GeminiClient:
    def __init__(
        self,
        raw_dir: Path,
        *,
        model: str = config.MODEL,
        dry_run: bool = False,
        observer: Observer | None = None,
    ) -> None:
        self.model = model
        self.raw_dir = raw_dir
        self.dry_run = dry_run
        self.observer = observer or (lambda _event, _payload: None)
        self._client = None
        self._uploaded_file = None
        self._request_times: list[float] = []

        if dry_run:
            return
        key = config.api_key()
        if not key:
            raise RuntimeError("GEMINI_API_KEY is not set")
        try:
            from google import genai
        except ImportError as error:
            raise RuntimeError(
                "google-genai is not installed; run: python -m pip install -r pipeline/requirements.txt"
            ) from error
        self._client = genai.Client(api_key=key)

    def upload(self, video_path: Path) -> object:
        if self.dry_run:
            size = video_path.stat().st_size
            self.observer("upload_progress", {"bytesUploaded": size, "bytesTotal": size})
            self._uploaded_file = _DryUploadedFile()
            return self._uploaded_file

        from google.genai import types

        with _ProgressReader(video_path, self.observer) as reader:
            uploaded = self._client.files.upload(
                file=reader,
                config=types.UploadFileConfig(
                    display_name=video_path.name,
                    mime_type="video/mp4",
                ),
            )
        self._uploaded_file = uploaded
        return uploaded

    def wait_until_active(self, uploaded: object) -> object:
        if self.dry_run:
            self.observer("processing_poll", {"state": "ACTIVE", "elapsedS": 0.0})
            return uploaded

        started = time.monotonic()
        current = uploaded
        while True:
            state = getattr(getattr(current, "state", None), "name", str(getattr(current, "state", "")))
            elapsed = time.monotonic() - started
            self.observer("processing_poll", {"state": state, "elapsedS": round(elapsed, 3)})
            if state == "ACTIVE":
                return current
            if state == "FAILED":
                raise RuntimeError("Gemini failed to process the uploaded proxy")
            if state != "PROCESSING":
                raise RuntimeError(f"Gemini returned unexpected file state: {state or 'unknown'}")
            if elapsed >= config.PROCESSING_TIMEOUT_S:
                raise RuntimeError(
                    f"Gemini file processing timed out after {config.PROCESSING_TIMEOUT_S:.0f} seconds"
                )
            time.sleep(1.0)
            current = self._client.files.get(name=current.name)

    def analyze(
        self,
        uploaded: object,
        prompt: str,
        run_config: RunConfig,
        run_id: str,
    ) -> tuple[str, RunMeta]:
        if run_config.temperature != 0:
            raise ValueError("temperature must be 0")
        if run_config.fps is None:
            raise ValueError("fps must be explicit")

        raw_path = self.raw_dir / f"{run_id}.txt"
        started = time.monotonic()
        if self.dry_run:
            text = self._dry_response()
            self.observer("tokens", {"inputTokens": 0, "outputTokens": 24})
            self._write_raw(raw_path, text)
            return text, RunMeta(
                output_tokens=24,
                latency_s=time.monotonic() - started,
                call_count=1,
                raw_paths=[os.fspath(raw_path.resolve())],
            )

        from google.genai import types

        generation_config = types.GenerateContentConfig(
            temperature=run_config.temperature,
            media_resolution=getattr(types.MediaResolution, run_config.media_resolution),
        )
        video_part = types.Part(
            file_data=types.FileData(
                file_uri=uploaded.uri,
                mime_type=getattr(uploaded, "mime_type", "video/mp4"),
            ),
            video_metadata=types.VideoMetadata(fps=run_config.fps),
        )
        text, input_tokens, output_tokens = self._stream_with_retry(
            [video_part, prompt], generation_config
        )
        self._write_raw(raw_path, text)
        return text, RunMeta(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            latency_s=time.monotonic() - started,
            call_count=1,
            raw_paths=[os.fspath(raw_path.resolve())],
        )

    def _stream_with_retry(self, contents: list[Any], generation_config: Any) -> tuple[str, int, int]:
        from google.genai import errors

        last_error: Exception | None = None
        for attempt in range(config.MAX_RETRIES_429 + 1):
            self._throttle()
            chunks: list[str] = []
            input_tokens = 0
            output_tokens = 0
            try:
                response = self._client.models.generate_content_stream(
                    model=self.model,
                    contents=contents,
                    config=generation_config,
                )
                for chunk in response:
                    chunk_text = getattr(chunk, "text", None)
                    if chunk_text:
                        chunks.append(chunk_text)
                    usage = getattr(chunk, "usage_metadata", None)
                    next_input = getattr(usage, "prompt_token_count", 0) or input_tokens
                    next_output = getattr(usage, "candidates_token_count", 0) or output_tokens
                    if next_input != input_tokens or next_output != output_tokens:
                        input_tokens = next_input
                        output_tokens = next_output
                        self.observer(
                            "tokens",
                            {"inputTokens": input_tokens, "outputTokens": output_tokens},
                        )
                if input_tokens == 0 and output_tokens == 0:
                    self.observer("tokens", {"inputTokens": 0, "outputTokens": 0})
                return "".join(chunks), input_tokens, output_tokens
            except errors.ClientError as error:
                if getattr(error, "code", None) != 429 or chunks:
                    raise
                last_error = error
                if attempt >= config.MAX_RETRIES_429:
                    break
                delay = self._retry_delay(error, attempt)
                print(f"Gemini rate-limited the request; retrying in {delay:.0f}s", file=sys.stderr)
                time.sleep(delay)
        assert last_error is not None
        raise last_error

    def _throttle(self) -> None:
        limit = config.REQUESTS_PER_MINUTE
        if limit <= 0:
            return
        now = time.time()
        self._request_times = [stamp for stamp in self._request_times if now - stamp < config.RATE_WINDOW_S]
        if len(self._request_times) >= limit:
            delay = config.RATE_WINDOW_S - (now - min(self._request_times)) + config.RATE_MARGIN_S
            if delay > 0:
                time.sleep(delay)
        self._request_times.append(time.time())

    @staticmethod
    def _retry_delay(error: Exception, attempt: int) -> float:
        server_delay = None
        try:
            details = ((getattr(error, "details", None) or {}).get("error") or {}).get("details") or []
            for item in details:
                if isinstance(item, dict) and "RetryInfo" in str(item.get("@type", "")):
                    server_delay = float(str(item.get("retryDelay", "")).rstrip("s"))
        except (AttributeError, TypeError, ValueError):
            server_delay = None
        return (
            server_delay + config.RATE_MARGIN_S
            if server_delay is not None
            else min(5.0 * (2**attempt), 65.0)
        )

    def _write_raw(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    @staticmethod
    def _dry_response() -> str:
        return json.dumps(
            {
                "appearances": [
                    {
                        "appearance_id": "dry1",
                        "start_time_seconds": "0:01",
                        "end_time_seconds": 5.4,
                        "car_number": "0",
                        "is_target_vehicle": True,
                        "vehicle_description": "dry-run stub vehicle",
                        "detection_confidence": 0.9,
                        "subject_confidence": 0.9,
                    }
                ]
            }
        )

    def cleanup(self) -> None:
        if self.dry_run or self._client is None or self._uploaded_file is None:
            return
        try:
            self._client.files.delete(name=self._uploaded_file.name)
        except Exception as error:
            print(f"Could not delete Gemini upload: {error}", file=sys.stderr)
        finally:
            self._uploaded_file = None


class _DryUploadedFile:
    uri = "dry-run://proxy"
    mime_type = "video/mp4"
    name = "files/dry-run"
    state = type("State", (), {"name": "ACTIVE"})()
