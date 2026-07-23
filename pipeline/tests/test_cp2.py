from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest


PIPELINE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PIPELINE_DIR))

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


class Cp2ParsingTests(unittest.TestCase):
    def test_mmss_and_decimal_seconds_normalize_to_integers(self) -> None:
        results = _normalize(response(), 90.0)
        self.assertEqual(results["detections"][0]["start_s"], 62)
        self.assertEqual(results["detections"][0]["end_s"], 66)

    def test_invalid_boolean_is_not_coerced(self) -> None:
        appearances, valid = parse_appearances(response(is_target_vehicle="false"))
        self.assertFalse(valid)
        self.assertEqual(appearances, [])

    def test_collapsed_integer_bounds_fail(self) -> None:
        with self.assertRaises(AnalysisStageError):
            _normalize(response(start_time_seconds=2.1, end_time_seconds=2.2), 10.0)

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
