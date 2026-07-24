"""Gemini upload, processing, analysis, and result parsing stages."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import time
from typing import Any, Callable

from gemini_harness import GeminiClient, RunConfig, parse_appearances
from gemini_harness import config as gemini_config
from gemini_harness.prompts import render as render_prompt


Emit = Callable[..., None]
RESULT_SCHEMA_PATH = Path(__file__).resolve().parent.parent / "detections.schema.json"


class AnalysisStageError(RuntimeError):
    def __init__(self, stage: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage
        self.message = message


def _observer(emit: Emit) -> Callable[[str, dict[str, Any]], None]:
    def observe(event: str, payload: dict[str, Any]) -> None:
        if event == "upload_progress":
            total = int(payload["bytesTotal"])
            uploaded = int(payload["bytesUploaded"])
            progress = 1.0 if total == 0 else min(1.0, uploaded / total)
            emit("upload", "progress", progress=round(progress, 4), **payload)
        elif event == "processing_poll":
            emit("processing", "progress", **payload)
        elif event == "tokens":
            emit("analyzing", "token", **payload)
        elif event == "retry_wait":
            emit("analyzing", "retry", **payload)
        elif event == "retry_start":
            emit("analyzing", "retry_start", **payload)
        elif event == "rate_limit_wait":
            emit("analyzing", "rate_limit", **payload)

    return observe


def _run_gemini(
    proxy_path: Path,
    output_path: Path,
    duration_s: float,
    emit: Emit,
    *,
    dry_run: bool,
) -> str:
    try:
        client = GeminiClient(
            output_path.parent / "raw",
            dry_run=dry_run,
            observer=_observer(emit),
        )
    except (RuntimeError, ValueError) as error:
        raise AnalysisStageError("upload", str(error)) from error

    try:
        emit("upload", "start", bytesTotal=proxy_path.stat().st_size)
        try:
            uploaded = client.upload(proxy_path)
        except Exception as error:
            raise AnalysisStageError("upload", f"Gemini upload failed: {error}") from error
        emit("upload", "complete", progress=1.0)

        emit("processing", "start")
        try:
            uploaded = client.wait_until_active(uploaded)
        except Exception as error:
            raise AnalysisStageError("processing", str(error)) from error
        emit("processing", "complete", progress=1.0)

        emit("analyzing", "start")
        config = RunConfig(
            model=gemini_config.MODEL,
            temperature=gemini_config.TEMPERATURE,
            fps=gemini_config.DEFAULT_FPS,
            media_resolution=gemini_config.DEFAULT_MEDIA_RESOLUTION,
        )
        run_id = f"{output_path.stem}_{time.time_ns()}"
        try:
            raw_text, meta = client.analyze(
                uploaded,
                render_prompt(duration_s),
                config,
                run_id,
            )
        except Exception as error:
            raise AnalysisStageError("analyzing", f"Gemini analysis failed: {error}") from error
        emit(
            "analyzing",
            "complete",
            inputTokens=meta.input_tokens,
            outputTokens=meta.output_tokens,
            rawPath=meta.raw_paths[0],
        )
        return raw_text
    finally:
        client.cleanup()


def _decode_concatenated_mmss(value: float) -> float | None:
    whole = int(value)
    if value != whole or whole < 100:
        return None
    minutes, seconds = divmod(whole, 100)
    if seconds >= 60:
        return None
    return float(minutes * 60 + seconds)


def _recover_wire_bounds(
    start_s: float,
    end_s: float,
    video_duration_s: float,
) -> tuple[float, float]:
    if start_s <= video_duration_s or end_s <= video_duration_s:
        return start_s, end_s

    decoded_start = _decode_concatenated_mmss(start_s)
    decoded_end = _decode_concatenated_mmss(end_s)
    if (
        decoded_start is not None
        and decoded_end is not None
        and decoded_start < decoded_end <= video_duration_s
    ):
        return decoded_start, decoded_end
    return start_s, end_s


def _normalize_bounds(
    start_s: float,
    end_s: float,
    video_duration_s: float,
) -> tuple[float, float] | None:
    if not math.isfinite(start_s) or not math.isfinite(end_s):
        raise ValueError("has non-finite bounds")
    if start_s >= end_s:
        raise ValueError(f"has invalid bounds {start_s:g} to {end_s:g}")

    normalized_start = min(video_duration_s, max(0.0, start_s))
    normalized_end = min(video_duration_s, max(0.0, end_s))
    if normalized_start >= normalized_end:
        return None

    return normalized_start, normalized_end


def _normalize(raw_text: str, video_duration_s: float) -> dict[str, Any]:
    appearances, valid = parse_appearances(raw_text)
    if not valid:
        raise AnalysisStageError("parsing", "Gemini returned an invalid appearance response")

    if not math.isfinite(video_duration_s) or video_duration_s <= 0:
        raise AnalysisStageError("parsing", "Video duration must be a positive finite number")

    detections: list[dict[str, Any]] = []
    for index, appearance in enumerate(appearances, start=1):
        wire_start, wire_end = _recover_wire_bounds(
            appearance.start_s,
            appearance.end_s,
            video_duration_s,
        )
        try:
            normalized_bounds = _normalize_bounds(
                wire_start,
                wire_end,
                video_duration_s,
            )
        except ValueError as error:
            raise AnalysisStageError("parsing", f"Appearance {index} {error}") from error
        if normalized_bounds is None:
            continue
        start_s, end_s = normalized_bounds
        confidence = appearance.detection_confidence
        if confidence is not None and not 0 <= confidence <= 1:
            raise AnalysisStageError(
                "parsing",
                f"Appearance {index} has confidence outside the 0 to 1 range",
            )
        detections.append(
            {
                "car_number": appearance.car_number or "",
                "start_s": start_s,
                "end_s": end_s,
                "subject": appearance.is_target_vehicle,
                "confidence": confidence,
                "notes": appearance.vehicle_description,
            }
        )
    return {"detections": detections}


def _validate_and_write(results: dict[str, Any], output_path: Path) -> None:
    try:
        from jsonschema import Draft202012Validator
    except ImportError as error:
        raise AnalysisStageError(
            "parsing",
            "jsonschema is not installed; run: python -m pip install -r pipeline/requirements.txt",
        ) from error

    try:
        schema = json.loads(RESULT_SCHEMA_PATH.read_text(encoding="utf-8"))
        Draft202012Validator(schema).validate(results)
    except OSError as error:
        raise AnalysisStageError("parsing", f"Could not read the result schema: {error}") from error
    except Exception as error:
        raise AnalysisStageError(
            "parsing", f"Detection results failed schema validation: {error}"
        ) from error

    temporary_path = output_path.with_name(f".{output_path.name}.tmp")
    try:
        temporary_path.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
        temporary_path.replace(output_path)
    except OSError as error:
        temporary_path.unlink(missing_ok=True)
        raise AnalysisStageError("parsing", f"Could not write detection results: {error}") from error


def run_post_proxy(
    proxy_path: Path,
    output_path: Path,
    duration_s: float,
    emit: Emit,
    *,
    dry_run: bool,
) -> None:
    raw_text = _run_gemini(
        proxy_path,
        output_path,
        duration_s,
        emit,
        dry_run=dry_run,
    )
    emit("parsing", "start")
    results = _normalize(raw_text, duration_s)
    _validate_and_write(results, output_path)
    emit("parsing", "complete", detectionCount=len(results["detections"]))
    emit("parsing", "done", resultsPath=os.fspath(output_path.resolve()))
