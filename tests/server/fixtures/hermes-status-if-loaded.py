"""status_if_loaded treats a dead or unreachable worker socket as an unloaded session."""
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'packages/server/src/modules/hermes/services/bridge/python'))
import hermes_bridge

COLD = {'ok': True, 'session_id': 's1', 'exists': False, 'running': False, 'loaded': False}


class FakeWorker:
    running = True

    def __init__(self, outcome):
        self.outcome = outcome
        self.calls = []

    def request(self, req, timeout=None, *, start_if_needed=True):
        self.calls.append((req, start_if_needed))
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return dict(self.outcome)


class StatusIfLoadedTests(unittest.TestCase):
    def broker(self, outcome):
        broker = hermes_bridge.BridgeBroker('unix:///nonexistent.sock')
        worker = FakeWorker(outcome)
        broker._workers['default'] = worker
        broker._session_profile['s1'] = 'default'
        broker._session_worker_key['s1'] = 'default'
        return broker, worker

    def test_socket_errors_are_unloaded(self):
        for error in (FileNotFoundError(2, 'No such file or directory'), ConnectionRefusedError(111, 'refused')):
            with self.subTest(error=type(error).__name__):
                broker, worker = self.broker(error)
                self.assertEqual(broker.handle({'action': 'status_if_loaded', 'session_id': 's1'}), COLD)
                self.assertFalse(worker.calls[0][1])

    def test_ambiguous_communication_errors_are_not_unloaded(self):
        for error in (ConnectionResetError(104, 'reset'), PermissionError(13, 'denied'), TimeoutError('timed out'), BrokenPipeError(32, 'pipe')):
            with self.subTest(error=type(error).__name__):
                broker, _ = self.broker(error)
                resp = broker.handle({'action': 'status_if_loaded', 'session_id': 's1'})
                self.assertFalse(resp['ok'])
                self.assertIn('worker status unavailable', resp['error'])
                self.assertNotIn('loaded', resp)
                self.assertNotIn('running', resp)

    def test_skipped_worker_is_unloaded(self):
        broker, _ = self.broker({'ok': True, 'skipped': True})
        self.assertEqual(broker._status_if_loaded({'session_id': 's1'}), COLD)

    def test_loaded_worker_status_passes_through(self):
        broker, _ = self.broker({'ok': True, 'session_id': 's1', 'exists': True, 'running': False})
        resp = broker._status_if_loaded({'session_id': 's1'})
        self.assertTrue(resp['loaded'])
        self.assertTrue(resp['exists'])

    def test_runtime_error_still_reported(self):
        broker, _ = self.broker(RuntimeError('boom'))
        self.assertEqual(broker._status_if_loaded({'session_id': 's1'}), {'ok': False, 'error': 'boom'})

    def test_facade_worker_accepts_start_if_needed(self):
        worker = hermes_bridge.WorkerProcess.__new__(hermes_bridge.WorkerProcess)
        worker._lock = threading.RLock()
        worker.active_requests = 0
        with patch.object(hermes_bridge.WorkerProcess, 'running', False):
            self.assertEqual(worker.request({'action': 'status'}, start_if_needed=False), {'ok': True, 'skipped': True})


if __name__ == '__main__':
    unittest.main()
