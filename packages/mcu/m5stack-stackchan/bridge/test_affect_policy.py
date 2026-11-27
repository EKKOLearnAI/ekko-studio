"""Pure policy tests: no device, transport, model, or original chat text."""

from dataclasses import asdict, FrozenInstanceError, replace
import inspect
import json
import math
import random
import unittest

from affect_policy import AffectPolicy, Decision, INTENTS
from expression_catalog import SCENES


class AffectPolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = AffectPolicy()

    def plan(self, mood, confidence=.9, intensity=.7, now=0, visible=35):
        return self.policy.plan(mood, confidence, intensity,
                                now=now, visible_emotion=visible)

    def accept(self, mood, confidence=.9, intensity=.7, now=0, visible=35):
        decision = self.plan(mood, confidence, intensity, now, visible)
        self.assertTrue(decision.send)
        self.assertTrue(self.policy.commit(decision, now))
        return decision

    def test_all_six_classes_and_safe_actions(self):
        cases = [
            ("neutral", 21, False, None, None, "neutral"),
            ("happy", 35, True, "19", "nod_slow", "warm"),
            ("sad", 35, True, "16", "nod_slow", "concerned"),
            ("anxious", 35, True, "16", "nod_slow", "concerned"),
            ("tired", 35, True, "16", "nod_slow", "concerned"),
            ("angry", 10, True, "35", None, "calm"),
        ]
        for mood, visible, send, emotion, action, style in cases:
            with self.subTest(mood=mood):
                decision = self.plan(mood, visible=visible)
                self.assertEqual((decision.send, decision.emotion_id, decision.action_id,
                                  decision.response_style), (send, emotion, action, style))
                self.assertLessEqual(decision.strength, .55)
                if mood == "angry":
                    self.assertEqual(decision.strength, 0)

    def test_excited_face_requires_both_thresholds(self):
        for confidence, intensity, expected in [(.85, .8, "10"), (.849, 1, "19"),
                                                  (1, .799, "19"), (1, 1, "10")]:
            with self.subTest(confidence=confidence, intensity=intensity):
                decision = self.plan("happy", confidence, intensity)
                self.assertEqual(decision.emotion_id, expected)
                self.assertEqual(decision.action_id, "hop" if expected == "10" else "nod_slow")
                self.assertLessEqual(decision.strength, .55 if expected == "10" else .30)

    def test_warm_face_does_not_alternate_with_sentence_intensity(self):
        for confidence, intensity, visible in [(.9, .3, 19), (1, 1, 10)]:
            with self.subTest(visible=visible):
                self.policy.reset()
                self.accept("happy", confidence, intensity)
                for at, next_intensity in [(1, 1), (10, 0), (40, .5)]:
                    decision = self.plan("happy", 1, next_intensity, at, visible)
                    self.assertFalse(decision.send)
                    self.assertEqual(decision.reason, "same_style_visible")

    def test_related_negative_classes_do_not_repeat_a_visible_style(self):
        self.accept("sad")
        for mood in ("anxious", "tired", "sad"):
            decision = self.plan(mood, 1, 1, 10, 16)
            self.assertFalse(decision.send)
            self.assertIsNone(decision.action_id)

    def test_low_confidence_is_noop_and_threshold_is_inclusive(self):
        for mood in ("neutral", "happy", "sad", "angry", "anxious", "tired"):
            with self.subTest(mood=mood):
                decision = self.plan(mood, .649999, 1, visible=21)
                self.assertFalse(decision.send)
                self.assertEqual(decision.reason, "low_confidence")
                self.assertFalse(self.policy.commit(decision, 0))
        self.assertTrue(self.plan("sad", .65).send)

    def test_style_hysteresis_and_ordinary_minimum_hold(self):
        self.accept("sad")
        self.assertEqual(self.plan("happy", .74, 1, 9, 16).reason, "style_confidence")
        self.assertEqual(self.plan("happy", 1, 1, 7.999, 16).reason, "minimum_hold")
        self.assertTrue(self.plan("happy", .75, .5, 8, 16).send)
        # Even reasserting the same style cannot continually fight another face.
        self.assertEqual(self.plan("sad", 1, 1, 1, 39).reason, "minimum_hold")

    def test_confident_distress_preempts_a_cheerful_face_promptly(self):
        for mood, emotion in [("sad", "16"), ("anxious", "16"),
                              ("tired", "16"), ("angry", "35")]:
            with self.subTest(mood=mood):
                self.policy.reset()
                self.accept("happy", 1, 1)
                self.assertFalse(self.plan(mood, .749, 1, .1, 10).send)
                urgent = self.plan(mood, .75, .7, .1, 10)
                self.assertTrue(urgent.send)
                self.assertEqual((urgent.emotion_id, urgent.reason), (emotion, "negative_priority"))
                if mood == "angry":
                    self.assertEqual((urgent.strength, urgent.action_id), (0, None))

    def test_neutral_holds_then_settles_without_forcing_unowned_faces(self):
        self.assertFalse(self.plan("neutral", visible=21).send)
        self.accept("happy")
        self.assertEqual(self.plan("neutral", now=29.999, visible=19).reason, "neutral_hold")
        self.assertEqual(self.plan("neutral", .749, now=30, visible=19).reason, "style_confidence")
        settle = self.plan("neutral", now=30, visible=19)
        self.assertEqual((settle.send, settle.emotion_id, settle.action_id, settle.strength),
                         (True, "35", None, 0))
        self.assertTrue(self.policy.commit(settle, 30))
        self.assertFalse(self.plan("neutral", now=40, visible=21).send)

    def test_no_send_does_not_renew_accepted_neutral_hold(self):
        self.accept("happy")
        self.assertFalse(self.plan("happy", now=29, visible=19).send)
        # Pure no-send planning cannot extend a previously accepted lease.
        self.assertTrue(self.plan("neutral", now=30, visible=19).send)

    def test_strength_ewma_and_hard_zero(self):
        first = self.accept("happy", 1, .7, visible=35)
        concern = self.plan("sad", 1, .2, 10, 10)
        self.assertAlmostEqual(concern.strength, first.strength + .35 * (.35 * .2 - first.strength))
        self.assertTrue(self.policy.commit(concern, 10))
        zero = self.plan("tired", 1, 0, 20, 39)
        self.assertEqual((zero.strength, zero.action_id), (0, None))

        self.policy.reset()
        self.accept("happy", 1, 1)
        self.assertEqual(self.plan("sad", 1, .2, 10, 10).strength, .35)

    def test_planning_and_failed_dispatch_do_not_change_state(self):
        pending = self.plan("happy", 1, 1)
        self.assertEqual(pending, self.plan("happy", 1, 1))
        # Simulated failed device request: deliberately do not commit.
        next_plan = self.plan("sad", .7, .5, 1, 35)
        self.assertTrue(next_plan.send)  # No committed warm style/hold exists.
        self.assertTrue(self.policy.commit(next_plan, 1))
        self.assertFalse(self.policy.commit(pending, 2))

    def test_explicit_protection_is_original_duration_not_a_heartbeat(self):
        pending = self.plan("happy")
        self.policy.mark_explicit(1, 15000)
        self.assertFalse(self.policy.commit(pending, 1))
        for at in (1, 8, 15.999):
            self.assertEqual(self.plan("sad", 1, 1, at, 21).reason, "explicit_hold")
            self.assertFalse(self.plan("neutral", 1, 1, at, 21).send)
        self.assertTrue(self.plan("sad", 1, 1, 16, 21).send)

    def test_new_explicit_command_replaces_protection_and_reset_invalidates(self):
        self.policy.mark_explicit(0, 30000)
        self.policy.mark_explicit(5, 1000)
        self.assertTrue(self.plan("sad", 1, 1, 6, 21).send)
        pending = self.plan("sad", 1, 1, 6, 21)
        self.policy.reset()
        self.assertFalse(self.policy.commit(pending, 6))
        self.assertTrue(self.plan("sad", .7, 1, 0, 35).send)

    def test_commits_reject_foreign_modified_duplicate_and_expired_plans(self):
        decision = self.plan("happy")
        self.assertFalse(AffectPolicy().commit(decision, 0))
        self.assertFalse(self.policy.commit(replace(decision, strength=math.nan), 0))
        self.assertFalse(self.policy.commit(replace(decision, emotion_id="21"), 0))
        self.assertFalse(self.policy.commit(decision, 25))
        self.assertTrue(self.policy.commit(decision, .1))
        self.assertFalse(self.policy.commit(decision, .2))
        with self.assertRaises(FrozenInstanceError):
            decision.send = False

    def test_long_pause_discards_old_strong_affect(self):
        self.accept("happy", 1, 1)
        decision = self.plan("happy", .7, .2, 61, 35)
        self.assertTrue(decision.send)
        self.assertEqual(decision.emotion_id, "19")
        self.assertAlmostEqual(decision.strength, .30 * .2)
        self.assertEqual(decision.reason, "stale_context")
        self.assertTrue(self.plan("neutral", .65, now=61, visible=10).send)
        self.assertFalse(self.policy.commit(decision, 86))  # Planning TTL elapsed.

    def test_unknown_visible_is_safe_and_formats_are_semantic(self):
        for visible in (None, -1):
            self.assertEqual(self.plan("happy", visible=visible).reason, "unknown_visible")
        self.assertEqual(self.plan("happy", visible=35), self.plan("happy", visible="35"))
        for visible in (True, 8, 42, "8", "99", "３５", 35.0):
            with self.subTest(visible=visible), self.assertRaises(ValueError):
                self.plan("happy", visible=visible)

    def test_invalid_values_are_rejected_without_mutation(self):
        for mood in ("Happy", "unknown", "", None, []):
            with self.subTest(mood=mood), self.assertRaises(ValueError):
                self.plan(mood)
        for value in (-.1, 1.01, math.nan, math.inf, -math.inf, True, "0.9", None, 10**1000):
            for parameter in ("confidence", "intensity"):
                with self.subTest(parameter=parameter, value_type=type(value)), self.assertRaises(ValueError):
                    self.plan("happy", **{parameter: value})
        for at in (math.nan, math.inf, -1, True, "1", 10**1000):
            with self.subTest(now_type=type(at)), self.assertRaises(ValueError):
                self.plan("happy", now=at)
        for duration in (0, -1, 30001, 1.5, True, math.nan):
            with self.subTest(duration=duration), self.assertRaises(ValueError):
                self.policy.mark_explicit(0, duration)
        self.assertTrue(self.plan("happy").send)

    def test_clock_rewind_requires_reset(self):
        self.accept("sad", now=5)
        with self.assertRaises(ValueError):
            self.plan("happy", now=4)
        with self.assertRaises(ValueError):
            self.policy.mark_explicit(4, 1000)
        self.policy.reset()
        self.assertTrue(self.plan("happy", now=0).send)

    def test_sampled_sequence_is_bounded_without_external_dependencies(self):
        rng = random.Random(4421)
        visible = 35
        for index in range(600):
            decision = self.plan(rng.choice(["neutral", "happy", "sad", "angry", "anxious", "tired"]),
                                 rng.random(), rng.random(), index * 4, visible)
            self.assertIsInstance(decision, Decision)
            self.assertTrue(math.isfinite(decision.strength))
            self.assertTrue(0 <= decision.strength <= .55)
            self.assertEqual((decision.duration_ms, decision.ttl_ms), (20000, 25000))
            self.assertIn(decision.action_id, {None, "nod_slow", "hop"})
            if decision.send and index % 3:
                self.assertIn(decision.emotion_id, {"10", "19", "16", "35"})
                self.assertTrue(self.policy.commit(decision, index * 4))
                visible = int(decision.emotion_id)

    def test_interface_does_not_accept_conversation_text(self):
        parameters = inspect.signature(AffectPolicy.plan).parameters
        self.assertEqual(list(parameters), ["self", "user_emotion", "confidence", "intensity",
                                            "now", "visible_emotion", "intent"])
        self.assertEqual(parameters["now"].kind, inspect.Parameter.KEYWORD_ONLY)
        self.assertEqual(parameters['intent'].default, 'auto')

    def test_decision_serializes_only_public_fields(self):
        decision = self.plan("happy")
        data = asdict(decision)
        self.assertEqual(set(data), {"send", "emotion_id", "action_id", "strength",
                                     "duration_ms", "ttl_ms", "response_style", "reason",
                                     "sound_id", "sound_gain", "action_timing", "scene_id"})
        self.assertEqual(json.loads(json.dumps(data)), data)

    def test_every_intent_plans_a_known_small_scene(self):
        for intent in INTENTS:
            with self.subTest(intent=intent):
                self.policy.reset()
                result = self.policy.plan('neutral', .9, .5, now=0,
                                          visible_emotion=35, intent=intent)
                if intent == 'auto':
                    self.assertFalse(result.send)
                    continue
                self.assertTrue(result.send)
                self.assertIn(result.scene_id, SCENES)
                self.assertTrue(0 <= result.strength <= .55)
                self.assertTrue(0 <= result.sound_gain <= .35)
                self.assertIn(result.action_timing, ('now', 'speech_start'))
                self.assertTrue(self.policy.commit(result, 0))
                self.assertEqual(self.policy.snapshot(0)['last_scene'], result.scene_id)

    def test_negative_mood_overrides_inappropriate_celebration(self):
        for mood in ('sad', 'anxious', 'tired', 'angry'):
            for intent in ('celebrate', 'playful', 'greet', 'surprised', 'disagree'):
                with self.subTest(mood=mood, intent=intent):
                    self.policy.reset()
                    self.accept('happy', 1, 1)
                    result = self.policy.plan(mood, 1, .9, now=.1,
                                              visible_emotion=10, intent=intent)
                    self.assertTrue(result.send)
                    self.assertIn(result.emotion_id, ('16', '35'))
                    self.assertEqual(result.reason, 'negative_intent_override')
                    self.assertIsNone(result.sound_id)
                    self.assertEqual(result.sound_gain, 0)
                    if mood == 'angry':
                        self.assertEqual((result.emotion_id, result.action_id, result.strength),
                                         ('35', None, 0))

    def test_same_scene_never_replays_each_sentence(self):
        first = self.policy.plan('neutral', .9, .5, now=0, visible_emotion=35, intent='greet')
        self.assertTrue(self.policy.commit(first, 0))
        for at in (1, 9, 40):
            result = self.policy.plan('neutral', 1, .9, now=at,
                                      visible_emotion=int(first.emotion_id), intent='greet')
            self.assertFalse(result.send)
            self.assertIsNone(result.action_id)
            self.assertIsNone(result.sound_id)
        # A distinct scene can provide a meaningful gesture on the same face,
        # but must still respect hold and changed-scene confidence.
        self.assertEqual(self.policy.plan('neutral', 1, .5, now=1, visible_emotion=19,
                                          intent='agree').reason, 'minimum_hold')
        self.assertEqual(self.policy.plan('neutral', .74, .5, now=9, visible_emotion=19,
                                          intent='agree').reason, 'style_confidence')
        agreement = self.policy.plan('neutral', .9, .5, now=9, visible_emotion=19, intent='agree')
        self.assertTrue(agreement.send)
        self.assertEqual(agreement.action_id, 'nod')
        self.assertEqual(agreement.action_timing, 'speech_start')

    def test_optional_auto_sound_is_quiet_and_negative_care_is_silent(self):
        result = self.plan('happy')
        self.assertIsNotNone(result.sound_id)
        self.assertTrue(0 < result.sound_gain <= .35)
        self.assertEqual(result.action_timing, 'now')
        for mood in ('sad', 'anxious', 'tired', 'angry'):
            for intent in ('auto', 'comfort', 'reassure', 'encourage', 'focus'):
                result = self.policy.plan(mood, 1, .8, now=0, visible_emotion=19, intent=intent)
                self.assertIsNone(result.sound_id)
                self.assertEqual(result.sound_gain, 0)

    def test_snapshot_only_changes_on_commit_and_decays_without_renewal(self):
        initial = self.policy.snapshot(0)
        result = self.policy.plan('neutral', .9, .7, now=0, visible_emotion=35, intent='curious')
        self.assertEqual(initial, self.policy.snapshot(10))  # Failed/no dispatch.
        self.assertTrue(self.policy.commit(result, .1))
        accepted = self.policy.snapshot(.1)
        self.assertEqual(accepted['personality'], 'gentle-curious')
        self.assertGreater(accepted['valence'], initial['valence'])
        self.assertGreater(accepted['engagement'], initial['engagement'])
        later = self.policy.snapshot(30)
        self.assertLess(later['valence'], accepted['valence'])
        self.assertEqual(later['committed_at'], .1)
        later['valence'] = 999
        self.assertNotEqual(self.policy.snapshot(30)['valence'], 999)
        expired = self.policy.snapshot(61)
        for key in ('valence', 'arousal', 'engagement'):
            self.assertEqual(expired[key], initial[key])
        self.assertEqual(expired['last_scene'], 'curious')  # Last accepted, not currently active.

    def test_explicit_guard_and_stop_apply_to_all_new_scene_fields(self):
        pending = self.policy.plan('neutral', 1, .8, now=0, visible_emotion=35, intent='greet')
        self.policy.mark_explicit(1, 15000)
        for intent in INTENTS:
            result = self.policy.plan('happy', 1, 1, now=2, visible_emotion=21, intent=intent)
            self.assertFalse(result.send)
            self.assertEqual(result.reason, 'explicit_hold')
        self.assertFalse(self.policy.commit(pending, 2))
        self.policy.reset()  # Same reset called by Stop/device-boot change.
        self.assertEqual(self.policy.snapshot(0)['last_scene'], None)
        self.assertEqual(self.policy.snapshot(0)['valence'], 0)
        self.assertFalse(self.policy.commit(pending, 2))

    def test_new_payload_fields_cannot_be_changed_even_with_copied_metadata(self):
        result = self.plan('happy')
        for changes in ({'sound_id': 'ekko_talk'}, {'sound_gain': .35},
                        {'action_timing': 'speech_start'}, {'scene_id': 'playful'}):
            forged = replace(result, **changes)
            object.__setattr__(forged, '_proposal_data', result._proposal_data)
            self.assertFalse(self.policy.commit(forged, 0))
        self.assertTrue(self.policy.commit(result, .1))

    def test_invalid_intent_is_rejected_and_low_confidence_never_executes_scene(self):
        for intent in ('', 'unknown', None, [], 1):
            with self.subTest(intent_type=type(intent)), self.assertRaises(ValueError):
                self.policy.plan('neutral', 1, .5, now=0, visible_emotion=35, intent=intent)
        for intent in INTENTS:
            result = self.policy.plan('happy', .64, 1, now=0, visible_emotion=35, intent=intent)
            self.assertFalse(result.send)
            self.assertEqual(result.reason, 'low_confidence')

    def test_actor_and_new_fields_remain_bounded_over_intent_sequence(self):
        rng = random.Random(991)
        visible = 35
        for index in range(800):
            at = index * 9
            result = self.policy.plan(rng.choice(('neutral', 'happy', 'sad', 'angry', 'anxious', 'tired')),
                                      rng.random(), rng.random(), now=at,
                                      visible_emotion=visible, intent=rng.choice(INTENTS))
            self.assertTrue(math.isfinite(result.sound_gain) and 0 <= result.sound_gain <= .35)
            if result.send and index % 3:
                self.assertTrue(self.policy.commit(result, at))
                visible = int(result.emotion_id)
            state = self.policy.snapshot(at)
            self.assertTrue(-1 <= state['valence'] <= 1)
            self.assertTrue(0 <= state['arousal'] <= 1)
            self.assertTrue(0 <= state['engagement'] <= 1)
            json.dumps(state, allow_nan=False)

    def test_accepted_continuous_state_changes_delivery_then_decays(self):
        first = self.policy.plan('happy', 1, 1, now=0, visible_emotion=35, intent='celebrate')
        self.assertTrue(self.policy.commit(first, 0))
        agreement = self.policy.plan('happy', 1, 1, now=9, visible_emotion=19, intent='agree')
        self.assertTrue(self.policy.commit(agreement, 9))
        later = self.policy.plan('happy', 1, 1, now=18, visible_emotion=19, intent='celebrate')
        self.assertTrue(later.send)
        self.assertGreater(later.sound_gain, first.sound_gain)
        self.assertLessEqual(later.strength, .40)
        self.assertTrue(self.policy.commit(later, 18))
        settled = self.policy.plan('happy', 1, 1, now=90, visible_emotion=35, intent='celebrate')
        self.assertAlmostEqual(settled.sound_gain, first.sound_gain)

        untouched = AffectPolicy()
        untouched.plan('happy', 1, 1, now=0, visible_emotion=35, intent='celebrate')
        unaccepted = untouched.plan('happy', 1, 1, now=18, visible_emotion=35, intent='celebrate')
        self.assertAlmostEqual(unaccepted.sound_gain, first.sound_gain)


if __name__ == "__main__":
    unittest.main()
