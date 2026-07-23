"""Minimal Gemini harness adapted from the Phase 5 research spike."""

from .client import GeminiClient
from .schema import Appearance, RunConfig, RunMeta, parse_appearances

__all__ = [
    "Appearance",
    "GeminiClient",
    "RunConfig",
    "RunMeta",
    "parse_appearances",
]
