"""Standalone vehicle-analysis pipeline entry point.

Phase 5 CP1 implements and verifies the CFR proxy stage. Later checkpoints
continue from the verified proxy into upload, analysis, and result parsing.
Stdout is reserved exclusively for the JSONL progress protocol.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import signal
import statistics
import subprocess
import sys
from typing import Any

from stages import AnalysisStageError, run_post_proxy


PROXY_CRF = 23
MAX_PROXY_HEIGHT = 720
MAX_DURATION_DELTA_S = 0.5
CADENCE_RELATIVE_TOLERANCE = 0.02
CADENCE_ABSOLUTE_TOLERANCE_S = 0.0005
MAX_CADENCE_OUTLIER_RATIO = 0.005

_active_process: subprocess.Popen[str] | None = None
_termination_requested = False


class PipelineError(RuntimeError):
    """A user-facing pipeline failure associated with a protocol stage."""

    def __init__(self, stage: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage
        self.message = message


def emit(stage: str, event: str, **payload: Any) -> None:
    """Write one compact protocol object and flush it immediately."""
    message = {"stage": stage, "event": event, **payload}
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def diagnostic(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def remove_partial_proxy(proxy_path: Path) -> None:
    try:
        proxy_path.unlink(missing_ok=True)
    except OSError as error:
        diagnostic(f"proxy: Could not remove partial proxy {proxy_path}: {error}")


def run_probe(ffprobe_path: str, media_path: Path, *arguments: str) -> dict[str, Any]:
    command = [
        ffprobe_path,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        *arguments,
        "-of",
        "json",
        os.fspath(media_path),
    ]
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as error:
        raise PipelineError("proxy", f"Could not run ffprobe: {error}") from error

    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()
        suffix = f": {detail[-1]}" if detail else ""
        raise PipelineError("proxy", f"ffprobe could not inspect {media_path.name}{suffix}")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise PipelineError("proxy", "ffprobe returned invalid JSON") from error


def probe_duration(ffprobe_path: str, media_path: Path) -> float:
    probe = run_probe(ffprobe_path, media_path, "-show_entries", "format=duration")
    try:
        duration = float(probe["format"]["duration"])
    except (KeyError, TypeError, ValueError) as error:
        raise PipelineError("proxy", f"Could not determine duration for {media_path.name}") from error
    if not math.isfinite(duration) or duration <= 0:
        raise PipelineError("proxy", f"Invalid duration reported for {media_path.name}")
    return duration


def probe_frame_timestamps(ffprobe_path: str, media_path: Path) -> list[float]:
    probe = run_probe(
        ffprobe_path,
        media_path,
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp_time",
    )
    timestamps: list[float] = []
    for frame in probe.get("frames", []):
        try:
            timestamp = float(frame["best_effort_timestamp_time"])
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(timestamp):
            timestamps.append(timestamp)
    if len(timestamps) < 2:
        raise PipelineError("proxy", f"Not enough video frames found in {media_path.name}")
    return timestamps


def verify_constant_frame_rate(
    ffprobe_path: str,
    media_path: Path,
    expected_fps: float | None = None,
) -> float:
    timestamps = probe_frame_timestamps(ffprobe_path, media_path)
    deltas = [
        current - previous
        for previous, current in zip(timestamps, timestamps[1:])
        if current > previous
    ]
    if not deltas:
        raise PipelineError("proxy", f"Could not determine frame cadence for {media_path.name}")

    median_delta = statistics.median(deltas)
    tolerance = max(
        CADENCE_ABSOLUTE_TOLERANCE_S,
        median_delta * CADENCE_RELATIVE_TOLERANCE,
    )
    outliers = sum(abs(delta - median_delta) > tolerance for delta in deltas)
    outlier_ratio = outliers / len(deltas)
    if outlier_ratio > MAX_CADENCE_OUTLIER_RATIO:
        raise PipelineError(
            "proxy",
            (
                f"Variable frame rate detected in {media_path.name} "
                f"({outlier_ratio:.1%} cadence outliers)"
            ),
        )

    measured_fps = 1.0 / median_delta
    if expected_fps is not None and not math.isclose(
        measured_fps,
        expected_fps,
        rel_tol=0.01,
        abs_tol=0.05,
    ):
        raise PipelineError(
            "proxy",
            (
                f"Proxy frame rate is {measured_fps:.3f} FPS; "
                f"expected {expected_fps:.3f} FPS"
            ),
        )
    return measured_fps


def parse_progress_time_us(progress: dict[str, str]) -> int | None:
    for key in ("out_time_us", "out_time_ms"):
        raw_value = progress.get(key)
        if raw_value is None:
            continue
        try:
            return int(raw_value)
        except ValueError:
            continue
    return None


def create_proxy(
    ffmpeg_path: str,
    source_path: Path,
    proxy_path: Path,
    source_duration_s: float,
    source_fps: float,
) -> None:
    global _active_process

    scale_filter = (
        f"scale=-2:min({MAX_PROXY_HEIGHT}\\,ih)"
    )
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        os.fspath(source_path),
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        scale_filter,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        str(PROXY_CRF),
        "-pix_fmt",
        "yuv420p",
        "-r",
        f"{source_fps:.6f}",
        "-fps_mode",
        "cfr",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-nostats",
        os.fspath(proxy_path),
    ]
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except OSError as error:
        raise PipelineError("proxy", f"Could not run ffmpeg: {error}") from error

    _active_process = process
    progress: dict[str, str] = {}
    last_percent = -1
    assert process.stdout is not None
    for raw_line in process.stdout:
        line = raw_line.strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        progress[key] = value
        if key != "progress":
            continue

        elapsed_us = parse_progress_time_us(progress)
        if elapsed_us is not None:
            fraction = min(1.0, max(0.0, elapsed_us / 1_000_000 / source_duration_s))
            percent = math.floor(fraction * 100)
            if percent > last_percent:
                emit("proxy", "progress", progress=round(fraction, 4))
                last_percent = percent
        progress.clear()

    stderr = process.stderr.read() if process.stderr is not None else ""
    return_code = process.wait()
    _active_process = None
    if _termination_requested:
        raise PipelineError("proxy", "Proxy generation was canceled")
    if return_code != 0:
        detail = stderr.strip().splitlines()
        suffix = f": {detail[-1]}" if detail else ""
        raise PipelineError("proxy", f"ffmpeg proxy generation failed{suffix}")


def proxy_stage(
    source_path: Path,
    proxy_path: Path,
    ffmpeg_path: str,
    ffprobe_path: str,
) -> dict[str, Any]:
    emit("proxy", "start")
    source_duration_s = probe_duration(ffprobe_path, source_path)
    source_fps = verify_constant_frame_rate(ffprobe_path, source_path)
    create_proxy(
        ffmpeg_path,
        source_path,
        proxy_path,
        source_duration_s,
        source_fps,
    )

    proxy_duration_s = probe_duration(ffprobe_path, proxy_path)
    proxy_fps = verify_constant_frame_rate(ffprobe_path, proxy_path, source_fps)
    duration_delta_s = abs(proxy_duration_s - source_duration_s)
    if duration_delta_s > MAX_DURATION_DELTA_S:
        raise PipelineError(
            "proxy",
            (
                f"Proxy duration differs from the original by {duration_delta_s:.3f}s "
                f"(maximum {MAX_DURATION_DELTA_S:.3f}s)"
            ),
        )

    result = {
        "proxyPath": os.fspath(proxy_path.resolve()),
        "sourceDurationS": round(source_duration_s, 6),
        "proxyDurationS": round(proxy_duration_s, 6),
        "durationDeltaS": round(duration_delta_s, 6),
        "sourceFps": round(source_fps, 6),
        "proxyFps": round(proxy_fps, 6),
    }
    emit("proxy", "complete", progress=1.0, **result)
    return result


def handle_termination(signum: int, _frame: Any) -> None:
    global _termination_requested
    _termination_requested = True
    process = _active_process
    if process is not None and process.poll() is None:
        process.terminate()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze a video for vehicle appearances")
    parser.add_argument("--video", required=True, type=Path, help="source video path")
    parser.add_argument("--out", required=True, type=Path, help="results JSON path")
    parser.add_argument("--ffmpeg-path", default="ffmpeg", help="ffmpeg executable")
    parser.add_argument("--ffprobe-path", default="ffprobe", help="ffprobe executable")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="exercise every stage with a canned Gemini response and no API request",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    source_path = args.video.expanduser().resolve()
    output_path = args.out.expanduser().resolve()
    proxy_path = output_path.with_name(f"{output_path.stem}.proxy.mp4")

    if not source_path.is_file():
        emit("proxy", "error", message=f"Video file not found: {source_path}")
        return 1
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        proxy_path.unlink(missing_ok=True)
        proxy_result = proxy_stage(
            source_path,
            proxy_path,
            args.ffmpeg_path,
            args.ffprobe_path,
        )
        run_post_proxy(
            proxy_path,
            output_path,
            proxy_result["sourceDurationS"],
            emit,
            dry_run=args.dry_run,
        )
        return 0
    except AnalysisStageError as error:
        diagnostic(f"{error.stage}: {error.message}")
        emit(error.stage, "error", message=error.message)
        return 1
    except PipelineError as error:
        remove_partial_proxy(proxy_path)
        diagnostic(f"{error.stage}: {error.message}")
        emit(error.stage, "error", message=error.message)
        return 1
    except OSError as error:
        remove_partial_proxy(proxy_path)
        message = f"Could not prepare proxy output: {error}"
        diagnostic(f"proxy: {message}")
        emit("proxy", "error", message=message)
        return 1
    except KeyboardInterrupt:
        remove_partial_proxy(proxy_path)
        diagnostic("proxy: Proxy generation was canceled")
        emit("proxy", "error", message="Proxy generation was canceled")
        return 130


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, handle_termination)
    raise SystemExit(main())
