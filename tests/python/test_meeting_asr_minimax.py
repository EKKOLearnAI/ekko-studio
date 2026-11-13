"""Tests for the MiniMax ASR provider integration (Meeting 0.8.x).

Covers:
  - Settings initialisation reads the MINIMAX_* env vars at import time.
  - Storage round-trips the MiniMax fields via config.json + config.env
    without disturbing the DashScope key (and vice-versa).
  - `sync_from()` propagates a hot push of MiniMax config to the runtime
    Settings singleton (the same fix that addresses the v0.7.17 incident for
    DashScope).
  - WAV header encoding produces a valid 44-byte header with the correct
    RIFF/format chunk layout.
"""

from __future__ import annotations

import importlib
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
PY_BACKEND = REPO_ROOT / "packages" / "server" / "src" / "modules" / "studio" / "services" / "meeting-asr" / "python-backend"
if str(PY_BACKEND) not in sys.path:
    sys.path.insert(0, str(PY_BACKEND))


class MiniMaxConfigSyncTest(unittest.TestCase):
    def setUp(self) -> None:
        self._data_dir = tempfile.mkdtemp(prefix="meeting-asr-minimax-")
        self._env_patcher = mock.patch.dict(
            os.environ,
            {
                "DATA_DIR": self._data_dir,
                "DASHSCOPE_API_KEY": "sk-dashscope-keepme",
                "MINIMAX_API_KEY": "minimax-secret-123",
                "MINIMAX_ASR_MODEL": "asr-1.0",
                "MINIMAX_BASE_URL": "https://api.minimaxi.com",
                "MINIMAX_LANGUAGE": "zh",
                "MINIMAX_AUDIO_FORMAT": "wav",
                "MINIMAX_SAMPLE_RATE": "16000",
                "MINIMAX_CHUNK_SECONDS": "12.0",
            },
            clear=False,
        )
        self._env_patcher.start()
        self._app = importlib.import_module("app")
        self._config = importlib.import_module("app.config")
        self._storage = importlib.import_module("app.storage")

    def tearDown(self) -> None:
        self._env_patcher.stop()
        for name in list(sys.modules):
            if name == "app" or name.startswith("app."):
                del sys.modules[name]

    def _storage_instance(self):
        return self._storage.storage

    def _config_settings(self, all_asr: dict | None = None):
        from app.models import AllConfig

        return AllConfig.model_validate({"asr": all_asr or {}})

    def test_settings_load_minimax_env_at_import(self) -> None:
        s = self._config.settings
        self.assertEqual(s.minimax_api_key, "minimax-secret-123")
        self.assertEqual(s.minimax_asr_model, "asr-1.0")
        self.assertEqual(s.minimax_base_url, "https://api.minimaxi.com")
        self.assertEqual(s.minimax_language, "zh")
        self.assertEqual(s.minimax_audio_format, "wav")
        self.assertEqual(s.minimax_sample_rate, 16000)
        self.assertAlmostEqual(s.minimax_chunk_seconds, 12.0)
        # DashScope must remain independent — neither side should clobber the
        # other at import time.
        self.assertEqual(s.dashscope_api_key, "sk-dashscope-keepme")

    def test_minimax_provider_property(self) -> None:
        self.assertFalse(self._config.settings.is_minimax_provider)
        self._config.settings.asr_provider = "minimax"
        try:
            self.assertTrue(self._config.settings.is_minimax_provider)
        finally:
            self._config.settings.asr_provider = "dashscope"
        self.assertFalse(self._config.settings.is_minimax_provider)

    def test_hot_push_minimax_does_not_touch_dashscope(self) -> None:
        """The v0.7.17 fix applied to MiniMax: updating the MiniMax key via
        the API must refresh the runtime Settings, and the DashScope key
        must be untouched."""
        storage = self._storage_instance()
        storage.update_config(
            self._config_settings(
                {
                    "dashscope_api_key": "sk-dashscope-keepme",
                    "minimax_api_key": "minimax-new-456",
                    "minimax_asr_model": "asr-1.0",
                }
            )
        )
        s = self._config.settings
        self.assertEqual(s.minimax_api_key, "minimax-new-456")
        self.assertEqual(s.dashscope_api_key, "sk-dashscope-keepme")
        # Disk round-trips both keys.
        env_text = (Path(self._data_dir) / "config.env").read_text("utf-8")
        self.assertIn("MINIMAX_API_KEY=minimax-new-456", env_text)
        self.assertIn("DASHSCOPE_API_KEY=sk-dashscope-keepme", env_text)
        json_text = (Path(self._data_dir) / "config.json").read_text("utf-8")
        self.assertIn("minimax_api_key", json_text)
        self.assertIn("dashscope_api_key", json_text)

    def test_dashscope_update_keeps_minimax(self) -> None:
        storage = self._storage_instance()
        storage.update_asr_config(
            self._config_settings(
                {
                    "dashscope_api_key": "sk-dashscope-fresh",
                    "minimax_api_key": "minimax-secret-123",
                }
            ).asr
        )
        s = self._config.settings
        self.assertEqual(s.dashscope_api_key, "sk-dashscope-fresh")
        self.assertEqual(s.minimax_api_key, "minimax-secret-123")

    def test_get_config_safe_masks_minimax_key(self) -> None:
        storage = self._storage_instance()
        safe = storage.get_config_safe()
        # Same masking scheme as DashScope: key[:8] + "****" + key[-4:].
        self.assertEqual(safe["asr"]["minimax_api_key_masked"], "minimax-****-123")
        # The masked string must contain the key's prefix and suffix.
        masked = safe["asr"]["minimax_api_key_masked"]
        self.assertTrue(masked.startswith("minimax-"))
        self.assertTrue(masked.endswith("-123"))
        # The same masking applies to the DashScope key — guards against
        # regressions where MiniMax support accidentally removes the
        # DashScope masking helper.
        self.assertEqual(safe["asr"]["dashscope_api_key_masked"], "sk-dashs****epme")


