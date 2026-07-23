from __future__ import annotations

import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


PIPELINE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PIPELINE_DIR))

from analyze import PROXY_CRF, create_proxy  # noqa: E402
from gemini_harness import config as gemini_config  # noqa: E402
from gemini_harness.client import GeminiClient  # noqa: E402
from gemini_harness.prompts import render as render_prompt  # noqa: E402
from gemini_harness.schema import RunConfig, parse_appearances  # noqa: E402
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
    def test_validated_prompt_includes_duration_and_identity_guards(self) -> None:
        prompt = render_prompt(114.933)
        self.assertNotEqual(prompt, render_prompt(15.0))
        self.assertIn('"appearances"', prompt)
        self.assertIn('"appearance_id"', prompt)
        self.assertIn('"detection_confidence"', prompt)
        self.assertIn("The video content provided is 114.933 seconds long", prompt)
        self.assertIn("one minute ten seconds is 70", prompt)
        self.assertIn("Do not extend an appearance through footage", prompt)
        self.assertIn("Do not create overlapping duplicate entries", prompt)

    def test_client_uses_blocking_seeded_json_request(self) -> None:
        raw_response = response(
            start_time_seconds=12.5,
            end_time_seconds=70.5,
            car_number="62",
        )

        class FakeModels:
            def __init__(self) -> None:
                self.call: dict[str, object] | None = None

            def generate_content(self, **kwargs: object) -> object:
                self.call = kwargs
                usage = type(
                    "Usage",
                    (),
                    {"prompt_token_count": 120, "candidates_token_count": 45},
                )()
                return type("Response", (), {"text": raw_response, "usage_metadata": usage})()

        fake_models = FakeModels()
        fake_api = type("FakeApi", (), {"models": fake_models})()
        uploaded = type(
            "Uploaded",
            (),
            {"uri": "files/test", "mime_type": "video/mp4"},
        )()
        events: list[tuple[str, dict[str, object]]] = []
        directory = Path(__file__).with_name(".cp2-client-raw")
        raw_path = directory / "seeded-request.txt"

        try:
            client = GeminiClient(
                directory,
                dry_run=True,
                observer=lambda event, payload: events.append((event, payload)),
            )
            client.dry_run = False
            client._client = fake_api
            text, meta = client.analyze(
                uploaded,
                render_prompt(114.933),
                RunConfig(
                    model=gemini_config.MODEL,
                    temperature=gemini_config.TEMPERATURE,
                    fps=gemini_config.DEFAULT_FPS,
                    media_resolution=gemini_config.DEFAULT_MEDIA_RESOLUTION,
                ),
                "seeded-request",
            )

            self.assertEqual(text, raw_response)
            self.assertEqual(meta.input_tokens, 120)
            self.assertEqual(meta.output_tokens, 45)
            self.assertEqual(len(meta.raw_paths), 1)
            self.assertEqual(raw_path.read_text(encoding="utf-8"), raw_response)
        finally:
            raw_path.unlink(missing_ok=True)
            if directory.exists():
                directory.rmdir()

        self.assertIsNotNone(fake_models.call)
        request_config = fake_models.call["config"]
        self.assertEqual(request_config.seed, gemini_config.SEED)
        self.assertEqual(request_config.response_mime_type, "application/json")
        self.assertEqual(request_config.response_json_schema["required"], ["appearances"])
        self.assertEqual(events[-1], ("tokens", {"inputTokens": 120, "outputTokens": 45}))

    def test_proxy_preserves_source_cadence_at_research_quality(self) -> None:
        process = type(
            "Process",
            (),
            {
                "stdout": [],
                "stderr": io.StringIO(""),
                "wait": lambda self: 0,
            },
        )()
        with patch("analyze.subprocess.Popen", return_value=process) as popen:
            create_proxy(
                "ffmpeg",
                Path("source.mov"),
                Path("proxy.mp4"),
                114.933,
                23.976024,
            )

        command = popen.call_args.args[0]
        self.assertEqual(command[command.index("-crf") + 1], str(PROXY_CRF))
        self.assertEqual(command[command.index("-r") + 1], "23.976024")
        self.assertEqual(command[command.index("-fps_mode") + 1], "cfr")

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
