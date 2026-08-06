"""One-call Gemini client adapted from the research harness."""

from __future__ import annotations

from contextlib import contextmanager
import io
import json
import os
from pathlib import Path
import random
import sys
import time
from typing import Any, Callable, Iterator

from . import config
from .schema import RunConfig, RunMeta


Observer = Callable[[str, dict[str, Any]], None]

RESPONSE_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "appearances": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "appearance_id": {"type": "string"},
                    "start_time_seconds": {"type": "number"},
                    "end_time_seconds": {"type": "number"},
                    "car_number": {"type": ["string", "null"]},
                    "is_target_vehicle": {"type": "boolean"},
                    "vehicle_description": {"type": "string"},
                    "detection_confidence": {"type": "number"},
                    "subject_confidence": {"type": "number"},
                },
                "required": [
                    "appearance_id",
                    "start_time_seconds",
                    "end_time_seconds",
                    "car_number",
                    "is_target_vehicle",
                    "vehicle_description",
                    "detection_confidence",
                    "subject_confidence",
                ],
                "additionalProperties": False,
            },
        }
    },
    "required": ["appearances"],
    "additionalProperties": False,
}


@contextmanager
def _exclusive_file_lock(lock_path: Path) -> Iterator[None]:
    """Hold a small cross-process lock while updating request history."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+b")
    locked = False
    try:
        if handle.seek(0, os.SEEK_END) == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)

        if os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        locked = True
        yield
    finally:
        if locked:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def _load_rate_history(state_path: Path) -> dict[str, list[float]]:
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    if not isinstance(data, dict):
        return {}

    history: dict[str, list[float]] = {}
    for model, timestamps in data.items():
        if not isinstance(model, str) or not isinstance(timestamps, list):
            continue
        history[model] = [
            float(timestamp)
            for timestamp in timestamps
            if isinstance(timestamp, (int, float))
        ]
    return history


def _write_rate_history(state_path: Path, history: dict[str, list[float]]) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = state_path.with_name(f".{state_path.name}.{os.getpid()}.tmp")
    try:
        temporary_path.write_text(json.dumps(history), encoding="utf-8")
        temporary_path.replace(state_path)
    finally:
        temporary_path.unlink(missing_ok=True)


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
        rate_limit_path: Path | None = None,
        max_request_attempts: int | None = None,
        request_timeout_ms: int | None = None,
    ) -> None:
        self.model = model
        self.raw_dir = raw_dir
        self.dry_run = dry_run
        self.observer = observer or (lambda _event, _payload: None)
        self.rate_limit_path = rate_limit_path or config.rate_limit_path()
        self.max_request_attempts = (
            config.MAX_REQUEST_ATTEMPTS
            if max_request_attempts is None
            else max_request_attempts
        )
        if (
            not isinstance(self.max_request_attempts, int)
            or isinstance(self.max_request_attempts, bool)
            or not 1 <= self.max_request_attempts <= 10
        ):
            raise ValueError("max_request_attempts must be between 1 and 10")
        if request_timeout_ms is not None and (
            not isinstance(request_timeout_ms, int)
            or isinstance(request_timeout_ms, bool)
            or not 1_000 <= request_timeout_ms <= 30 * 60 * 1_000
        ):
            raise ValueError("request_timeout_ms must be between 1000 and 1800000")
        self.request_timeout_ms = request_timeout_ms
        self._client = None
        self._uploaded_file = None

        if dry_run:
            return
        key = config.api_key()
        if not key:
            raise RuntimeError("GEMINI_API_KEY is not set")
        try:
            from google import genai
            from google.genai import types
        except ImportError as error:
            raise RuntimeError(
                "google-genai is not installed; run: python -m pip install -r pipeline/requirements.txt"
            ) from error
        http_options = (
            types.HttpOptions(
                timeout=self.request_timeout_ms,
                retry_options=types.HttpRetryOptions(attempts=1),
            )
            if self.request_timeout_ms is not None
            else None
        )
        self._client = genai.Client(api_key=key, http_options=http_options)

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
            seed=config.SEED,
            media_resolution=getattr(types.MediaResolution, run_config.media_resolution),
            response_mime_type="application/json",
            response_json_schema=RESPONSE_JSON_SCHEMA,
            http_options=types.HttpOptions(
                timeout=self.request_timeout_ms,
                retry_options=types.HttpRetryOptions(attempts=1),
            ),
        )
        video_part = types.Part(
            file_data=types.FileData(
                file_uri=uploaded.uri,
                mime_type=getattr(uploaded, "mime_type", "video/mp4"),
            ),
            video_metadata=types.VideoMetadata(fps=run_config.fps),
        )
        text, input_tokens, output_tokens, call_count = self._generate_with_retry(
            [video_part, prompt], generation_config
        )
        self._write_raw(raw_path, text)
        return text, RunMeta(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            latency_s=time.monotonic() - started,
            call_count=call_count,
            raw_paths=[os.fspath(raw_path.resolve())],
        )

    def _generate_with_retry(
        self,
        contents: list[Any],
        generation_config: Any,
    ) -> tuple[str, int, int, int]:
        from google.genai import errors

        last_error: Exception | None = None
        for attempt in range(self.max_request_attempts):
            self._throttle()
            if attempt > 0:
                self.observer(
                    "retry_start",
                    {"attempt": attempt + 1, "maxAttempts": self.max_request_attempts},
                )
            try:
                response = self._client.models.generate_content(
                    model=self.model,
                    contents=contents,
                    config=generation_config,
                )
                usage = getattr(response, "usage_metadata", None)
                input_tokens = getattr(usage, "prompt_token_count", 0) or 0
                output_tokens = getattr(usage, "candidates_token_count", 0) or 0
                self.observer(
                    "tokens",
                    {"inputTokens": input_tokens, "outputTokens": output_tokens},
                )
                return (
                    getattr(response, "text", "") or "",
                    input_tokens,
                    output_tokens,
                    attempt + 1,
                )
            except errors.APIError as error:
                status_code = int(getattr(error, "code", 0) or 0)
                last_error = error
                if (
                    status_code not in config.RETRYABLE_STATUS_CODES
                    or attempt + 1 >= self.max_request_attempts
                ):
                    raise

                delay = self._retry_delay(error, attempt)
                next_attempt = attempt + 2
                self.observer(
                    "retry_wait",
                    {
                        "statusCode": status_code,
                        "delayS": round(delay, 3),
                        "attempt": next_attempt,
                        "maxAttempts": self.max_request_attempts,
                    },
                )
                reason = self._retry_reason(status_code)
                print(
                    f"{reason}; retrying in {delay:.1f}s "
                    f"(attempt {next_attempt}/{self.max_request_attempts})",
                    file=sys.stderr,
                )
                time.sleep(delay)

        assert last_error is not None
        raise last_error

    def _throttle(self) -> None:
        limit = config.REQUESTS_PER_MINUTE
        if limit <= 0:
            return

        lock_path = self.rate_limit_path.with_name(f"{self.rate_limit_path.name}.lock")
        while True:
            with _exclusive_file_lock(lock_path):
                now = time.time()
                history = _load_rate_history(self.rate_limit_path)
                recent = sorted(
                    timestamp
                    for timestamp in history.get(self.model, [])
                    if 0 <= now - timestamp < config.RATE_WINDOW_S
                )

                spacing_delay = 0.0
                if recent:
                    spacing_delay = config.MIN_REQUEST_INTERVAL_S - (now - recent[-1])

                window_delay = 0.0
                if len(recent) >= limit:
                    window_delay = config.RATE_WINDOW_S - (now - recent[-limit])

                delay = max(0.0, spacing_delay, window_delay)
                if delay <= 0:
                    recent.append(now)
                    history[self.model] = recent
                    _write_rate_history(self.rate_limit_path, history)
                    return

            delay += config.RATE_MARGIN_S
            self.observer(
                "rate_limit_wait",
                {
                    "delayS": round(delay, 3),
                    "requestsPerMinute": limit,
                },
            )
            time.sleep(delay)

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

        if server_delay is not None:
            delay = server_delay + config.RATE_MARGIN_S
        else:
            base_delay = min(
                config.RETRY_INITIAL_DELAY_S * (2**attempt),
                config.RETRY_MAX_DELAY_S,
            )
            jitter = base_delay * config.RETRY_JITTER_RATIO
            delay = random.uniform(base_delay - jitter, base_delay + jitter)
        return max(config.MIN_REQUEST_INTERVAL_S, delay)

    @staticmethod
    def _retry_reason(status_code: int) -> str:
        if status_code == 429:
            return "Gemini rate limit reached"
        if status_code == 503:
            return "Gemini is temporarily unavailable"
        return f"Gemini returned transient HTTP {status_code}"

    def _write_raw(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    @staticmethod
    def _dry_response() -> str:
        return json.dumps(
            {
                "appearances": [
                    {
                        "appearance_id": "dry-run-1",
                        "start_time_seconds": 1.25,
                        "end_time_seconds": 5.4,
                        "car_number": "0",
                        "is_target_vehicle": True,
                        "vehicle_description": "Blue dry-run stub vehicle",
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
