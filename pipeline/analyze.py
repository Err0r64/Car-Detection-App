"""Standalone vehicle-analysis pipeline entry point.

Phase 5 CP1 implements and verifies the CFR proxy stage. Later checkpoints
continue from the verified proxy into upload, analysis, and result parsing.
Stdout is reserved exclusively for the JSONL progress protocol.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from fractions import Fraction
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
from typing import Any

from stages import AnalysisStageError, run_post_proxy


PROXY_CRF = 21
PROXY_FPS = 2.0
MAX_PROXY_HEIGHT = 1080
MAX_DURATION_DELTA_S = 0.5
PROXY_CACHE_VERSION = 2
HARDWARE_PROXY_QUALITY = 21

_active_process: subprocess.Popen[str] | None = None
_termination_requested = False


class PipelineError(RuntimeError):
    """A user-facing pipeline failure associated with a protocol stage."""

    def __init__(self, stage: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage
        self.message = message


@dataclass(frozen=True)
class ProxyEncoder:
    name: str
    arguments: tuple[str, ...]
    hardware: bool = False


SOFTWARE_ENCODER = ProxyEncoder(
    "libx264",
    ("-c:v", "libx264", "-preset", "veryfast", "-crf", str(PROXY_CRF)),
)
HARDWARE_ENCODERS = (
    ProxyEncoder(
        "h264_nvenc",
        (
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p4",
            "-tune",
            "hq",
            "-rc",
            "vbr",
            "-cq",
            str(HARDWARE_PROXY_QUALITY),
            "-b:v",
            "0",
        ),
        True,
    ),
    ProxyEncoder(
        "h264_qsv",
        (
            "-c:v",
            "h264_qsv",
            "-preset",
            "veryfast",
            "-global_quality",
            str(HARDWARE_PROXY_QUALITY),
        ),
        True,
    ),
    ProxyEncoder(
        "h264_amf",
        (
            "-c:v",
            "h264_amf",
            "-quality",
            "speed",
            "-rc",
            "cqp",
            "-qp_i",
            str(HARDWARE_PROXY_QUALITY),
            "-qp_p",
            str(HARDWARE_PROXY_QUALITY),
            "-qp_b",
            str(HARDWARE_PROXY_QUALITY),
        ),
        True,
    ),
)


def emit(stage: str, event: str, **payload: Any) -> None:
    """Write one compact protocol object and flush it immediately."""
    message = {"stage": stage, "event": event, **payload}
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def diagnostic(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


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


def _parse_frame_rate(value: object) -> float | None:
    if not isinstance(value, str) or not value or value == "0/0":
        return None
    try:
        rate = float(Fraction(value))
    except (ValueError, ZeroDivisionError):
        return None
    return rate if math.isfinite(rate) and rate > 0 else None


def probe_frame_rate(
    ffprobe_path: str,
    media_path: Path,
    expected_fps: float | None = None,
) -> float:
    probe = run_probe(
        ffprobe_path,
        media_path,
        "-show_entries",
        "stream=avg_frame_rate,r_frame_rate",
    )
    streams = probe.get("streams", [])
    stream = streams[0] if streams else {}
    measured_fps = (
        _parse_frame_rate(stream.get("avg_frame_rate"))
        or _parse_frame_rate(stream.get("r_frame_rate"))
    )
    if measured_fps is None:
        raise PipelineError("proxy", f"Could not determine frame cadence for {media_path.name}")
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


def _encoder_is_available(ffmpeg_path: str, encoder: ProxyEncoder) -> bool:
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:r=1:d=0.1",
        "-frames:v",
        "1",
        "-pix_fmt",
        "yuv420p",
        *encoder.arguments,
        "-f",
        "null",
        os.devnull,
    ]
    try:
        completed = subprocess.run(
            command,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=8,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0


def select_proxy_encoder(ffmpeg_path: str) -> ProxyEncoder:
    for encoder in HARDWARE_ENCODERS:
        if _encoder_is_available(ffmpeg_path, encoder):
            return encoder
    return SOFTWARE_ENCODER


def proxy_cache_path(source_path: Path, cache_directory: Path) -> Path:
    source_stat = source_path.stat()
    identity = json.dumps(
        {
            "version": PROXY_CACHE_VERSION,
            "source": os.fspath(source_path.resolve()),
            "size": source_stat.st_size,
            "modifiedNs": source_stat.st_mtime_ns,
            "fps": PROXY_FPS,
            "height": MAX_PROXY_HEIGHT,
            "crf": PROXY_CRF,
            "hardwareQuality": HARDWARE_PROXY_QUALITY,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
    return cache_directory / f"{source_path.stem}.{digest}.proxy.mp4"


def _proxy_result(
    proxy_path: Path,
    source_duration_s: float,
    source_fps: float,
    proxy_duration_s: float,
    proxy_fps: float,
    encoder_name: str,
    *,
    cached: bool,
) -> dict[str, Any]:
    duration_delta_s = abs(proxy_duration_s - source_duration_s)
    if duration_delta_s > MAX_DURATION_DELTA_S:
        raise PipelineError(
            "proxy",
            (
                f"Proxy duration differs from the original by {duration_delta_s:.3f}s "
                f"(maximum {MAX_DURATION_DELTA_S:.3f}s)"
            ),
        )
    return {
        "proxyPath": os.fspath(proxy_path.resolve()),
        "proxyCached": cached,
        "proxyEncoder": encoder_name,
        "sourceDurationS": round(source_duration_s, 6),
        "proxyDurationS": round(proxy_duration_s, 6),
        "durationDeltaS": round(duration_delta_s, 6),
        "sourceFps": round(source_fps, 6),
        "proxyFps": round(proxy_fps, 6),
    }


def _validate_proxy(
    ffprobe_path: str,
    proxy_path: Path,
    source_duration_s: float,
    source_fps: float,
    encoder_name: str,
    *,
    cached: bool,
) -> dict[str, Any]:
    proxy_duration_s = probe_duration(ffprobe_path, proxy_path)
    proxy_fps = probe_frame_rate(ffprobe_path, proxy_path, PROXY_FPS)
    return _proxy_result(
        proxy_path,
        source_duration_s,
        source_fps,
        proxy_duration_s,
        proxy_fps,
        encoder_name,
        cached=cached,
    )


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
    encoder: ProxyEncoder = SOFTWARE_ENCODER,
) -> None:
    global _active_process

    scale_filter = f"fps={PROXY_FPS:g},scale=-2:min({MAX_PROXY_HEIGHT}\\,ih)"
    hardware_input_arguments = ("-hwaccel", "auto") if encoder.hardware else ()
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        *hardware_input_arguments,
        "-i",
        os.fspath(source_path),
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        scale_filter,
        *encoder.arguments,
        "-pix_fmt",
        "yuv420p",
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
    *,
    reuse_existing: bool = False,
) -> dict[str, Any]:
    emit("proxy", "start")
    source_duration_s = probe_duration(ffprobe_path, source_path)
    source_fps = probe_frame_rate(ffprobe_path, source_path)
    proxy_path.parent.mkdir(parents=True, exist_ok=True)

    if reuse_existing and proxy_path.is_file():
        try:
            result = _validate_proxy(
                ffprobe_path,
                proxy_path,
                source_duration_s,
                source_fps,
                "cache",
                cached=True,
            )
            emit("proxy", "complete", progress=1.0, **result)
            return result
        except PipelineError:
            proxy_path.unlink(missing_ok=True)

    partial_path = proxy_path.with_name(
        f".{proxy_path.stem}.{os.getpid()}.partial.mp4"
    )
    partial_path.unlink(missing_ok=True)
    encoder = select_proxy_encoder(ffmpeg_path)
    try:
        try:
            create_proxy(
                ffmpeg_path,
                source_path,
                partial_path,
                source_duration_s,
                encoder,
            )
        except PipelineError:
            partial_path.unlink(missing_ok=True)
            if not encoder.hardware or _termination_requested:
                raise
            encoder = SOFTWARE_ENCODER
            create_proxy(
                ffmpeg_path,
                source_path,
                partial_path,
                source_duration_s,
                encoder,
            )

        result = _validate_proxy(
            ffprobe_path,
            partial_path,
            source_duration_s,
            source_fps,
            encoder.name,
            cached=False,
        )
        partial_path.replace(proxy_path)
        result["proxyPath"] = os.fspath(proxy_path.resolve())
    finally:
        partial_path.unlink(missing_ok=True)

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
        "--proxy-cache-dir",
        type=Path,
        help="optional directory for source-keyed reusable proxies",
    )
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
        cache_directory = (
            args.proxy_cache_dir.expanduser().resolve()
            if args.proxy_cache_dir is not None
            else None
        )
        if cache_directory is not None:
            try:
                cache_directory.mkdir(parents=True, exist_ok=True)
            except OSError:
                cache_directory = None
        proxy_path = (
            proxy_cache_path(source_path, cache_directory)
            if cache_directory is not None
            else output_path.with_name(f"{output_path.stem}.proxy.mp4")
        )
        proxy_result = proxy_stage(
            source_path,
            proxy_path,
            args.ffmpeg_path,
            args.ffprobe_path,
            reuse_existing=cache_directory is not None,
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
        diagnostic(f"{error.stage}: {error.message}")
        emit(error.stage, "error", message=error.message)
        return 1
    except OSError as error:
        message = f"Could not prepare proxy output: {error}"
        diagnostic(f"proxy: {message}")
        emit("proxy", "error", message=message)
        return 1
    except KeyboardInterrupt:
        diagnostic("proxy: Proxy generation was canceled")
        emit("proxy", "error", message="Proxy generation was canceled")
        return 130


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, handle_termination)
    raise SystemExit(main())
