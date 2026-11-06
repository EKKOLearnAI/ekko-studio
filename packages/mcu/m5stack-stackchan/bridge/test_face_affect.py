"""Offline synthetic-array tests; no camera, device, network, or human images."""

import base64
import json
import math
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

import numpy as np

from face_affect import FaceAffect, LABELS, _ALIGN_POINTS, _alignment_matrix, _bounded_color_jpeg

try:
    import cv2
except ImportError:
    cv2 = None


def scores(label="happiness", confidence=.95):
    probabilities = np.full(8, (1. - confidence) / 7)
    probabilities[LABELS.index(label)] = confidence
    return np.log(probabilities).reshape(1, 8)


def sample(frame=1, track=7, **overrides):
    # Artificial ramp, not a face or a reconstruction of a person's pixels.
    pixels = bytes((i * 17 + i // 64) % 256 for i in range(4096))
    result = dict(ok=True, pending=False, valid=True, bootId="synthetic-boot",
                  trackId=track, frameId=frame, capturedMs=(frame * 100) & 0xFFFFFFFF,
                  ageMs=0, width=64, height=64, encoding="gray8-base64", mirrored=False,
                  locked=True, tracking=True, ambiguous=False, faces=1,
                  multipleFaces=False, pixels=base64.b64encode(pixels).decode("ascii"))
    result.update(overrides)
    return result


def transport_gap(frame=3, reason="stale", **overrides):
    result = sample(frame, valid=False, reason=reason, ageMs=700)
    result.pop("pixels")
    result.update(overrides)
    return result


class FakeSession:
    def __init__(self, outputs=None):
        self.outputs = list(outputs if outputs is not None else [scores()])
        self.calls = 0
        self.input_summary = None

    def get_inputs(self):
        return [SimpleNamespace(name="input", shape=[1, 1, 64, 64], type="tensor(float)")]

    def get_outputs(self):
        return [SimpleNamespace(name="output", shape=[1, 8], type="tensor(float)")]

    def run(self, names, feed):
        array = feed["input"]
        self.input_summary = (array.shape, str(array.dtype), float(array.min()),
                              float(array.max()), float(array[0, 0, 0, 1]),
                              float(array[0, 0, 1, 0]))
        value = self.outputs[min(self.calls, len(self.outputs) - 1)]
        self.calls += 1
        if isinstance(value, Exception):
            raise value
        return [value]


MOBILE_LABELS = ("angry", "disgust", "fearful", "happy", "neutral", "sad", "surprised")


def mobile_scores(label="happy", confidence=.95):
    probabilities = np.full(7, (1. - confidence) / 6)
    probabilities[MOBILE_LABELS.index(label)] = confidence
    return np.log(probabilities).reshape(1, 7)


def artificial_jpeg(*, progressive=False, grayscale=False):
    # Deliberately non-face colors/geometry, generated only in memory.
    image = np.zeros((112, 112, 3), dtype=np.uint8)
    image[:, :, :] = (20, 90, 220)
    image[35:80, 40:75] = (180, 110, 35)
    if grayscale:
        image = image[:, :, 0]
    flags = [cv2.IMWRITE_JPEG_QUALITY, 75]
    if progressive:
        flags += [cv2.IMWRITE_JPEG_PROGRESSIVE, 1]
    ok, encoded = cv2.imencode(".jpg", image, flags)
    assert ok and len(encoded) <= 4096
    return encoded.tobytes()


def mobile_sample(frame=1, **overrides):
    result = sample(frame, width=112, height=112, encoding="jpeg-base64",
                    pixels=base64.b64encode(artificial_jpeg()).decode("ascii"),
                    landmarks=[coordinate for point in _ALIGN_POINTS for coordinate in point])
    result.update(overrides)
    return result


class FakeMobileSession(FakeSession):
    def __init__(self, outputs=None):
        super().__init__(outputs if outputs is not None else [mobile_scores()])
        self.tensor = None

    def get_inputs(self):
        return [SimpleNamespace(name="data", shape=[1, 3, 112, 112], type="tensor(float)")]

    def get_outputs(self):
        return [SimpleNamespace(name="label", shape=[1, 7], type="tensor(float)")]

    def run(self, names, feed):
        self.tensor = feed["data"].copy()  # Synthetic fixtures only, never a real image.
        value = self.outputs[min(self.calls, len(self.outputs) - 1)]
        self.calls += 1
        if isinstance(value, Exception):
            raise value
        return [value]


class FaceAffectTests(unittest.TestCase):
    def make(self, outputs=None):
        session = FakeSession(outputs)
        return FaceAffect(Path("unused-in-injected-session"), session=session), session

    def stable(self, engine, label="happy", start=1, now=0):
        for offset in range(3):
            result = engine.infer(sample(start + offset), now + offset)
        self.assertTrue(result.stable)
        self.assertEqual(result.mood, label)
        return result

    def test_exact_preprocess_no_normalization(self):
        engine, session = self.make()
        result = engine.infer(sample(), 0)
        self.assertFalse(result.stable)
        self.assertEqual(session.input_summary, ((1, 1, 64, 64), "float32", 0., 255., 17., 65.))

    def test_three_new_frames_are_required(self):
        engine, _ = self.make()
        for index in range(3):
            result = engine.infer(sample(index + 1), index)
            self.assertEqual(result.frames, index + 1)
            self.assertEqual(result.stable, index == 2)
            self.assertEqual(result.mood, "happy" if index == 2 else "unknown")
        self.assertEqual(len(result.as_dict()["probabilities"]), 8)
        self.assertEqual(result.as_dict()["interpretation"], "visible_expression_only")

    def test_all_eight_classes_and_abstention_mapping(self):
        expected = {"neutral": "neutral", "happiness": "happy", "sadness": "sad",
                    "anger": "angry", "fear": "anxious"}
        for expression in LABELS:
            with self.subTest(expression=expression):
                engine, _ = self.make([scores(expression)])
                for index in range(3):
                    result = engine.infer(sample(index + 1), index)
                self.assertEqual(result.expression, expression)
                self.assertEqual(result.mood, expected.get(expression, "unknown"))
                self.assertEqual(result.stable, expression in expected)

    def test_duplicate_and_out_of_order_do_not_count_or_run_again(self):
        engine, session = self.make()
        engine.infer(sample(10), 0)
        for frame, timestamp in [(10, .2), (9, .4), (11, .6)]:
            candidate = sample(frame)
            if frame == 11:
                candidate["capturedMs"] = 1000  # New ID, same exposure is not new evidence.
            result = engine.infer(candidate, timestamp)
            self.assertEqual(result.frames, 1)
        self.assertEqual(session.calls, 1)
        engine.infer(sample(11), 1)
        self.assertTrue(engine.infer(sample(12), 2).stable)

    def test_duplicate_cannot_refresh_the_three_second_expiry(self):
        engine, _ = self.make()
        original = self.stable(engine)
        duplicate = engine.infer(sample(3), 4.99)
        self.assertTrue(duplicate.stable)
        self.assertEqual(duplicate.observed_at, original.observed_at)
        self.assertEqual(duplicate.expires_at, 5.)
        expired = engine.snapshot(5.)
        self.assertFalse(expired.stable)
        self.assertEqual((expired.mood, expired.status, expired.frames), ("unknown", "stale", 0))
        self.assertEqual(engine.infer(sample(4), 5.1).frames, 1)

    def test_device_age_and_gaps_expire_consensus(self):
        engine, _ = self.make()
        first = engine.infer(sample(1, ageMs=2500), 10)
        self.assertEqual(first.observed_at, 7.5)
        self.assertEqual(first.expires_at, 10.5)
        self.assertEqual(engine.infer(sample(2), 11).frames, 1)
        self.assertFalse(engine.infer(sample(3, ageMs=3000), 12).stable)
        self.assertEqual(engine.snapshot(12).status, "stale")

    def test_three_frames_must_all_be_recent_and_history_is_bounded(self):
        engine, _ = self.make()
        for index, now in enumerate((0., 2.9, 5.8)):
            result = engine.infer(sample(index + 1), now)
            self.assertFalse(result.stable)
        self.assertEqual(result.frames, 2)
        for index in range(4, 100):
            engine.infer(sample(index), 5.8 + (index - 3) * .1)
        self.assertEqual(len(engine._history), 3)
        self.assertTrue(engine.snapshot(16.).stable)

    def test_boot_or_target_change_restarts_consensus(self):
        for overrides in ({"trackId": 8}, {"bootId": "another-boot"}):
            engine, _ = self.make()
            self.stable(engine)
            result = engine.infer(sample(4, **overrides), 3)
            self.assertFalse(result.stable)
            self.assertEqual(result.frames, 1)

    def test_no_face_ambiguous_or_rejected_crop_clear_old_estimate(self):
        for overrides in ({"locked": False}, {"tracking": False}, {"ambiguous": True},
                          {"valid": False, "reason": "not-public"}, {"faces": 0}):
            engine, _ = self.make()
            self.stable(engine)
            result = engine.infer(sample(4, **overrides), 3)
            self.assertFalse(result.stable)
            self.assertEqual(result.mood, "unknown")
            self.assertEqual(engine.infer(sample(5), 4).frames, 1)

    def test_device_occlusion_rejection_is_explicit_and_clears_consensus(self):
        engine, session = self.make()
        self.stable(engine)
        rejected = sample(4, valid=False, reason="occlusion_suspected")
        rejected.pop("pixels")  # Firmware never includes pixels for rejected crops.
        result = engine.infer(rejected, 3)
        self.assertEqual(result.reason, "occlusion_suspected")
        self.assertEqual((result.status, result.stable, result.mood, result.frames),
                         ("invalid_sample", False, "unknown", 0))
        self.assertEqual(session.calls, 3)
        self.assertEqual(engine.infer(sample(5), 4).frames, 1)

    def test_bounded_transport_gap_restores_only_after_a_third_fresh_frame(self):
        for reason in ("stale", "timeout"):
            with self.subTest(reason=reason):
                engine, session = self.make()
                engine.infer(sample(1), 0.)
                before = engine.infer(sample(2), .8)
                gap = engine.infer(transport_gap(reason=reason), 1.)
                during = engine.snapshot(1.1)
                restored = engine.infer(sample(4), 1.8)
                self.assertTrue(restored.stable, "three verified observations still fit the original window")
                self.assertEqual(restored.frames, 3)
                self.assertEqual((gap.stable, gap.mood, gap.reason), (False, "unknown", reason))
                self.assertFalse(during.stable)
                self.assertEqual((gap.frames, gap.frame_id, gap.observed_at, gap.expires_at),
                                 (before.frames, before.frame_id, before.observed_at, before.expires_at))
                self.assertEqual(session.calls, 3)

    def test_interleaved_gaps_never_refresh_time_frames_or_stable_snapshot(self):
        engine, session = self.make()
        for frame, at in ((1, 0.), (2, .8), (3, 1.6)):
            before = engine.infer(sample(frame), at)
        self.assertTrue(before.stable)
        for at, reason in ((1.8, "stale"), (2., "timeout"), (2.1, "stale")):
            gap = engine.infer(transport_gap(999, reason, ageMs=0), at)
            self.assertEqual((gap.stable, gap.mood, gap.confidence), (False, "unknown", 0.))
            self.assertEqual((gap.frames, gap.frame_id, gap.observed_at, gap.expires_at),
                             (before.frames, before.frame_id, before.observed_at, before.expires_at))
            self.assertEqual((engine._last_frame, engine._last_capture), (3, 300))
            self.assertFalse(engine.snapshot(at + .01).stable)
        self.assertEqual(session.calls, 3)
        self.assertTrue(engine.infer(sample(4), 2.4).stable)
        self.assertEqual(session.calls, 4)

    def test_gap_expiry_is_exact_and_old_frames_cannot_restart_evidence(self):
        engine, session = self.make()
        engine.infer(sample(1), 0.)
        before = engine.infer(sample(2), .8)
        expiry = before.expires_at
        gap = engine.infer(transport_gap(), expiry - .0001)
        self.assertEqual((gap.frames, gap.expires_at), (2, expiry))
        expired = engine.snapshot(expiry)
        self.assertEqual((expired.frames, expired.stable), (0, False))
        self.assertEqual(engine._history, [])
        again = engine.infer(transport_gap(reason="timeout"), expiry + .01)
        self.assertEqual((again.frames, again.expires_at), (0, expiry))
        duplicate = engine.infer(sample(2), expiry + .02)
        self.assertEqual((duplicate.frames, duplicate.stable), (0, False))
        self.assertEqual(session.calls, 2)
        new = engine.infer(sample(4), expiry + .1)
        self.assertEqual((new.frames, new.stable), (1, False))

    def test_transport_gap_never_expands_the_original_three_second_window(self):
        engine, _ = self.make()
        engine.infer(sample(1), 0.)
        engine.infer(sample(2), .8)
        engine.infer(transport_gap(), 1.)
        result = engine.infer(sample(4), 3.1)
        self.assertEqual((result.frames, result.stable), (2, False))

    def test_next_fresh_after_a_gap_must_have_new_frame_and_capture_ids(self):
        engine, session = self.make()
        engine.infer(sample(1), 0.)
        engine.infer(sample(2), .8)
        engine.infer(transport_gap(999), 1.)
        for at, candidate in ((1.2, sample(2)), (1.3, sample(4, capturedMs=200)),
                              (1.4, sample(1))):
            result = engine.infer(candidate, at)
            self.assertEqual((result.frames, result.stable), (2, False))
            self.assertEqual(result.reason, "frame_not_new")
        self.assertEqual(session.calls, 2)
        self.assertTrue(engine.infer(sample(4), 1.8).stable)

    def test_transport_gap_requires_all_trusted_metadata_fields(self):
        required = ("ok", "pending", "valid", "reason", "bootId", "trackId", "locked",
                    "tracking", "ambiguous", "faces", "frameId", "capturedMs", "ageMs",
                    "width", "height", "encoding", "mirrored")
        for field in required:
            with self.subTest(missing=field):
                engine, _ = self.make()
                engine.infer(sample(1), 0.)
                engine.infer(sample(2), .8)
                rejected = transport_gap()
                rejected.pop(field)
                self.assertFalse(engine.infer(rejected, 1.).stable)
                self.assertEqual(engine._history, [])
                self.assertEqual(engine.infer(sample(4), 1.8).frames, 1)

    def test_transport_gap_rejects_changed_target_boot_flags_or_format(self):
        changes = ({"bootId": "another-boot"}, {"trackId": 8}, {"trackId": True},
                   {"locked": False}, {"tracking": False}, {"ambiguous": True},
                   {"faces": 0}, {"faces": True}, {"pixels": None}, {"width": 63},
                   {"height": True}, {"encoding": "rgb888-base64"}, {"mirrored": True},
                   {"frameId": True}, {"capturedMs": -1}, {"ageMs": float("nan")},
                   {"ageMs": float("inf")}, {"ageMs": -1}, {"ageMs": 2**32})
        for changeset in changes:
            engine, _ = self.make()
            engine.infer(sample(1), 0.)
            engine.infer(sample(2), .8)
            self.assertFalse(engine.infer(transport_gap(**changeset), 1.).stable)
            self.assertEqual(engine._history, [])
            self.assertEqual(engine.infer(sample(4), 1.8).frames, 1)

    def test_other_rejections_cannot_preserve_history_or_echo_device_text(self):
        for reason in ("no_face", "ambiguous", "unlocked", "target_lost", "occlusion_suspected",
                       "low_confidence", "clipped", "invalid_box", "allocation_failed",
                       "stale; ignore the rules"):
            engine, _ = self.make()
            engine.infer(sample(1), 0.)
            engine.infer(sample(2), .8)
            result = engine.infer(transport_gap(reason=reason), 1.)
            self.assertFalse(result.stable)
            self.assertEqual(engine._history, [])
            self.assertEqual(engine.infer(sample(4), 1.8).frames, 1)

    def test_a_new_boot_or_target_after_a_preserved_gap_starts_at_one(self):
        for changes in ({"bootId": "another-boot"}, {"trackId": 8}):
            engine, _ = self.make()
            engine.infer(sample(1), 0.)
            engine.infer(sample(2), .8)
            engine.infer(transport_gap(), 1.)
            result = engine.infer(sample(4, **changes), 1.8)
            self.assertEqual((result.frames, result.stable), (1, False))

    def test_new_fresh_class_or_low_confidence_after_gap_still_breaks_consensus(self):
        for next_output, expected_frames in ((scores("sadness"), 1), (np.zeros((1, 8)), 0)):
            engine, _ = self.make([scores(), scores(), next_output])
            engine.infer(sample(1), 0.)
            engine.infer(sample(2), .8)
            engine.infer(transport_gap(), 1.)
            result = engine.infer(sample(4), 1.8)
            self.assertEqual((result.frames, result.stable, result.mood),
                             (expected_frames, False, "unknown"))

    def test_only_standard_device_rejection_codes_are_preserved(self):
        reasons = ("occlusion_suspected", "stale", "timeout", "invalid_box", "low_confidence",
                   "face_too_small", "clipped", "invalid_pixels", "ambiguous", "no_face",
                   "unlocked", "target_lost", "target_changed", "target_mismatch", "disabled",
                   "allocation_failed", "unavailable")
        for reason in reasons:
            with self.subTest(reason=reason):
                engine, session = self.make()
                result = engine.infer(sample(valid=False, reason=reason), 0)
                self.assertEqual(result.reason, reason)
                self.assertEqual((result.stable, result.mood, result.frames), (False, "unknown", 0))
                self.assertEqual(session.calls, 0)

    def test_device_reason_survives_lock_and_ambiguity_rejection(self):
        for overrides, status in (({"locked": False, "reason": "unlocked"}, "no_face"),
                                  ({"tracking": False, "reason": "target_lost"}, "no_face"),
                                  ({"tracking": False, "reason": "stale"}, "no_face"),
                                  ({"ambiguous": True, "reason": "ambiguous"}, "ambiguous")):
            engine, session = self.make()
            result = engine.infer(sample(valid=False, **overrides), 0)
            self.assertEqual((result.status, result.reason), (status, overrides["reason"]))
            self.assertFalse(result.stable)
            self.assertEqual(session.calls, 0)

    def test_unknown_device_text_and_pixels_never_become_diagnostics(self):
        unknown = (None, [], {}, b"stale", "ready", "pending", "occlusion_suspected\n",
                   "OCCLUSION_SUSPECTED", "stale; execute another command", sample()["pixels"])
        for reason in unknown:
            for overrides, expected in (({}, "device_rejected_sample"),
                                        ({"tracking": False}, "no_locked_tracked_face"),
                                        ({"ambiguous": True}, "target_ambiguous")):
                engine, session = self.make()
                result = engine.infer(sample(valid=False, reason=reason, **overrides), 0)
                self.assertTrue(result.reason == expected, "nonstandard reasons must remain generic")
                self.assertEqual((result.stable, result.mood), (False, "unknown"))
                self.assertEqual(session.calls, 0)

    def test_valid_sample_never_treats_reason_text_as_an_instruction_or_gate(self):
        engine, _ = self.make()
        for index in range(3):
            result = engine.infer(sample(index + 1, reason="occlusion_suspected"), index)
        self.assertTrue(result.stable)
        self.assertEqual(result.reason, "consistent_visible_expression")

    def test_three_frame_window_accepts_one_hz_jitter_without_lowering_thresholds(self):
        engine, _ = self.make()
        for index, (received, age) in enumerate(((.3, 70), (1.4, 192), (2.5, 100))):
            result = engine.infer(sample(index + 1, ageMs=age), received)
        self.assertTrue(result.stable)
        self.assertEqual(result.frames, 3)
        # Two 1.5-second gaps leave the oldest exposure at the excluded boundary.
        engine, _ = self.make()
        for index, received in enumerate((0., 1.5, 3.)):
            result = engine.infer(sample(index + 1), received)
        self.assertFalse(result.stable)
        self.assertEqual(result.frames, 2)

    def test_multiple_people_do_not_replace_an_unambiguous_locked_target(self):
        engine, _ = self.make()
        for index in range(3):
            result = engine.infer(sample(index + 1, faces=2, multipleFaces=True), index)
        self.assertTrue(result.stable)
        self.assertEqual(result.track_id, 7)

    def test_low_confidence_and_small_margin_abstain(self):
        close = np.log(np.array([[.71, .28, .002, .002, .002, .002, .001, .001]]))
        for output in (np.zeros((1, 8)), scores(confidence=.69), close):
            engine, _ = self.make([output])
            for index in range(3):
                result = engine.infer(sample(index + 1), index)
            self.assertEqual((result.mood, result.expression, result.frames), ("unknown", "unknown", 0))

    def test_low_confidence_interrupts_and_class_changes_need_three_frames(self):
        outputs = [scores(), scores(), np.zeros((1, 8)), scores("sadness"),
                   scores("sadness"), scores("sadness")]
        engine, _ = self.make(outputs)
        for index in range(6):
            result = engine.infer(sample(index + 1), index)
            self.assertEqual(result.stable, index == 5)
        self.assertEqual(result.mood, "sad")
        engine._session.outputs.append(scores("anger"))
        changed = engine.infer(sample(7), 6)
        self.assertEqual((changed.frames, changed.mood), (1, "unknown"))

    def test_ema_smooths_only_the_same_consistent_class(self):
        engine, _ = self.make([scores(confidence=.90), scores(confidence=.75), scores(confidence=.95)])
        self.assertAlmostEqual(self.stable(engine).confidence, .884)

    def test_softmax_is_finite_and_shift_invariant(self):
        for extreme in (1000., 1e308):
            output = np.full((1, 8), -extreme)
            output[0, 1] = extreme
            engine, _ = self.make([output])
            result = self.stable(engine)
            self.assertEqual(result.confidence, 1.)
            self.assertTrue(all(math.isfinite(value) for value in result.probabilities))
        engine, _ = self.make([scores() + 1000])
        self.assertAlmostEqual(self.stable(engine).confidence, .95)

    def test_output_nan_inf_wrong_shape_and_provider_failures_are_sanitized(self):
        private_marker = sample()["pixels"]
        for output in (np.full((1, 8), np.nan), np.full((1, 8), np.inf), np.zeros((8,)),
                       np.zeros((2, 8)), RuntimeError(private_marker)):
            engine, _ = self.make([output])
            result = engine.infer(sample(), 0)
            self.assertEqual(result.status, "inference_failed")
            self.assertFalse(result.stable)
            self.assertNotIn(private_marker, json.dumps(result.as_dict()))

    def test_malformed_base64_wrong_byte_count_and_wrong_types(self):
        valid = sample()["pixels"]
        for pixels in (None, b"bytes", "?" * len(valid), valid[:-4], valid + "AAAA",
                       base64.b64encode(bytes(4095)).decode("ascii"), valid[:-1] + "A"):
            engine, session = self.make()
            result = engine.infer(sample(pixels=pixels), 0)
            self.assertEqual(result.status, "invalid_sample")
            self.assertEqual(session.calls, 0)

    def test_dimensions_encoding_and_metadata_are_bounded(self):
        for key, value in (("width", 63), ("height", 65), ("width", True),
                           ("encoding", "rgb888-base64"), ("mirrored", True),
                           ("frameId", True), ("trackId", 0), ("frameId", -1),
                           ("frameId", 2**32), ("capturedMs", float("nan")),
                           ("bootId", "x" * 81), ("pending", 0)):
            engine, session = self.make()
            result = engine.infer(sample(**{key: value}), 0)
            self.assertFalse(result.stable)
            self.assertEqual(session.calls, 0)
        for age in (float("nan"), float("inf"), -1, True, "0"):
            engine, _ = self.make()
            self.assertEqual(engine.infer(sample(ageMs=age), 0).status, "invalid_sample")

    def test_invalid_monotonic_time_never_raises_or_preserves_a_mood(self):
        for now in (float("nan"), float("inf"), -1, True, "1", None):
            engine, _ = self.make()
            self.stable(engine)
            self.assertEqual(engine.infer(sample(4), now).status, "invalid_time")
        engine, _ = self.make()
        self.stable(engine)
        self.assertEqual(engine.snapshot(1).status, "invalid_time")

    def test_pending_does_not_increment_or_refresh_and_changed_pending_resets(self):
        engine, session = self.make()
        original = self.stable(engine)
        pending = dict(ok=True, pending=True, bootId="synthetic-boot", trackId=7)
        result = engine.infer(pending, 2.5)
        self.assertEqual(result, original)
        self.assertEqual(session.calls, 3)
        pending["trackId"] = 8
        self.assertFalse(engine.infer(pending, 2.6).stable)
        self.assertEqual(engine.infer(sample(4, track=8), 2.7).frames, 1)

    def test_frame_and_capture_clock_wrap(self):
        engine, _ = self.make()
        for now, frame in enumerate((0xFFFFFFFE, 0xFFFFFFFF, 0)):
            result = engine.infer(sample(frame), now)
        self.assertTrue(result.stable)
        self.assertEqual(result.frame_id, 0)

    def test_explicit_reset_forgets_and_never_echoes_arbitrary_reason(self):
        engine, _ = self.make()
        self.stable(engine)
        marker = sample()["pixels"]
        engine.reset(marker)
        result = engine.snapshot(3)
        self.assertEqual((result.mood, result.frames), ("unknown", 0))
        self.assertNotIn(marker, repr(result))
        self.assertEqual(engine.infer(sample(4), 4).frames, 1)

    def test_missing_model_and_bad_session_do_not_break_the_caller(self):
        engine = FaceAffect(Path("/nonexistent-synthetic-model.onnx"))
        result = engine.infer(sample(), 0)
        self.assertEqual(result.status, "unavailable")
        self.assertNotIn("nonexistent", json.dumps(result.as_dict()))
        bad = FakeSession()
        bad.get_inputs = lambda: []
        self.assertEqual(FaceAffect("unused", session=bad).snapshot(0).status, "unavailable")


@unittest.skipIf(cv2 is None, "optional MobileFaceNet dependency is unavailable")
class MobileFaceAffectTests(unittest.TestCase):
    def make(self, outputs=None):
        session = FakeMobileSession(outputs)
        return FaceAffect("unused", backend="mobilefacenet", session=session), session

    def stable(self, engine, start=1, now=0.):
        for offset in range(3):
            result = engine.infer(mobile_sample(start + offset), now + offset)
        self.assertTrue(result.stable)
        return result

    def test_mobile_is_explicit_and_requires_seven_class_rgb_session(self):
        old_session = FakeSession()
        engine = FaceAffect("unused", backend="mobilefacenet", session=old_session)
        self.assertEqual(engine.snapshot(0).reason, "model_initialization_failed")
        engine = FaceAffect("unused", backend="ferplus", session=FakeMobileSession())
        self.assertEqual(engine.snapshot(0).status, "unavailable")
        engine = FaceAffect("unused", backend="untrusted-instruction", session=FakeMobileSession())
        self.assertEqual(engine.snapshot(0).reason, "backend_unsupported")
        engine, session = self.make()
        self.assertEqual(engine.infer(sample(), 0).reason, "sample_format_invalid")
        self.assertEqual(session.calls, 0)

    def test_dependency_failure_is_sanitized_without_breaking_ferplus(self):
        with mock.patch.dict("sys.modules", {"cv2": None}):
            engine = FaceAffect("unused", backend="mobilefacenet", session=FakeMobileSession())
            self.assertEqual(engine.snapshot(0).reason, "dependencies_unavailable")
            old = FaceAffect("unused", session=FakeSession())
            self.assertEqual(old.infer(sample(), 0).frames, 1)

    def test_exact_rgb_normalization_and_canonical_alignment(self):
        engine, session = self.make()
        candidate = mobile_sample()
        result = engine.infer(candidate, 0)
        self.assertEqual(result.frames, 1)
        tensor = session.tensor
        raster = cv2.imdecode(np.frombuffer(base64.b64decode(candidate["pixels"]), np.uint8),
                              cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
        expected = (raster[:, :, ::-1].astype(np.float32) / np.float32(255.) - np.float32(.5)) / np.float32(.5)
        self.assertEqual(tensor.shape, (1, 3, 112, 112))
        self.assertEqual(tensor.dtype, np.float32)
        self.assertTrue(tensor.flags.c_contiguous)
        np.testing.assert_array_equal(tensor[0], expected.transpose(2, 0, 1))
        self.assertTrue(np.isfinite(tensor).all())
        self.assertGreater(tensor[0, 0, 0, 0], tensor[0, 2, 0, 0])  # RGB, not BGR.
        self.assertGreaterEqual(float(tensor.min()), -1.)
        self.assertLessEqual(float(tensor.max()), 1.)

    def test_nonreflective_five_point_similarity_matches_known_transform(self):
        canonical = np.asarray(_ALIGN_POINTS)
        angle, scale = .12, .85
        a, b = scale * math.cos(angle), scale * math.sin(angle)
        forward = np.array([[a, -b, 7.], [b, a, -3.], [0., 0., 1.]])
        source = np.hstack((canonical, np.ones((5, 1)))) @ forward.T
        known_inverse = np.linalg.inv(forward)[:2]
        np.testing.assert_allclose(_alignment_matrix(source[:, :2]), known_inverse, atol=1e-11)
        engine, session = self.make()
        candidate = mobile_sample(landmarks=source[:, :2].reshape(-1).tolist())
        self.assertEqual(engine.infer(candidate, 0).frames, 1)
        raster = cv2.imdecode(np.frombuffer(base64.b64decode(candidate["pixels"]), np.uint8),
                              cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
        aligned = cv2.warpAffine(raster, known_inverse, (112, 112), flags=cv2.INTER_LINEAR)
        expected = (aligned[:, :, ::-1].astype(np.float32) / np.float32(255.) - np.float32(.5)) / np.float32(.5)
        np.testing.assert_array_equal(session.tensor[0], expected.transpose(2, 0, 1))

    def test_all_seven_classes_map_to_public_eight_labels_once(self):
        expected = {"angry": ("anger", "angry"), "disgust": ("disgust", "unknown"),
                    "fearful": ("fear", "anxious"), "happy": ("happiness", "happy"),
                    "neutral": ("neutral", "neutral"), "sad": ("sadness", "sad"),
                    "surprised": ("surprise", "unknown")}
        for label, (expression, mood) in expected.items():
            with self.subTest(label=label):
                engine, _ = self.make([mobile_scores(label)])
                for index in range(3):
                    result = engine.infer(mobile_sample(index + 1), index)
                self.assertEqual((result.expression, result.mood), (expression, mood))
                self.assertEqual(result.stable, mood != "unknown")
                self.assertAlmostEqual(result.confidence, .95)
                self.assertEqual(result.probabilities[7], 0.)
                self.assertAlmostEqual(sum(result.probabilities), 1.)

    def test_new_frames_age_consensus_and_safe_transport_gaps_are_unchanged(self):
        engine, session = self.make()
        engine.infer(mobile_sample(1), 0.)
        second = engine.infer(mobile_sample(2), .8)
        gap = mobile_sample(999, valid=False, reason="timeout", ageMs=800)
        gap.pop("pixels")
        gap.pop("landmarks")  # No new image geometry is required for a no-image gap.
        rejected = engine.infer(gap, 1.)
        self.assertEqual((rejected.frames, rejected.expires_at), (2, second.expires_at))
        self.assertFalse(rejected.stable)
        duplicate = engine.infer(mobile_sample(2), 1.2)
        self.assertEqual((duplicate.frames, duplicate.reason), (2, "frame_not_new"))
        self.assertTrue(engine.infer(mobile_sample(4), 1.8).stable)
        self.assertEqual(session.calls, 3)
        self.assertFalse(engine.snapshot(4.8).stable)  # Exact expiry.
        self.assertEqual(engine.infer(mobile_sample(5, ageMs=3000), 5.).reason,
                         "device_sample_expired")

    def test_modern_three_seconds_confidence_margin_and_target_gates_are_not_lowered(self):
        engine, _ = self.make()
        for frame, at in ((1, 0.), (2, 1.5), (3, 3.)):
            result = engine.infer(mobile_sample(frame), at)
        self.assertEqual((result.frames, result.stable), (2, False))
        close = np.full((1, 7), .002)
        close[0, 3], close[0, 4] = .71, .28
        for output in (mobile_scores(confidence=.69), np.log(close), np.zeros((1, 7))):
            engine, _ = self.make([output])
            for frame in range(1, 4):
                result = engine.infer(mobile_sample(frame), frame)
            self.assertEqual((result.stable, result.frames), (False, 0))
        for changes in ({"bootId": "new-boot"}, {"trackId": 8},
                        {"locked": False}, {"tracking": False}, {"ambiguous": True}):
            engine, _ = self.make()
            self.stable(engine)
            result = engine.infer(mobile_sample(4, **changes), 2.5)
            self.assertFalse(result.stable)

    def test_malformed_landmarks_never_reach_onnx_or_escape_in_status(self):
        canonical = [coordinate for point in _ALIGN_POINTS for coordinate in point]
        bad = [None, (), [], list(_ALIGN_POINTS), canonical[:-1], canonical + [1.],
               [0.] * 10]
        for index, value in ((0, True), (0, float("nan")), (2, float("inf")),
                             (0, -1), (9, 112), (0, "38"), (4, 10000)):
            changed = canonical.copy()
            changed[index] = value
            bad.append(changed)
        for first, second in ((0, 1), (3, 4)):
            changed = np.asarray(_ALIGN_POINTS).copy()
            changed[[first, second]] = changed[[second, first]]
            bad.append(changed.reshape(-1).tolist())
        for nose in ((56., 30.), (56., 100.)):
            changed = canonical.copy()
            changed[4:6] = nose
            bad.append(changed)
        for landmarks in bad:
            engine, session = self.make()
            result = engine.infer(mobile_sample(landmarks=landmarks), 0)
            self.assertEqual(result.reason, "sample_landmarks_invalid")
            self.assertEqual(session.calls, 0)
            self.assertNotIn("landmarks", result.as_dict())

    def test_jpeg_allocation_gates_run_before_native_decode(self):
        original = artificial_jpeg()
        marker = original.index(b"\xff\xc0")
        malformed = [b"", b"not-jpeg", original[:-1], original + b"extra",
                     original + bytes(4097), original[:marker] + b"\xff\xc0\xff\xff"]
        for offset, replacement in ((4, b"\x0c"), (5, b"\xff\xff"),
                                    (7, b"\x00\x71"), (9, b"\x01")):
            changed = bytearray(original)
            changed[marker + offset:marker + offset + len(replacement)] = replacement
            malformed.append(bytes(changed))
        sof_length = int.from_bytes(original[marker + 2:marker + 4], "big")
        sof = original[marker:marker + 2 + sof_length]
        malformed.extend((original[:marker] + sof + original[marker:],
                          original[:-2] + sof + original[-2:], artificial_jpeg(grayscale=True)))
        for encoded in malformed:
            engine, session = self.make()
            with mock.patch.object(cv2, "imdecode", side_effect=AssertionError("decoder_called")) as decoder:
                result = engine.infer(mobile_sample(pixels=base64.b64encode(encoded).decode("ascii")), 0)
            self.assertFalse(result.stable)
            self.assertEqual(session.calls, 0)
            decoder.assert_not_called()

    def test_baseline_and_progressive_jpeg_acceptance_and_seeded_invalid_bytes(self):
        for progressive in (False, True):
            encoded = artificial_jpeg(progressive=progressive)
            self.assertTrue(_bounded_color_jpeg(encoded))
            engine, session = self.make()
            self.assertEqual(engine.infer(mobile_sample(pixels=base64.b64encode(encoded).decode("ascii")), 0).frames, 1)
            self.assertEqual(session.calls, 1)
        random = np.random.default_rng(983)
        for length in range(0, 4097, 7):
            self.assertFalse(_bounded_color_jpeg(random.integers(0, 256, length, dtype=np.uint8).tobytes()))

    def test_base64_is_canonical_and_bounded_for_color_too(self):
        good = mobile_sample()["pixels"]
        for pixels in (None, good.encode(), "?" * len(good), good + "\n", "A" * 5465,
                       good[:-1]):
            engine, session = self.make()
            result = engine.infer(mobile_sample(pixels=pixels), 0)
            self.assertEqual(result.reason, "sample_pixels_invalid")
            self.assertEqual(session.calls, 0)
        engine, session = self.make()
        result = engine.infer(mobile_sample(pixels=good + "AAAA"), 0)
        self.assertIn(result.reason, ("sample_pixels_invalid", "sample_jpeg_invalid"))
        self.assertEqual(session.calls, 0)

    def test_jpeg_exif_cannot_rotate_the_landmark_raster(self):
        encoded = artificial_jpeg()
        # Minimal synthetic little-endian EXIF IFD with Orientation=6 (90 deg).
        exif = (b"Exif\x00\x00II\x2a\x00\x08\x00\x00\x00\x01\x00"
                b"\x12\x01\x03\x00\x01\x00\x00\x00\x06\x00\x00\x00\x00\x00\x00\x00")
        tagged = encoded[:2] + b"\xff\xe1" + (len(exif) + 2).to_bytes(2, "big") + exif + encoded[2:]
        self.assertTrue(_bounded_color_jpeg(tagged))
        first, first_session = self.make()
        second, second_session = self.make()
        self.assertEqual(first.infer(mobile_sample(pixels=base64.b64encode(encoded).decode("ascii")), 0).frames, 1)
        self.assertEqual(second.infer(mobile_sample(pixels=base64.b64encode(tagged).decode("ascii")), 0).frames, 1)
        np.testing.assert_array_equal(first_session.tensor, second_session.tensor)

    def test_output_errors_are_sanitized_and_never_retain_raw_samples(self):
        marker = mobile_sample()["pixels"]
        for output in (np.full((1, 7), np.nan), np.full((1, 7), np.inf),
                       np.zeros((1, 8)), RuntimeError(marker)):
            engine, _ = self.make([output])
            result = engine.infer(mobile_sample(), 0)
            self.assertEqual(result.status, "inference_failed")
            self.assertNotIn(marker, json.dumps(result.as_dict()))
            self.assertNotIn("pixels", vars(engine))

    def test_decoder_and_alignment_failures_are_sanitized(self):
        engine, session = self.make()
        with mock.patch.object(cv2, "imdecode", return_value=np.zeros((200, 112, 3), np.uint8)):
            result = engine.infer(mobile_sample(), 0)
        self.assertEqual(result.reason, "sample_jpeg_invalid")
        engine, _ = self.make()
        with mock.patch.object(cv2, "warpAffine", side_effect=RuntimeError(mobile_sample()["pixels"])):
            result = engine.infer(mobile_sample(), 0)
        self.assertEqual(result.reason, "sample_preprocessing_failed")
        self.assertEqual(session.calls, 0)


if __name__ == "__main__":
    unittest.main()
