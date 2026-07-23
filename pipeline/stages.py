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


def _round_seconds(value: float) -> int:
    return math.floor(value + 0.5)


def _normalize(raw_text: str, video_duration_s: float) -> dict[str, Any]:
    appearances, valid = parse_appearances(raw_text)
    if not valid:
        raise AnalysisStageError("parsing", "Gemini returned an invalid appearance response")

    duration_limit = math.floor(video_duration_s)
    if duration_limit < 1 and appearances:
        raise AnalysisStageError("parsing", "Video is too short for integer-second detections")

    detections: list[dict[str, Any]] = []
    for index, appearance in enumerate(appearances, start=1):
        start_s = min(duration_limit, max(0, _round_seconds(appearance.start_s)))
        end_s = min(duration_limit, max(0, _round_seconds(appearance.end_s)))
        confidence = appearance.detection_confidence
        if not 0 <= confidence <= 1:
            raise AnalysisStageError(
                "parsing",
                f"Appearance {index} has confidence outside the 0 to 1 range",
            )
        if start_s >= end_s:
            raise AnalysisStageError(
                "parsing",
                f"Appearance {index} has invalid normalized bounds {start_s} to {end_s}",
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
