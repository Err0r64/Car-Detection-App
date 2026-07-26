"""Fake analysis pipeline stub.

Stands in for the real Gemini harness during Phase 2. Emits one JSON object
per line on stdout, following the frozen progress protocol:

    {"stage": "<stage>", "event": "start"}
    {"stage": "analyzing", "event": "token", "count": <int>}
    {"stage": "parsing", "event": "done", "resultsPath": "<path>"}

Stages run in order: proxy, upload, processing, analyzing, parsing.
Exits 0 on success. Pass --fail to simulate a mid-run crash (exit 2 with a
message on stderr), or --malformed to emit an invalid JSONL protocol line.

Usage: python fake_analysis.py [video_path] [--out results.json] [--fail] [--malformed]
"""

import argparse
import json
from pathlib import Path
import sys
import time

STAGES = ["proxy", "upload", "processing", "analyzing", "parsing"]
STAGE_SECONDS = 2.0
TOKEN_INTERVAL = 0.3
TOKENS_PER_TICK = 47


def emit(obj):
    print(json.dumps(obj), flush=True)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("video_path", nargs="?")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--fail", action="store_true")
    parser.add_argument("--malformed", action="store_true")
    return parser.parse_args()


def write_results(output_path):
    if output_path is None:
        return None
    output_path = output_path.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(
            {
                "detections": [
                    {
                        "car_number": "0",
                        "start_s": 0.25,
                        "end_s": 1.75,
                        "subject": True,
                        "confidence": 0.9,
                        "notes": "Offline stub vehicle",
                    }
                ]
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return output_path


def main():
    args = parse_args()

    for stage in STAGES:
        emit({"stage": stage, "event": "start"})

        if args.malformed and stage == "processing":
            print("not-json", flush=True)

        if stage == "analyzing":
            count = 0
            deadline = time.monotonic() + STAGE_SECONDS
            while time.monotonic() < deadline:
                time.sleep(TOKEN_INTERVAL)
                count += TOKENS_PER_TICK
                emit({"stage": "analyzing", "event": "token", "count": count})
        else:
            time.sleep(STAGE_SECONDS)

        if args.fail and stage == "processing":
            print("simulated failure during processing stage", file=sys.stderr, flush=True)
            sys.exit(2)

    results_path = write_results(args.out)
    if results_path is not None:
        emit({"stage": "parsing", "event": "done", "resultsPath": str(results_path)})

    sys.exit(0)


if __name__ == "__main__":
    main()
