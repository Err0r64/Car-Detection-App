"""Fake analysis pipeline stub.

Stands in for the real Gemini harness during Phase 2. Emits one JSON object
per line on stdout, following the frozen progress protocol:

    {"stage": "<stage>", "event": "start"}
    {"stage": "analyzing", "event": "token", "count": <int>}

Stages run in order: proxy, upload, processing, analyzing, parsing.
Exits 0 on success. Pass --fail to simulate a mid-run crash (exit 2 with a
message on stderr), used to test the app's error dialog.

Usage: python fake_analysis.py [video_path] [--fail]
"""

import json
import sys
import time

STAGES = ["proxy", "upload", "processing", "analyzing", "parsing"]
STAGE_SECONDS = 2.0
TOKEN_INTERVAL = 0.3
TOKENS_PER_TICK = 47


def emit(obj):
    print(json.dumps(obj), flush=True)


def main():
    fail = "--fail" in sys.argv

    for stage in STAGES:
        emit({"stage": stage, "event": "start"})

        if stage == "analyzing":
            count = 0
            deadline = time.monotonic() + STAGE_SECONDS
            while time.monotonic() < deadline:
                time.sleep(TOKEN_INTERVAL)
                count += TOKENS_PER_TICK
                emit({"stage": "analyzing", "event": "token", "count": count})
        else:
            time.sleep(STAGE_SECONDS)

        if fail and stage == "processing":
            print("simulated failure during processing stage", file=sys.stderr, flush=True)
            sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
