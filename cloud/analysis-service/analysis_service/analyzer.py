"""Adapter around the validated local Gemini harness."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import tempfile
from typing import Any, Protocol


class AnalyzerError(RuntimeError):
    def __init__(self, stage: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.stage = stage
        self.message = message
        self.retryable = retryable


@dataclass(frozen=True)
class AnalyzerResult:
    detections: tuple[dict[str, Any], ...]
    model: str
    input_tokens: int
    output_tokens: int


class Analyzer(Protocol):
    enabled: bool

    def analyze(
        self,
        proxy_path: Path,
        *,
        duration_s: float,
        prompt_instructions: str,
    ) -> AnalyzerResult: ...


class DisabledAnalyzer:
    enabled = False

    def analyze(
        self,
        proxy_path: Path,
        *,
        duration_s: float,
        prompt_instructions: str,
    ) -> AnalyzerResult:
        raise AnalyzerError("startup", "Gemini analysis is not configured.")


class GeminiAnalyzer:
    enabled = True

    def __init__(self) -> None:
        if not os.environ.get("GEMINI_API_KEY"):
            raise RuntimeError("GEMINI_API_KEY must be supplied by Secret Manager")

    def analyze(
        self,
        proxy_path: Path,
        *,
        duration_s: float,
        prompt_instructions: str,
    ) -> AnalyzerResult:
        try:
            from gemini_harness import GeminiClient, RunConfig
            from gemini_harness import config as gemini_config
            from gemini_harness.prompts import render as render_prompt
            from stages import _normalize
        except ImportError as error:
            raise AnalyzerError(
                "startup",
                "The validated Gemini harness is unavailable in the worker image.",
            ) from error

        with tempfile.TemporaryDirectory(prefix="apexiel-gemini-") as raw_directory:
            try:
                client = GeminiClient(Path(raw_directory))
                uploaded = client.upload(proxy_path)
                uploaded = client.wait_until_active(uploaded)
                config = RunConfig(
                    model=gemini_config.MODEL,
                    temperature=gemini_config.TEMPERATURE,
                    fps=gemini_config.DEFAULT_FPS,
                    media_resolution=gemini_config.DEFAULT_MEDIA_RESOLUTION,
                )
                raw_text, meta = client.analyze(
                    uploaded,
                    render_prompt(duration_s, prompt_instructions),
                    config,
                    "cloud-analysis",
                )
                normalized = _normalize(raw_text, duration_s)
                return AnalyzerResult(
                    detections=tuple(normalized["detections"]),
                    model=gemini_config.MODEL,
                    input_tokens=meta.input_tokens,
                    output_tokens=meta.output_tokens,
                )
            except Exception as error:
                status_code = int(getattr(error, "code", 0) or 0)
                retryable = status_code in {429, 500, 502, 503, 504}
                stage = getattr(error, "stage", "analyzing")
                if status_code == 429:
                    message = "Gemini rate limiting prevented analysis."
                elif retryable:
                    message = "Gemini is temporarily unavailable."
                elif stage == "upload":
                    message = "Gemini could not accept the proxy."
                elif stage == "processing":
                    message = "Gemini could not process the proxy."
                elif stage == "parsing":
                    message = "Gemini returned invalid detection results."
                elif stage == "startup":
                    message = "The Gemini worker is not configured."
                else:
                    message = "Gemini analysis failed."
                raise AnalyzerError(stage, message, retryable=retryable) from error
            finally:
                if "client" in locals():
                    client.cleanup()
