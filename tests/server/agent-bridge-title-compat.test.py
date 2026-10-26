"""Hermes title API regression tests; no installed Hermes or providers required."""
import contextlib
import importlib
import io
import json
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import patch

BRIDGE_DIR = Path(__file__).resolve().parents[2] / "packages/server/src/modules/hermes/services/bridge/python"
sys.path.insert(0, str(BRIDGE_DIR))
bridge = importlib.import_module("bridge_pool")


class TitleCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.pool = bridge.AgentPool()
        self.session = bridge.AgentSession("session-1", types.SimpleNamespace(api_key="secret-provider-key"))
        self.record = bridge.RunRecord("run-1", "session-1")
        self.pool._sessions["session-1"] = self.session
        self.db = object()
        self.history = [{"role": "user", "content": "中文问题"}, {"role": "assistant", "content": "answer"}]
        self.module = types.ModuleType("agent.title_generator")
        agent = types.ModuleType("agent")
        agent.__path__ = []
        agent.title_generator = self.module
        self.modules = patch.dict(sys.modules, {"agent": agent, "agent.title_generator": self.module})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.stderr = io.StringIO()
        self.redirect = contextlib.redirect_stderr(self.stderr)
        self.redirect.__enter__()
        self.addCleanup(self.redirect.__exit__, None, None, None)

    def invoke(self, generate):
        self.module.maybe_auto_title = generate
        self.pool._maybe_auto_title(self.session, self.record, self.db, [{"type": "text", "text": "中文问题"}], "answer", self.history)

    def assert_success(self):
        self.assertFalse(any(event["event"] == "session.title.failed" for event in self.record.events))
        self.assertEqual(self.stderr.getvalue(), "")

    def assert_failure(self):
        self.assertEqual(self.record.events, [{"event": "session.title.failed", "session_id": "session-1", "reason": "title_generation_failed"}])
        self.assertEqual(self.stderr.getvalue(), "[hermes_bridge] auto-title failed\n")
        self.assertNotIn("secret-provider-key", json.dumps(self.record.events) + self.stderr.getvalue())
        self.assertEqual(self.record.status, "running")

    def test_old_signature_preserves_response_history_and_one_argument_callback(self):
        calls = []
        def old(session_db, session_id, user_message, assistant_response,
                conversation_history=None, failure_callback=None, main_runtime=None, title_callback=None):
            calls.append((session_db, session_id, user_message, assistant_response, conversation_history, main_runtime))
            title_callback("  旧标题  ")
        self.invoke(old)
        self.assertEqual(len(calls), 1)
        db, sid, prompt, response, history, runtime = calls[0]
        self.assertIs(getattr(db, "__wrapped__", db), self.db)
        self.assertEqual(sid, "session-1")
        self.assertIn("中文问题", prompt)
        self.assertIn("Title language", prompt)
        self.assertEqual(response, "answer")
        self.assertIs(history, self.history)
        self.assertEqual(runtime["api_key"], "secret-provider-key")
        self.assertEqual(self.record.events, [{"event": "session.title.updated", "session_id": "session-1", "run_id": "run-1", "title": "旧标题"}])
        self.assert_success()

    def test_new_signature_binds_history_once_and_accepts_source(self):
        calls = []
        def new(session_db, session_id, user_message, conversation_history=None,
                failure_callback=None, main_runtime=None, title_callback=None,
                runtime_validator=None, title_preview=None):
            calls.append(conversation_history)
            self.assertIsNone(runtime_validator)
            self.assertIsNone(title_preview)
            title_callback("即时标题", "derived")
            title_callback("升级标题", source="llm")
            title_callback("   ", "llm")
        self.invoke(new)
        self.assertEqual(calls, [self.history])
        self.assertEqual([e["source"] for e in self.record.events], ["derived", "llm"])
        self.assert_success()

    def test_minimal_legacy_api_omits_unsupported_options(self):
        calls = []
        def minimal(db, sid, message, assistant_response):
            calls.append(assistant_response)
        self.invoke(minimal)
        self.assertEqual(calls, ["answer"])
        self.assert_success()

    def test_keyword_only_options_and_extra_kwargs(self):
        calls = []
        def generate(db, sid, message, *, conversation_history=None, **kwargs):
            calls.append(conversation_history)
            self.assertNotIn("assistant_response", kwargs)
            kwargs["title_callback"]("title", "secret-provider-key")
        self.invoke(generate)
        self.assertEqual(calls, [self.history])
        self.assertNotIn("source", self.record.events[0])
        self.assert_success()

    def test_positional_only_legacy_parameters(self):
        calls = []
        def generate(db, sid, message, assistant_response, conversation_history=None, /):
            calls.append((assistant_response, conversation_history))
        self.invoke(generate)
        self.assertEqual(calls, [("answer", self.history)])
        self.assert_success()

    def test_internal_type_error_is_not_retried_or_leaked(self):
        calls = []
        def generate(db, sid, message, **kwargs):
            calls.append(sid)
            raise TypeError("provider https://secret-provider-key@example.test")
        self.invoke(generate)
        self.assertEqual(calls, ["session-1"])
        self.assert_failure()

    def test_incompatible_signature_fails_before_invocation(self):
        calls = []
        def generate(db, sid, message, unknown_required):
            calls.append(sid)
        self.invoke(generate)
        self.assertEqual(calls, [])
        self.assert_failure()

    def test_uninspectable_api_fails_closed(self):
        calls = []
        class Uninspectable:
            __signature__ = "secret-provider-key"
            def __call__(self, *args, **kwargs):
                calls.append(args)
        self.invoke(Uninspectable())
        self.assertEqual(calls, [])
        self.assert_failure()

    def test_failure_callback_is_safe_for_async_provider_payloads(self):
        callbacks = []
        def generate(db, sid, message, failure_callback=None):
            callbacks.append(failure_callback)
        self.invoke(generate)
        # The failure may arrive after the bridge's run has completed.
        self.record.status = "complete"
        callbacks[0]("secret-provider-key", error=RuntimeError("secret-provider-key"))
        self.assertEqual(self.record.status, "complete")
        self.assertEqual(self.record.events[0]["event"], "session.title.failed")
        self.assertNotIn("secret-provider-key", json.dumps(self.record.events) + self.stderr.getvalue())

    def test_deferred_upgrade_uses_runtime_starter_exactly_once(self):
        done = threading.Event()
        upgrade = threading.Thread(target=done.set, daemon=True)
        starts = []
        def start(thread):
            starts.append(thread)
            thread.start()
        self.module.start_title_upgrade = start
        self.invoke(lambda db, sid, message: upgrade)
        upgrade.join(timeout=2)
        self.assertTrue(done.is_set())
        self.assertEqual(starts, [upgrade])
        self.assert_success()

    def test_deferred_callback_can_update_a_completed_run(self):
        upgrades = []
        def generate(db, sid, message, title_callback=None, future_option="default"):
            self.assertEqual(future_option, "default")
            upgrade = threading.Thread(target=lambda: title_callback("升级标题", "llm"), daemon=True)
            upgrades.append(upgrade)
            return upgrade
        self.record.status = "complete"
        self.invoke(generate)
        upgrades[0].join(timeout=2)
        self.assertEqual(self.record.events, [{"event": "session.title.updated", "session_id": "session-1", "run_id": "run-1", "title": "升级标题", "source": "llm"}])
        self.assertEqual(self.record.status, "complete")
        self.assert_success()

    def test_deferred_upgrade_without_starter_has_thread_fallback(self):
        done = threading.Event()
        upgrade = threading.Thread(target=done.set, daemon=True)
        self.invoke(lambda db, sid, message: upgrade)
        upgrade.join(timeout=2)
        self.assertTrue(done.is_set())
        self.assert_success()

    def test_running_and_finished_threads_are_not_restarted(self):
        release = threading.Event()
        upgrade = threading.Thread(target=lambda: release.wait(2), daemon=True)
        self.module.start_title_upgrade = lambda thread: self.fail("already started")
        upgrade.start()
        try:
            self.invoke(lambda db, sid, message: upgrade)
        finally:
            release.set()
            upgrade.join(timeout=2)
        self.invoke(lambda db, sid, message: upgrade)
        self.assert_success()

    def test_starter_error_is_nonfatal_and_sanitized(self):
        upgrade = threading.Thread(target=lambda: None)
        def start(thread):
            raise RuntimeError("secret-provider-key")
        self.module.start_title_upgrade = start
        self.invoke(lambda db, sid, message: upgrade)
        self.assertIsNone(upgrade.ident)
        self.assert_failure()

    def test_missing_title_module_is_nonfatal_and_observable(self):
        with patch.dict(sys.modules, {"agent.title_generator": None}):
            del sys.modules["agent"].title_generator
            self.pool._maybe_auto_title(self.session, self.record, self.db, "hello", "answer", [])
        self.assert_failure()


    def test_title_poll_reports_an_atomic_callback_record(self):
        def generate(db, sid, message, title_callback=None):
            title_callback("summary", "llm")
        self.invoke(generate)
        self.pool._db = types.SimpleNamespace(get_for_profile=lambda profile: self.fail("must not read title/source separately"))
        self.assertEqual(self.pool.get_session_title("session-1", "p"), {
            "session_id": "session-1", "title": "summary", "source": "llm", "run_id": "run-1",
        })

    def test_title_poll_remains_compatible_with_legacy_stores(self):
        self.pool._db = types.SimpleNamespace(get_for_profile=lambda profile: types.SimpleNamespace(
            get_session_title=lambda sid: "legacy summary",
        ))
        self.assertEqual(self.pool.get_session_title("session-1"), {
            "session_id": "session-1", "title": "legacy summary",
        })

    def test_title_poll_does_not_expose_unknown_source_metadata(self):
        self.pool._db = types.SimpleNamespace(get_for_profile=lambda profile: types.SimpleNamespace(
            get_session_title=lambda sid: "summary",
            get_session_title_source=lambda sid: "secret-provider-key",
        ))
        result = self.pool.get_session_title("session-1")
        self.assertNotIn("source", result)
        self.assertNotIn("secret-provider-key", json.dumps(result))

    def test_old_producer_cannot_write_or_notify_a_new_generation(self):
        saved = []
        writes = []
        self.db = types.SimpleNamespace(set_auto_title=lambda *args, **kwargs: writes.append(args) or True)
        def generate(db, sid, message, title_callback=None):
            saved.append((db, title_callback))
        self.invoke(generate)
        self.session.title_generation = "new-run"
        self.session.title_update = None
        db, callback = saved[0]
        self.assertFalse(db.set_auto_title("session-1", "stale", source="llm"))
        callback("stale", "llm")
        self.assertEqual(writes, [])
        self.assertEqual(self.record.events, [])
        self.assertEqual(self.pool.get_session_title("session-1"), {"session_id": "session-1", "title": "", "run_id": "new-run"})

    def test_destroyed_and_recreated_session_rejects_old_producer(self):
        saved = []
        self.db = types.SimpleNamespace(set_session_title=lambda *args: self.fail("stale write"))
        def generate(db, sid, message, title_callback=None):
            saved.append((db, title_callback))
        self.invoke(generate)
        self.pool._sessions["session-1"] = bridge.AgentSession("session-1", object())
        self.assertFalse(saved[0][0].set_session_title("session-1", "stale"))
        saved[0][1]("stale", "llm")
        self.assertEqual(self.record.events, [])

if __name__ == "__main__":
    unittest.main()
