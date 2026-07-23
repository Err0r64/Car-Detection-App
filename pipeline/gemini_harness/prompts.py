"""Validated single-pass Gemini prompt."""

from __future__ import annotations


VALIDATED_PROMPT = """You are analyzing a motorsports clip to index vehicle appearances for a video editor.

TARGET VEHICLE: the vehicle the camera is actively following — the subject the
shot is built around (kept centered/in focus, held in frame as others fall away).
This is about which car the footage is FEATURING, not which car has a specific number.

- If two or more cars are racing but the camera clearly follows one, that one is
the target; the others are incidental participants (is_target = false), even
though they are also racing.
- If the camera favors no single car (a symmetric battle framed equally), do not
force a target — mark all is_target = false.
- If the camera is fixed/static and follows no one, mark all is_target = false.

SCOPE: report only vehicles actively part of the racing action — cars racing,
competing, or driving on the course. Do NOT report parked vehicles, background or
support equipment (loaders, bulldozers, trucks), or spectator/paddock vehicles.

APPEARANCES:

- Treat a single continuous on-screen presence as ONE appearance. Only split into
separate appearances if a vehicle FULLY leaves the frame for more than ~1 second,
then returns.
- Do not merge two different cars into one entry.

Return ONLY a JSON array, no other text. Each element:
{
"start_s": <seconds it enters frame>,
"end_s": <seconds it leaves frame>,
"is_target": <true if this is the camera-followed subject, else false>,
"car_number": "<number if clearly legible, else null>",
"color": "<body color>",
"notes": "<brief description>"
}

RULES:

- Report the car number ONLY if you can clearly read it; otherwise null. Never
guess or invent a number. If a car shows more than one number, list all of them.
- Timestamps are seconds from the start of the video.
- If no participating vehicles appear, return []."""


def render(duration_s: float) -> str:
    """Return the validated prompt unchanged for every video duration."""
    _ = duration_s
    return VALIDATED_PROMPT
