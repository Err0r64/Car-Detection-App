from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest


PIPELINE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PIPELINE_DIR))

from gemini_harness.prompts import render as render_prompt  # noqa: E402
from gemini_harness.schema import parse_appearances  # noqa: E402
from stages import AnalysisStageError, _normalize, _validate_and_write  # noqa: E402


def response(**overrides: object) -> str:
    appearance = {
        "appearance_id": "a1",
        "start_time_seconds": "1:02",
        "end_time_seconds": 65.6,
        "car_number": None,
        "is_target_vehicle": False,
        "vehicle_description": "blue coupe",
        "detection_confidence": 0.75,
        "subject_confidence": 0.4,
    }
    appearance.update(overrides)
    return json.dumps({"appearances": [appearance]})


def validated_response(**overrides: object) -> str:
    appearance = {
        "start_s": 12,
        "end_s": 24,
        "is_target": True,
        "car_number": None,
        "color": "Blue",
        "notes": "Camera follows through the corner",
    }
    appearance.update(overrides)
    return json.dumps([appearance])


class Cp2ParsingTests(unittest.TestCase):
    def test_validated_prompt_is_not_augmented_by_video_duration(self) -> None:
        prompt = render_prompt(114.933)
        self.assertEqual(prompt, render_prompt(15.0))
        self.assertIn("Return ONLY a JSON array, no other text.", prompt)
        self.assertIn('"is_target": <true if this is the camera-followed subject', prompt)
        self.assertNotIn("appearance_id", prompt)
        self.assertNotIn("detection_confidence", prompt)
        self.assertNotIn("video content provided is", prompt)

    def test_validated_array_maps_to_application_fields(self) -> None:
        results = _normalize(validated_response(), 90.0)
        detection = results["detections"][0]
        self.assertEqual(detection["start_s"], 12)
        self.assertEqual(detection["end_s"], 24)
        self.assertTrue(detection["subject"])
        self.assertEqual(detection["car_number"], "")
        self.assertEqual(detection["notes"], "Blue - Camera follows through the corner")
        self.assertIsNone(detection["confidence"])

    def test_validated_target_boolean_is_strict(self) -> None:
        appearances, valid = parse_appearances(validated_response(is_target="true"))
        self.assertFalse(valid)
        self.assertEqual(appearances, [])

    def test_mmss_and_decimal_seconds_are_preserved_as_numeric_seconds(self) -> None:
        results = _normalize(response(), 90.0)
        self.assertEqual(results["detections"][0]["start_s"], 62)
        self.assertEqual(results["detections"][0]["end_s"], 65.6)

    def test_invalid_boolean_is_not_coerced(self) -> None:
        appearances, valid = parse_appearances(response(is_target_vehicle="false"))
        self.assertFalse(valid)
        self.assertEqual(appearances, [])

    def test_subsecond_interval_is_preserved(self) -> None:
        results = _normalize(
            response(start_time_seconds=2.1, end_time_seconds=2.2),
            10.0,
        )
        self.assertEqual(results["detections"][0]["start_s"], 2.1)
        self.assertEqual(results["detections"][0]["end_s"], 2.2)

    def test_interval_crossing_clip_end_clamps_to_exact_duration(self) -> None:
        results = _normalize(
            validated_response(start_s=27.5, end_s=30.0),
            28.97,
        )
        detection = results["detections"][0]
        self.assertEqual(detection["start_s"], 27.5)
        self.assertEqual(detection["end_s"], 28.97)

    def test_interval_starting_after_clip_end_is_removed(self) -> None:
        results = _normalize(
            validated_response(start_s=30.0, end_s=31.0),
            28.97,
        )
        self.assertEqual(results["detections"], [])

    def test_original_zero_length_interval_still_fails(self) -> None:
        with self.assertRaisesRegex(AnalysisStageError, "invalid bounds 4 to 4"):
            _normalize(validated_response(start_s=4.0, end_s=4.0), 10.0)

    def test_concatenated_mmss_pair_is_recovered_when_both_bounds_exceed_duration(self) -> None:
        results = _normalize(
            response(start_time_seconds=115, end_time_seconds=137),
            114.933,
        )
        self.assertEqual(results["detections"][0]["start_s"], 75)
        self.assertEqual(results["detections"][0]["end_s"], 97)

    def test_unrecoverable_out_of_range_pair_is_removed_after_clamping(self) -> None:
        results = _normalize(
            response(start_time_seconds=160, end_time_seconds=170),
            114.933,
        )
        self.assertEqual(results["detections"], [])

    def test_written_results_validate_against_project_schema(self) -> None:
        results = _normalize(response(), 90.0)
        output = Path(__file__).with_name(".cp2-results.json")
        try:
            _validate_and_write(results, output)
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), results)
        finally:
            output.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
