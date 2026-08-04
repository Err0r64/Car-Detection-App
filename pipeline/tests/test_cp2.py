from __future__ import annotations

import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


PIPELINE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PIPELINE_DIR))

from analyze import (  # noqa: E402
    HARDWARE_ENCODERS,
    HARDWARE_PROXY_QUALITY,
    MAX_PROXY_HEIGHT,
    PROXY_CRF,
    PROXY_FPS,
    PipelineError,
    create_proxy,
    load_prompt_selection,
    probe_frame_rate,
    proxy_cache_path,
    proxy_stage,
    select_proxy_encoder,
)
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
        self.assertIn("Each appearance object represents exactly ONE physical vehicle", prompt)
        self.assertIn("Different physical vehicles ALWAYS require separate", prompt)
        self.assertIn("This return rule applies only to the same physical vehicle", prompt)
        self.assertIn("Never return\none appearance from 12 to 52", prompt)
        self.assertIn("Do not extend an appearance through footage", prompt)
        self.assertIn("Do not create overlapping duplicate entries", prompt)

    def test_remote_domain_instructions_keep_the_local_response_contract(self) -> None:
        instructions = "REMOTE DOMAIN: report one entry per physical race vehicle."
        prompt = render_prompt(114.933, instructions)

        self.assertTrue(prompt.startswith(instructions))
        self.assertIn('"appearance_id"', prompt)
        self.assertIn("The video content provided is 114.933 seconds long", prompt)
        self.assertIn("one minute ten seconds is 70", prompt)
        self.assertNotIn("TARGET VEHICLE:", prompt)

    def test_loads_a_valid_desktop_prompt_profile(self) -> None:
        payload = {
            "schemaVersion": 1,
            "profile": {
                "profileId": "motorsports-default",
                "version": 2,
                "instructions": "Report every physical vehicle separately.",
            },
        }
        profile_path = Path(__file__).with_name(".cp2-valid-prompt-profile.json")
        try:
            profile_path.write_text(json.dumps(payload), encoding="utf-8")
            selection = load_prompt_selection(profile_path, "remote")
        finally:
            profile_path.unlink(missing_ok=True)

        self.assertEqual(selection.source, "remote")
        self.assertEqual(selection.profile_id, "motorsports-default")
        self.assertEqual(selection.version, 2)
        self.assertEqual(
            selection.instructions,
            "Report every physical vehicle separately.",
        )

    def test_rejects_an_invalid_desktop_prompt_profile(self) -> None:
        profile_path = Path(__file__).with_name(".cp2-invalid-prompt-profile.json")
        try:
            profile_path.write_text(
                json.dumps({"schemaVersion": 1, "profile": {}}),
                encoding="utf-8",
            )
            with self.assertRaises(PipelineError):
                load_prompt_selection(profile_path, "cache")
        finally:
            profile_path.unlink(missing_ok=True)

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
        rate_limit_path = directory / "rate-limit.json"

        try:
            client = GeminiClient(
                directory,
                dry_run=True,
                observer=lambda event, payload: events.append((event, payload)),
                rate_limit_path=rate_limit_path,
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
            rate_limit_path.unlink(missing_ok=True)
            rate_limit_path.with_name(f"{rate_limit_path.name}.lock").unlink(missing_ok=True)
            if directory.exists():
                directory.rmdir()

        self.assertIsNotNone(fake_models.call)
        request_config = fake_models.call["config"]
        video_part = fake_models.call["contents"][0]
        self.assertEqual(video_part.video_metadata.fps, 2.0)
        self.assertEqual(request_config.seed, gemini_config.SEED)
        self.assertIsNone(request_config.temperature)
        self.assertEqual(request_config.http_options.retry_options.attempts, 1)
        self.assertEqual(request_config.response_mime_type, "application/json")
        self.assertEqual(request_config.response_json_schema["required"], ["appearances"])
        self.assertEqual(events[-1], ("tokens", {"inputTokens": 120, "outputTokens": 45}))

    def test_transient_503_retries_and_reports_wait(self) -> None:
        from google.genai import errors

        raw_response = response(start_time_seconds=12.5, end_time_seconds=70.5)

        class FakeModels:
            def __init__(self) -> None:
                self.calls = 0

            def generate_content(self, **_kwargs: object) -> object:
                self.calls += 1
                if self.calls == 1:
                    raise errors.ServerError(
                        503,
                        {
                            "error": {
                                "code": 503,
                                "message": "The model is overloaded.",
                                "details": [
                                    {
                                        "@type": "type.googleapis.com/google.rpc.RetryInfo",
                                        "retryDelay": "0s",
                                    }
                                ],
                            }
                        },
                    )
                usage = type(
                    "Usage",
                    (),
                    {"prompt_token_count": 120, "candidates_token_count": 45},
                )()
                return type("Response", (), {"text": raw_response, "usage_metadata": usage})()

        rate_limit_path = Path(__file__).with_name(".cp2-retry-limit.json")
        events: list[tuple[str, dict[str, object]]] = []
        client = GeminiClient(
            Path(__file__).parent,
            dry_run=True,
            observer=lambda event, payload: events.append((event, payload)),
            rate_limit_path=rate_limit_path,
        )
        client.dry_run = False
        fake_models = FakeModels()
        client._client = type("FakeApi", (), {"models": fake_models})()

        try:
            with (
                patch.object(gemini_config, "MIN_REQUEST_INTERVAL_S", 0.0),
                patch("gemini_harness.client.time.sleep") as sleep,
            ):
                text, input_tokens, output_tokens, call_count = client._generate_with_retry(
                    [], object()
                )
        finally:
            rate_limit_path.unlink(missing_ok=True)
            rate_limit_path.with_name(f"{rate_limit_path.name}.lock").unlink(missing_ok=True)

        self.assertEqual(text, raw_response)
        self.assertEqual((input_tokens, output_tokens, call_count), (120, 45, 2))
        self.assertEqual(fake_models.calls, 2)
        sleep.assert_called_once_with(1.0)
        self.assertEqual(events[0][0], "retry_wait")
        self.assertEqual(events[0][1]["statusCode"], 503)
        self.assertEqual(events[0][1]["attempt"], 2)
        self.assertIn("retry_start", [event for event, _payload in events])
        self.assertEqual(events[-1][0], "tokens")

    def test_rate_limit_history_is_shared_across_clients(self) -> None:
        rate_limit_path = Path(__file__).with_name(".cp2-shared-limit.json")
        events: list[tuple[str, dict[str, object]]] = []
        first = GeminiClient(
            Path(__file__).parent,
            dry_run=True,
            rate_limit_path=rate_limit_path,
        )
        second = GeminiClient(
            Path(__file__).parent,
            dry_run=True,
            observer=lambda event, payload: events.append((event, payload)),
            rate_limit_path=rate_limit_path,
        )
        clock = [100.0]
        sleeps: list[float] = []

        def advance_clock(delay: float) -> None:
            sleeps.append(delay)
            clock[0] += delay

        try:
            with (
                patch.object(gemini_config, "REQUESTS_PER_MINUTE", 1),
                patch.object(gemini_config, "MIN_REQUEST_INTERVAL_S", 0.0),
                patch.object(gemini_config, "RATE_WINDOW_S", 60.0),
                patch.object(gemini_config, "RATE_MARGIN_S", 1.0),
                patch("gemini_harness.client.time.time", side_effect=lambda: clock[0]),
                patch("gemini_harness.client.time.sleep", side_effect=advance_clock),
            ):
                first._throttle()
                second._throttle()
        finally:
            rate_limit_path.unlink(missing_ok=True)
            rate_limit_path.with_name(f"{rate_limit_path.name}.lock").unlink(missing_ok=True)

        self.assertEqual(sleeps, [61.0])
        self.assertEqual(events[0][0], "rate_limit_wait")
        self.assertEqual(events[0][1]["requestsPerMinute"], 1)

    def test_proxy_uses_balanced_two_fps_1080p_profile(self) -> None:
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
            )

        command = popen.call_args.args[0]
        video_filter = command[command.index("-vf") + 1]
        self.assertIn(f"fps={PROXY_FPS:g}", video_filter)
        self.assertIn(f"min({MAX_PROXY_HEIGHT}\\,ih)", video_filter)
        self.assertEqual(command[command.index("-crf") + 1], str(PROXY_CRF))
        self.assertNotIn("-r", command)
        self.assertEqual(command[command.index("-fps_mode") + 1], "cfr")

    def test_hardware_proxy_requests_accelerated_decode(self) -> None:
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
                HARDWARE_ENCODERS[0],
            )

        command = popen.call_args.args[0]
        self.assertEqual(command[command.index("-hwaccel") + 1], "auto")

    def test_hardware_encoders_use_quality_based_rate_control(self) -> None:
        nvenc, qsv, amf = HARDWARE_ENCODERS

        self.assertIn("-cq", nvenc.arguments)
        self.assertEqual(
            nvenc.arguments[nvenc.arguments.index("-cq") + 1],
            str(HARDWARE_PROXY_QUALITY),
        )
        self.assertEqual(nvenc.arguments[nvenc.arguments.index("-b:v") + 1], "0")

        self.assertIn("-global_quality", qsv.arguments)
        self.assertEqual(
            qsv.arguments[qsv.arguments.index("-global_quality") + 1],
            str(HARDWARE_PROXY_QUALITY),
        )
        self.assertNotIn("-b:v", qsv.arguments)

        self.assertEqual(amf.arguments[amf.arguments.index("-rc") + 1], "cqp")
        for option in ("-qp_i", "-qp_p", "-qp_b"):
            self.assertEqual(
                amf.arguments[amf.arguments.index(option) + 1],
                str(HARDWARE_PROXY_QUALITY),
            )
        self.assertNotIn("-b:v", amf.arguments)

    def test_frame_rate_probe_uses_stream_metadata(self) -> None:
        with patch(
            "analyze.run_probe",
            return_value={
                "streams": [
                    {"avg_frame_rate": "60000/1001", "r_frame_rate": "60/1"}
                ]
            },
        ) as run_probe:
            measured = probe_frame_rate("ffprobe", Path("source.mov"))

        self.assertAlmostEqual(measured, 59.94005994)
        arguments = run_probe.call_args.args
        self.assertIn("stream=avg_frame_rate,r_frame_rate", arguments)
        self.assertNotIn("-show_frames", arguments)

    def test_proxy_cache_key_changes_with_the_source(self) -> None:
        root = Path(__file__).with_name(".cp2-cache-key")
        source = root / "source.mov"
        cache = root / "cache"
        root.mkdir(exist_ok=True)
        try:
            source.write_bytes(b"first")
            first = proxy_cache_path(source, cache)
            self.assertEqual(first, proxy_cache_path(source, cache))

            source.write_bytes(b"second version")
            second = proxy_cache_path(source, cache)
        finally:
            source.unlink(missing_ok=True)
            root.rmdir()

        self.assertNotEqual(first.name, second.name)
        self.assertTrue(first.name.endswith(".proxy.mp4"))

    def test_proxy_stage_reuses_a_valid_cached_proxy(self) -> None:
        root = Path(__file__).with_name(".cp2-cache-reuse")
        source = root / "source.mov"
        cache = root / "cache"
        cached_proxy = cache / "source.proxy.mp4"
        cache.mkdir(parents=True, exist_ok=True)
        source.write_bytes(b"source")
        cached_proxy.write_bytes(b"proxy")
        try:
            with (
                patch("analyze.probe_duration", side_effect=[10.0, 10.0]),
                patch("analyze.probe_frame_rate", side_effect=[60.0, PROXY_FPS]),
                patch("analyze.create_proxy") as create,
                patch("analyze.emit"),
            ):
                result = proxy_stage(
                    source,
                    cached_proxy,
                    "ffmpeg",
                    "ffprobe",
                    reuse_existing=True,
                )
        finally:
            cached_proxy.unlink(missing_ok=True)
            source.unlink(missing_ok=True)
            cache.rmdir()
            root.rmdir()

        create.assert_not_called()
        self.assertTrue(result["proxyCached"])
        self.assertEqual(result["proxyFps"], PROXY_FPS)

    def test_hardware_encoder_selection_falls_through_candidates(self) -> None:
        with patch(
            "analyze._encoder_is_available",
            side_effect=[False, True],
        ):
            selected = select_proxy_encoder("ffmpeg")

        self.assertEqual(selected, HARDWARE_ENCODERS[1])

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
