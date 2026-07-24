"""Pinned settings for the production single-pass Gemini call."""

from __future__ import annotations

import os
from pathlib import Path
import tempfile


MODEL = "gemini-3.6-flash"
TEMPERATURE = 0.0
SEED = 0
DEFAULT_FPS = 1.0
DEFAULT_MEDIA_RESOLUTION = "MEDIA_RESOLUTION_MEDIUM"

REQUESTS_PER_MINUTE = int(os.environ.get("HARNESS_RPM", "5"))
RATE_WINDOW_S = 60.0
RATE_MARGIN_S = 1.0
_DEFAULT_MIN_REQUEST_INTERVAL_S = (
    RATE_WINDOW_S / REQUESTS_PER_MINUTE if REQUESTS_PER_MINUTE > 0 else 0.0
)
MIN_REQUEST_INTERVAL_S = max(
    0.0,
    float(os.environ.get("GEMINI_MIN_REQUEST_INTERVAL_S", _DEFAULT_MIN_REQUEST_INTERVAL_S)),
)
MAX_REQUEST_ATTEMPTS = max(1, int(os.environ.get("GEMINI_MAX_ATTEMPTS", "5")))
RETRY_INITIAL_DELAY_S = 2.0
RETRY_MAX_DELAY_S = 60.0
RETRY_JITTER_RATIO = 0.25
RETRYABLE_STATUS_CODES = frozenset({429, 500, 502, 503, 504})
PROCESSING_TIMEOUT_S = 180.0


def api_key() -> str | None:
    """Read the one supported credential without persisting it anywhere."""
    return os.environ.get("GEMINI_API_KEY")


def rate_limit_path() -> Path:
    """Return the shared request-history path used across analysis processes."""
    configured = os.environ.get("CAPSTONE_GEMINI_RATE_STATE")
    if configured:
        return Path(configured)
    return Path(tempfile.gettempdir()) / "capstone-gemini-rate-limit.json"
