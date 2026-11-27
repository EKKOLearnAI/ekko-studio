"""Catalog/source consistency only; no device, media decoding or LLM calls."""
from dataclasses import FrozenInstanceError
import json
from pathlib import Path
import re
import unittest

from expression_catalog import ACTIONS, CLIPS, INTENTS, SCENES, STATES, catalog_metadata, get_scene

FIRMWARE = Path(__file__).resolve().parents[1] / "firmware/PulseStackChan"


class ExpressionCatalogTests(unittest.TestCase):
    def test_all_state_ids_and_names_match_actual_firmware(self):
        text = (FIRMWARE / "pulse_states.h").read_text()
        actual = dict(re.findall(r'^\s*\{"(\d{2})",\s*"([^"]+)"', text, re.M))
        self.assertEqual(len(actual), 32)
        self.assertEqual({item.id: item.name for item in STATES}, actual)

    def test_all_non_none_actions_match_firmware_and_native_timing(self):
        text = (FIRMWARE / "motion.cpp").read_text()
        table = text[text.index('const ActDef kActs'):text.index('#undef KEYS')]
        rows = re.findall(r'^\s*\{"(\w+)",\s*(?:KEYS\((\w+)\)|(nullptr)),\s*(.*)\},', table, re.M)
        actual = {name: (key, tail) for name, key, _, tail in rows if name != 'none'}
        self.assertEqual(len(actual), 44)
        self.assertEqual({item.id for item in ACTIONS}, set(actual))
        keys = dict(re.findall(r'const Key (\w+)\[\] = (\{.*?\});', text, re.S))
        for resource in ACTIONS:
            with self.subTest(action=resource.id):
                key, tail = actual[resource.id]
                if key:
                    times = re.findall(r'\{\s*(\d+)\s*,', keys[key])
                    duration = int(times[-1])
                else:
                    duration = int(tail.rsplit(',', 1)[-1].strip())
                self.assertEqual(resource.duration_ms, duration)
                self.assertEqual(resource.hold, 'F_HOLD' in tail or 'F_LOOP' in tail)

    def test_all_clip_ids_and_lengths_match_bank_metadata(self):
        # Parse only short kClips metadata rows, never print PCM arrays.
        text = (FIRMWARE / "sfx_bank.cpp").read_text()
        rows = re.findall(r'^\s*\{"([a-z0-9_]+)",\s*k_\w+,\s*(\d+)\},', text, re.M)
        self.assertEqual(len(rows), 37)
        actual = dict(rows)
        self.assertEqual({item.id for item in CLIPS}, set(actual))
        for item in CLIPS:
            self.assertEqual(item.sample_rate_hz, 24000)
            self.assertEqual(item.duration_ms, (int(actual[item.id]) + 23) // 24)

    def test_every_scene_uses_real_automatic_resources_and_bounded_values(self):
        indexes = [{item.id: item for item in values} for values in (STATES, ACTIONS, CLIPS)]
        self.assertEqual(len(INTENTS), 16)
        self.assertEqual(set(INTENTS), {scene.intent for scene in SCENES.values()})
        for scene in SCENES.values():
            with self.subTest(scene=scene.id):
                for identifier, index in zip((scene.emotion_id, scene.action_id, scene.sound_id), indexes):
                    if identifier is not None:
                        self.assertIn(identifier, index)
                        self.assertTrue(index[identifier].automatic)
                        self.assertIn(scene.intent, index[identifier].compatible_intents)
                self.assertTrue(0 <= scene.max_strength <= .55)
                self.assertTrue(0 <= scene.sound_gain <= .35)
                self.assertTrue(0 < scene.duration_ms <= scene.ttl_ms <= 30000)
                self.assertIn(scene.action_timing, {"now", "speech_start"})
                if scene.action_id is None:
                    self.assertEqual(scene.action_timing, "now")

    def test_lifecycle_and_strong_performances_are_not_ordinary_chat(self):
        states = {item.id: item for item in STATES}
        actions = {item.id: item for item in ACTIONS}
        for identifier in ('00', '01', '05', '06', '07', '12', '13', '17', '21', '33', '34', '38', '41'):
            self.assertFalse(states[identifier].automatic)
            self.assertIn('automatic', states[identifier].restricted_modes)
        for identifier in ('angry', 'panic', 'jolt', 'boot', 'dance', 'track', 'busy'):
            self.assertFalse(actions[identifier].automatic)
        # A prerecorded talk/recognition sound cannot impersonate real speech
        # synthesis or an actual recognition/completion event during chat.
        for item in CLIPS:
            if item.id in ('ekko_talk', 'track_recognized', 'track_listen', 'track_lalala'):
                self.assertFalse(item.automatic)

    def test_every_resource_has_purpose_compatibility_and_stop_conditions(self):
        for item in (*STATES, *ACTIONS, *CLIPS):
            self.assertTrue(item.purpose)
            self.assertTrue(item.disabled_when)
            self.assertTrue(item.allowed_modes)
            self.assertIn('expired_or_cancelled', item.disabled_when)
            self.assertTrue(0 <= item.recommended_strength <= item.max_strength <= 1)
            self.assertGreater(item.duration_ms, 0)
            if not item.automatic:
                self.assertNotIn('automatic', item.allowed_modes)

    def test_metadata_is_json_safe_and_detached_from_immutable_catalog(self):
        metadata = catalog_metadata()
        self.assertEqual([len(metadata[key]) for key in ('states', 'actions', 'clips')], [32, 44, 37])
        json.dumps(metadata, allow_nan=False)
        metadata['states'][0]['id'] = 'fake'
        metadata['scenes'][0]['sound_gain'] = 99
        metadata['intents'].clear()
        fresh = catalog_metadata()
        self.assertEqual(fresh['states'][0]['id'], '00')
        self.assertLessEqual(fresh['scenes'][0]['sound_gain'], .35)
        self.assertEqual(len(fresh['intents']), 16)
        with self.assertRaises(TypeError):
            SCENES['greet'] = None
        with self.assertRaises(FrozenInstanceError):
            get_scene('greet').sound_gain = 1

    def test_unknown_scene_is_not_a_freeform_command(self):
        for value in ('shell', '', None, []):
            with self.subTest(value_type=type(value)), self.assertRaises(ValueError):
                get_scene(value)


if __name__ == '__main__':
    unittest.main()
