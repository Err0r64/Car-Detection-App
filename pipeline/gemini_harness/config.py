"""Pinned settings for the production single-pass Gemini call."""

from __future__ import annotations

import os


MODEL = "gemini-3.6-flash"
TEMPERATURE = 0.0
SEED = 0
DEFAULT_FPS = 1.0
DEFAULT_MEDIA_RESOLUTION = "MEDIA_RESOLUTION_MEDIUM"

REQUESTS_PER_MINUTE = int(os.environ.get("HARNESS_RPM", "5"))
RATE_WINDOW_S = 60.0
RATE_MARGIN_S = 1.0
MAX_RETRIES_429 = 6
PROCESSING_TIMEOUT_S = 180.0


def api_key() -> str | None:
    """Read the one supported credential without persisting it anywhere."""
    return os.environ.get("GEMINI_API_KEY")
