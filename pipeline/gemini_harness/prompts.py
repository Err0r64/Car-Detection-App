"""Frozen single-pass prompt selected by the Phase 5 research spike."""

from __future__ import annotations

from .schema import SCHEMA_PROMPT_BLOCK


_TARGET_BLOCK = (
    "TARGET VEHICLE: the vehicle the camera is actively following -- the subject the "
    "shot is built around (kept centered/in focus, held in frame as others fall "
    "away). This is about which car the footage is FEATURING, not which car has a "
    "specific number.\n"
    "- If two or more cars are racing but the camera clearly follows one, that one "
    "is the target; the others are incidental participants (is_target_vehicle = "
    "false), even though they are also racing.\n"
    "- If the camera favors no single car (a symmetric battle framed equally), do "
    "not force a target -- mark all is_target_vehicle = false.\n"
    "- If the camera is fixed/static and follows no one, mark all is_target_vehicle "
    "= false.\n"
)

_SCOPE_BLOCK = (
    "SCOPE: report only vehicles actively part of the racing action -- cars racing, "
    "competing, or driving on the course. Do NOT report parked vehicles, background "
    "or support equipment (loaders, bulldozers, trucks), or spectator/paddock "
    "vehicles.\n"
)

_APPEARANCE_BLOCK = (
    "APPEARANCES:\n"
    "- Treat a single continuous on-screen presence as ONE appearance. Only split "
    "into separate appearances if a vehicle FULLY leaves the frame for more than "
    "~1 second, then returns.\n"
    "- Do not merge two different cars into one entry.\n"
)

TEMPLATE_A = (
    "You are analyzing a motorsports clip to index vehicle appearances for a video "
    "editor.\n\n"
    + _TARGET_BLOCK
    + "\n"
    + _SCOPE_BLOCK
    + "\n"
    + _APPEARANCE_BLOCK
    + "\nFor each appearance: give its entry/exit time in seconds, read its number "
    "only if clearly legible, decide whether it is the target, and describe it.\n\n"
    "Respond with ONLY a JSON object in exactly this shape (no prose, no markdown "
    "fences):\n{schema}\n"
    "Rules: timestamps are the TOTAL number of SECONDS from the start of the video "
    "content provided, as a plain number (e.g. 70 or 70.5). NEVER express time in "
    "minutes in ANY form: one minute ten seconds is 70 -- never 1:10 (colon), "
    "1.10 (minutes.seconds), or 110 (concatenated digits). {duration_line}"
    "`car_number` is the car's number ONLY if you can clearly read it, else null -- "
    "NEVER guess or invent a number; if a car shows more than one number, list them "
    "ALL in the string (e.g. \"12 / 34\"). "
    "`is_target_vehicle` is true only per the TARGET VEHICLE definition; "
    "confidences are 0.0-1.0. If no qualifying vehicles appear, return "
    "{{\"appearances\": []}}."
)


def render(duration_s: float) -> str:
    duration_line = (
        f"The video content provided is {duration_s:.0f} seconds long: every "
        f"timestamp must be a number between 0 and {duration_s:.0f}. "
    )
    return TEMPLATE_A.format(schema=SCHEMA_PROMPT_BLOCK, duration_line=duration_line)