class WavHeaderEncodingTest(unittest.TestCase):
    """The MiniMax client wraps Int16 PCM in a 44-byte RIFF header before
    POSTing. A bad header (wrong chunk size, swapped fields) silently
    confuses the upstream ASR — every regression here turns into "the
    meeting transcript comes back empty"."""

    def setUp(self) -> None:
        # Force a fresh import to avoid prior env leftovers.
        for name in list(sys.modules):
            if name == "app" or name.startswith("app."):
                del sys.modules[name]
        self._env_patcher = mock.patch.dict(
            os.environ,
            {"DATA_DIR": tempfile.mkdtemp(prefix="minimax-wav-")},
            clear=False,
        )
        self._env_patcher.start()
        self._minimax = importlib.import_module("app.asr_minimax")

    def tearDown(self) -> None:
        self._env_patcher.stop()
        for name in list(sys.modules):
            if name == "app" or name.startswith("app."):
                del sys.modules[name]

    def test_wav_header_layout(self) -> None:
        sample_rate = 16000
        # 100 samples × 2 bytes = 200 bytes of PCM payload.
        pcm = b"\x00\x01" * 100
        wav = self._minimax._pcm_to_wav(pcm, sample_rate)
        # 44-byte RIFF header + 200 bytes of payload.
        self.assertEqual(len(wav), 244)
        # RIFF / WAVE magic at the top.
        self.assertEqual(wav[:4], b"RIFF")
        # ChunkSize (4 bytes, little-endian) = 36 + data_size = 36 + 200 = 236
        self.assertEqual(struct.unpack("<I", wav[4:8])[0], 236)
        self.assertEqual(wav[8:12], b"WAVE")
        self.assertEqual(wav[12:16], b"fmt ")
        # fmt chunk size 16, PCM format = 1, channels = 1
        fmt = struct.unpack("<IHHIIHH", wav[16:36])
        self.assertEqual(fmt, (16, 1, 1, sample_rate, sample_rate * 2, 2, 16))
        # data chunk header
        self.assertEqual(wav[36:40], b"data")
        self.assertEqual(struct.unpack("<I", wav[40:44])[0], 200)
        # Body must be the original PCM bytes verbatim.
        self.assertEqual(wav[44:], pcm)

    def test_empty_pcm_returns_empty(self) -> None:
        self.assertEqual(self._minimax._pcm_to_wav(b"", 16000), b"")


if __name__ == "__main__":
    unittest.main()
