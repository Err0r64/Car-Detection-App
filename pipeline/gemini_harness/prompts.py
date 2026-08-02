"""Validated single-pass Gemini prompt derived from the research harness."""

from __future__ import annotations

import math


OUTPUT_SCHEMA = """{
  "appearances": [
    {
      "appearance_id": "string",
      "start_time_seconds": 0,
      "end_time_seconds": 0,
      "car_number": "string or null",
      "is_target_vehicle": true,
      "vehicle_description": "string",
      "detection_confidence": 0.0,
      "subject_confidence": 0.0
    }
  ]
}"""


PROMPT_TEMPLATE = """You are analyzing a motorsports clip to index vehicle appearances for a video editor.

TARGET VEHICLE: the vehicle the camera is actively following -- the subject the
shot is built around (kept centered/in focus, held in frame as others fall away).
This is about which car the footage is FEATURING, not which car has a specific number.

- If two or more cars are racing but the camera clearly follows one, that one is
the target; the others are incidental participants (is_target_vehicle = false),
even though they are also racing.
- If the camera favors no single car (a symmetric battle framed equally), do not
force a target -- mark all is_target_vehicle = false.
- If the camera is fixed/static and follows no one, mark all
is_target_vehicle = false.

SCOPE: report only vehicles actively part of the racing action -- cars racing,
competing, or driving on the course. Do NOT report parked vehicles, background or
support equipment (loaders, bulldozers, trucks), or spectator/paddock vehicles.

APPEARANCES AND VEHICLE IDENTITY -- HIGHEST PRIORITY:

- Each appearance object represents exactly ONE physical vehicle during one
continuous on-screen presence.
- Different physical vehicles ALWAYS require separate appearance objects,
regardless of whether they overlap, appear back-to-back, look alike, carry the
same number or color, or are separated by several seconds. Never use one
start/end interval to cover vehicle A and vehicle B.
- When the visible identity changes from vehicle A to vehicle B, end vehicle A's
appearance at its last visible time and begin a separate appearance for vehicle B
at its first visible time.
- For the SAME verified physical vehicle, treat continuous presence and a brief
occlusion while it remains in the scene as one appearance. If that vehicle fully
leaves the frame for more than approximately 1 second and later returns, create a
new appearance. This return rule applies only to the same physical vehicle and
must never join different cars.
- Do not extend an appearance through footage where its assigned vehicle is absent.
- Do not infer that a later car is the same physical vehicle solely from its
number, color, body type, or relationship to the camera.
- Do not create overlapping duplicate entries for different identity guesses of
the same continuously visible car. If only one car is visible, report only one
car for that time.

Example: if vehicle A is visible from 12 to 25 seconds, no participating vehicle
is visible from 25 to 40 seconds, and vehicle B is visible from 40 to 52 seconds,
return two appearance objects: A from 12 to 25 and B from 40 to 52. Never return
one appearance from 12 to 52.

For each appearance: give its entry and exit time in seconds, read its number only
if clearly legible, decide whether it is the target, and describe it.

Respond with ONLY a JSON object in exactly this shape (no prose or markdown fences):
{schema}

RULES:

- Timestamps are the TOTAL number of SECONDS from the start of the video content
provided, as a plain number (for example 70 or 70.5).
- NEVER express time in minutes in any form: one minute ten seconds is 70, never
1:10, 1.10, or 110.
- The video content provided is {duration_s} seconds long. Every timestamp must be
between 0 and {duration_s}.
- Report the car number ONLY if you can clearly read it; otherwise null. Never
guess or invent a number. If a car visibly shows more than one number, list all
clearly legible numbers in one string.
- is_target_vehicle is true only per the TARGET VEHICLE definition.
- detection_confidence and subject_confidence are numbers from 0.0 to 1.0.
- Before returning, verify that every appearance follows the same single physical
vehicle from start to end. If its start and end refer to different vehicles, or
its assigned vehicle is absent between them, split or shorten the appearance.
Duplicate time ranges are valid only for separately visible cars.
- If no participating vehicles appear, return {{"appearances": []}}."""


def render(duration_s: float) -> str:
    """Render the validated prompt with an explicit media-duration guard."""
    if not math.isfinite(duration_s) or duration_s <= 0:
        raise ValueError("duration_s must be a positive finite number")
    duration = f"{duration_s:.3f}".rstrip("0").rstrip(".")
    return PROMPT_TEMPLATE.format(schema=OUTPUT_SCHEMA, duration_s=duration)
