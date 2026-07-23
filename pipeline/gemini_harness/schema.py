"""Gemini response contract and strict parser."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class RunConfig:
    model: str
    temperature: float
    fps: float
    media_resolution: str


@dataclass(frozen=True)
class Appearance:
    appearance_id: str
    start_s: float
    end_s: float
    car_number: str | None
    is_target_vehicle: bool
    vehicle_description: str
    detection_confidence: float | None
    subject_confidence: float | None


@dataclass
class RunMeta:
    input_tokens: int = 0
    output_tokens: int = 0
    latency_s: float = 0.0
    call_count: int = 0
    json_valid: bool = True
    raw_paths: list[str] = field(default_factory=list)


def _extract_json(text: str) -> Any:
    if not text:
        raise ValueError("empty response")
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    candidate = fenced.group(1) if fenced else text
    starts = [offset for offset in (candidate.find("{"), candidate.find("[")) if offset >= 0]
    if not starts:
        raise ValueError("no JSON object found")
    end = max(candidate.rfind("}"), candidate.rfind("]"))
    return json.loads(candidate[min(starts) : end + 1])


def _seconds(value: Any) -> float:
    if isinstance(value, bool):
        raise ValueError("boolean timestamp")
    if isinstance(value, (int, float)):
        result = float(value)
    else:
        text = "" if value is None else str(value).strip()
        if ":" in text:
            parts = text.split(":")
            if len(parts) != 2 or not parts[0].isdigit():
                raise ValueError(f"invalid MM:SS timestamp: {text!r}")
            seconds = float(parts[1])
            if seconds < 0 or seconds >= 60:
                raise ValueError(f"invalid MM:SS timestamp: {text!r}")
            result = int(parts[0]) * 60 + seconds
        else:
            result = float(text)
    if not math.isfinite(result) or result < 0:
        raise ValueError(f"invalid timestamp: {value!r}")
    return result


def _number(value: Any, field_name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{field_name} must be finite")
    return result


def _optional_number(value: Any, field_name: str) -> float | None:
    return None if value is None else _number(value, field_name)


def _optional_string(value: Any) -> str | None:
    if value is None:
        return None
    result = str(value).strip()
    return None if not result or result.lower() in {"null", "none", "n/a", "na"} else result


def _coerce_appearance(item: dict[str, Any], index: int) -> Appearance:
    validated_wire_format = any(
        field in item for field in ("start_s", "end_s", "is_target", "color", "notes")
    )
    if validated_wire_format:
        subject = item.get("is_target")
        if not isinstance(subject, bool):
            raise ValueError("is_target must be boolean")
        color = _optional_string(item.get("color"))
        notes = _optional_string(item.get("notes"))
        description = " - ".join(part for part in (color, notes) if part)
        return Appearance(
            appearance_id=f"a{index}",
            start_s=_seconds(item.get("start_s")),
            end_s=_seconds(item.get("end_s")),
            car_number=_optional_string(item.get("car_number")),
            is_target_vehicle=subject,
            vehicle_description=description,
            detection_confidence=None,
            subject_confidence=None,
        )

    subject = item.get("is_target_vehicle")
    if not isinstance(subject, bool):
        raise ValueError("is_target_vehicle must be boolean")
    return Appearance(
        appearance_id=str(item.get("appearance_id") or f"a{index}"),
        start_s=_seconds(item.get("start_time_seconds")),
        end_s=_seconds(item.get("end_time_seconds")),
        car_number=_optional_string(item.get("car_number")),
        is_target_vehicle=subject,
        vehicle_description=str(item.get("vehicle_description") or "").strip(),
        detection_confidence=_optional_number(
            item.get("detection_confidence"), "detection_confidence"
        ),
        subject_confidence=_optional_number(
            item.get("subject_confidence"), "subject_confidence"
        ),
    )


def parse_appearances(text: str) -> tuple[list[Appearance], bool]:
    """Parse either the instructed object or a bare appearance list."""
    try:
        data = _extract_json(text)
        raw_items = data.get("appearances") if isinstance(data, dict) else data
        if not isinstance(raw_items, list):
            return [], False
        appearances = []
        for index, item in enumerate(raw_items, start=1):
            if not isinstance(item, dict):
                return [], False
            appearances.append(_coerce_appearance(item, index))
        return appearances, True
    except (TypeError, ValueError, json.JSONDecodeError):
        return [], False
