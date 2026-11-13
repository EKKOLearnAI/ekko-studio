"""Regression tests for the v0.7.17 "hot config push never reaches runtime
Settings" bug.

Background (incident "DASHSCOPE_API_KEY is not configured" on 6.6.6.74):
  - config.py exposed a `frozen=True` Settings dataclass whose defaults were
    evaluated once at process import time.
  - The Node parent pushes key edits via `update_config()` → Storage writes
    config.json + config.env.
  - Nothing refreshed the frozen Settings object, so asr_proxy/diarize_* kept
    reading the empty startup key even though the new key was on disk.

Fix under test:
  - Settings is now mutable and gains `sync_from(asr)`.
  - Storage._save_config() calls `settings.sync_from(...)` in a `finally`
    after every persist, so disk, Storage._config, and Settings always agree.
"""

from __future__ import annotations

import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
PY_BACKEND = REPO_ROOT / "packages" / "server" / "src" / "modules" / "studio" / "services" / "meeting-asr" / "python-backend"
if str(PY_BACKEND) not in sys.path:
    sys.path.insert(0, str(PY_BACKEND))


class ConfigSyncTest(unittest.TestCase):
    def setUp(self) -> None:
        self._data_dir = tempfile.mkdtemp(prefix="meeting-asr-cfg-")
        self._env_patcher = mock.patch.dict(
            os.environ,
            {"DATA_DIR": self._data_dir, "DASHSCOPE_API_KEY": ""},
            clear=False,
        )
        self._env_patcher.start()
        # Fresh import of the app package under the patched env so module-level
        # state (DATA_DIR, config.env load, Settings()) is rebuilt per test.
        self._app = importlib.import_module("app")
        self._config = importlib.import_module("app.config")
        self._storage = importlib.import_module("app.storage")

    def tearDown(self) -> None:
        self._env_patcher.stop()
        # Drop the modules so the next setUp gets a clean import.
        for name in list(sys.modules):
            if name == "app" or name.startswith("app."):
                del sys.modules[name]

    def _storage_instance(self):
        # storage.py defines a module-level singleton `storage = Storage()` at
        # import time; reuse it (its DATA_DIR is the patched temp dir).
        return self._storage.storage

    def test_hot_push_updates_runtime_settings(self) -> None:
        """The core regression: after update_config with a new key, the
        Settings object that asr_proxy reads must reflect the new key."""
        storage = self._storage_instance()
        self.assertEqual(self._config.settings.dashscope_api_key, "")

        new_key = "sk-hotpush-1234567890abcdef"
        storage.update_config(
            self._config_settings(all_asr={"dashscope_api_key": new_key})
        )

        # Runtime Settings now has the key, no restart involved.
        self.assertEqual(self._config.settings.dashscope_api_key, new_key)
        # Disk and env mirror it too.
        self.assertIn(new_key, (Path(self._data_dir) / "config.json").read_text("utf-8"))
        self.assertIn(f"DASHSCOPE_API_KEY={new_key}", (Path(self._data_dir) / "config.env").read_text("utf-8"))

    def test_merge_does_not_wipe_existing_key_when_field_omitted(self) -> None:
        """update_config with an empty secret must keep the stored key
        (merge semantics), and the runtime Settings must stay in sync."""
        storage = self._storage_instance()
        storage.update_config(
            self._config_settings(all_asr={"dashscope_api_key": "sk-original-abcdef"})
        )
        self.assertEqual(self._config.settings.dashscope_api_key, "sk-original-abcdef")

        # Frontend round-trips config without the secret → must not clobber.
        storage.update_config(
            self._config_settings(all_asr={"dashscope_api_key": ""})
        )
        self.assertEqual(self._config.settings.dashscope_api_key, "sk-original-abcdef")

    def test_update_asr_config_syncs_runtime(self) -> None:
        storage = self._storage_instance()
        storage.update_asr_config(
            self._config_settings(
                {"dashscope_api_key": "sk-asr-only-1234567890"}
            ).asr
        )
        self.assertEqual(self._config.settings.dashscope_api_key, "sk-asr-only-1234567890")

    def test_paraformer_fields_sync_too(self) -> None:
        storage = self._storage_instance()
        storage.update_config(
            self._config_settings(
                all_asr={
                    "dashscope_api_key": "sk-para-1234567890",
                    "paraformer_ws_url": "wss://custom.example.com/inference",
                    "paraformer_model": "paraformer-custom-v9",
                    "paraformer_format": "opus",
                    "paraformer_sample_rate": 24000,
                    "paraformer_language_hints": "en",
                    "paraformer_semantic_punctuation": False,
                }
            )
        )
        s = self._config.settings
        self.assertEqual(s.dashscope_api_key, "sk-para-1234567890")
        self.assertEqual(s.paraformer_ws_url, "wss://custom.example.com/inference")
        self.assertEqual(s.paraformer_model, "paraformer-custom-v9")
        self.assertEqual(s.paraformer_format, "opus")
        self.assertEqual(s.paraformer_sample_rate, 24000)
        self.assertEqual(s.asr_language_hints, "en")
        self.assertFalse(s.paraformer_semantic_punctuation)

    def test_minimax_fields_sync_on_hot_push(self) -> None:
        """The whole-file transcription dialog lets the user run a MiniMax pass
        on a DashScope session, so the hot config push must also carry the
        MiniMax credentials (Node `MeetingASRService.updateConfig`)."""
        storage = self._storage_instance()
        storage.update_config(
            self._config_settings(
                all_asr={
                    "dashscope_api_key": "sk-dash-1234567890",
                    "minimax_api_key": "mm-hotpush-secret",
                    "minimax_asr_model": "asr-1.0",
                    "minimax_base_url": "https://api.minimaxi.com",
                }
            )
        )
        s = self._config.settings
        self.assertEqual(s.dashscope_api_key, "sk-dash-1234567890")
        self.assertEqual(s.minimax_api_key, "mm-hotpush-secret")
        self.assertEqual(s.minimax_asr_model, "asr-1.0")
        self.assertEqual(s.minimax_base_url, "https://api.minimaxi.com")

    def test_minimax_push_without_key_keeps_previous_value(self) -> None:
        """An omitted MiniMax key must not wipe a previously pushed one."""
        storage = self._storage_instance()
        storage.update_config(
            self._config_settings(all_asr={"minimax_api_key": "mm-keep-me"})
        )
        self.assertEqual(self._config.settings.minimax_api_key, "mm-keep-me")

        storage.update_config(
            self._config_settings(
                all_asr={"dashscope_api_key": "sk-dash-only-1234567890"}
            )
        )
        self.assertEqual(self._config.settings.minimax_api_key, "mm-keep-me")

    def _config_settings(self, all_asr: dict | None = None, **kwargs):
        """Build an AllConfig via pydantic, reusing app.models to avoid
        hand-maintaining the shape."""
        from app.models import AllConfig

        asr_kwargs = all_asr or {}
        data = {"asr": asr_kwargs} if asr_kwargs else {}
        data.update({k: v for k, v in kwargs.items() if v is not None})
        # Partial / empty fields are valid; pydantic fills defaults.
        return AllConfig.model_validate(data)


if __name__ == "__main__":
    unittest.main()
