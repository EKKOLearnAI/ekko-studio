import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/server/src/modules/hermes/services/bridge/python'))
from bridge_broker import BridgeBroker


class FakeWorker:
    def __init__(self, key, profile, *args):
        self.key = key
        self.profile = profile
        self.running = True
        self.pid = 12345
        self.endpoint = 'fake'
        self.last_used_at = time.time()
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.stopped = False
        self.response = {'session_id': 's', 'run_id': 'r', 'status': 'running'}

    def request(self, req, timeout=None):
        if req['action'] == 'chat':
            self.entered.set()
            if not self.release.wait(5):
                raise RuntimeError('test worker timed out')
            return self.response
        return {'destroyed': 1}

    def stop(self):
        self.running = False
        self.stopped = True


class WorkerLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.broker = BridgeBroker('tcp://127.0.0.1:1')
        self.worker = FakeWorker('p', 'p')
        self.broker._workers['p'] = self.worker

    def start_chat(self):
        self.worker.release.clear()
        self.result = {}
        def run():
            try:
                self.result['response'] = self.broker.handle({'action': 'chat', 'profile': 'p', 'session_id': 's'})
            except Exception as exc:
                self.result['error'] = exc
        thread = threading.Thread(target=run)
        thread.start()
        self.addCleanup(self.finish_chat, thread)
        self.assertTrue(self.worker.entered.wait(5))
        return thread

    def finish_chat(self, thread):
        self.worker.release.set()
        thread.join(5)
        self.assertFalse(thread.is_alive())

    def test_ping_counts_pending_chat_for_its_profile(self):
        thread = self.start_chat()
        status = self.broker.handle({'action': 'ping'})
        self.assertEqual(status['running_sessions'], 1)
        self.assertEqual(status['running_sessions_by_profile']['p'], 1)
        self.finish_chat(thread)
        self.assertEqual(self.broker.handle({'action': 'ping'})['running_sessions'], 1)
        self.assertEqual(self.broker._starting_session_requests, {})

    def test_destroy_rejects_pending_chat_without_removing_routes(self):
        self.start_chat()
        with self.assertRaisesRegex(ValueError, 'running|starting'):
            self.broker.handle({'action': 'destroy_profile', 'profile': 'p'})
        self.assertFalse(self.worker.stopped)
        self.assertIs(self.broker._workers['p'], self.worker)
        self.assertEqual(self.broker._session_profile['s'], 'p')

    def test_destroy_rejects_reservation_before_worker_creation(self):
        self.broker._workers.clear()
        entered, release = threading.Event(), threading.Event()
        original = self.broker._worker_for_profile
        def delayed(*args):
            entered.set()
            self.assertTrue(release.wait(5))
            return original(*args)
        def create(key, profile, *args):
            self.worker.key = key
            self.worker.release.set()
            return self.worker
        with patch.object(self.broker, '_worker_for_profile', side_effect=delayed), patch('bridge_broker.WorkerProcess', side_effect=create):
            thread = threading.Thread(target=lambda: self.broker.handle({'action': 'chat', 'profile': 'p', 'session_id': 's'}))
            thread.start()
            try:
                self.assertTrue(entered.wait(5))
                with self.assertRaisesRegex(ValueError, 'running|starting'):
                    self.broker.handle({'action': 'destroy_profile', 'profile': 'p'})
            finally:
                release.set()
                thread.join(5)
            self.assertFalse(thread.is_alive())

    def test_destroy_running_profile_fails_but_other_idle_profile_can_restart(self):
        self.broker._running_run_profile['r'] = 'p'
        self.broker._running_run_worker_key['r'] = 'p'
        other = FakeWorker('q', 'q')
        self.broker._workers['q'] = other
        with self.assertRaisesRegex(ValueError, 'running|starting'):
            self.broker.handle({'action': 'destroy_profile', 'profile': 'p'})
        self.assertEqual(self.broker.handle({'action': 'destroy_profile', 'profile': 'q'}), {'profile': 'q', 'destroyed': 1})
        self.assertTrue(other.stopped)
        self.assertFalse(self.worker.stopped)
        self.assertEqual(self.broker._running_run_profile, {'r': 'p'})

    def test_destroy_blocks_same_profile_insertion_until_old_worker_stops(self):
        entered, release = threading.Event(), threading.Event()
        def stop():
            entered.set()
            self.assertTrue(release.wait(5))
            self.worker.stopped = True
        self.worker.stop = stop
        thread = threading.Thread(target=lambda: self.broker.handle({'action': 'destroy_profile', 'profile': 'p'}))
        thread.start()
        try:
            self.assertTrue(entered.wait(5))
            with patch('bridge_broker.WorkerProcess', side_effect=FakeWorker):
                with self.assertRaisesRegex(ValueError, 'restart|stopping|destroy'):
                    self.broker.handle({'action': 'chat', 'profile': 'p', 'session_id': 'new'})
                self.assertNotIn('new', self.broker._session_profile)
                self.assertEqual(self.broker._workers, {})
                self.assertEqual(self.broker.handle({'action': 'worker_ping', 'profile': 'q'})['worker_profile'], 'q')
        finally:
            release.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        with patch('bridge_broker.WorkerProcess', side_effect=FakeWorker):
            self.broker.handle({'action': 'worker_ping', 'profile': 'p'})
        self.assertTrue(any(worker.profile == 'p' for worker in self.broker._workers.values()))

    def test_stop_cannot_be_undone_by_late_chat_response(self):
        self.worker.response['events'] = [
            {'approval_id': 'a', 'clarify_id': 'c'},
            {'event': 'bridge.compression.requested', 'request_id': 'compression'},
        ]
        thread = self.start_chat()
        self.broker.stop()
        self.finish_chat(thread)
        for routes in (self.broker._session_profile, self.broker._run_profile,
                       self.broker._running_run_profile, self.broker._approval_profile,
                       self.broker._clarify_profile, self.broker._compression_profile):
            self.assertEqual(routes, {})
        self.assertEqual(self.broker.handle({'action': 'ping'})['running_sessions'], 0)

    def test_replaced_worker_cannot_register_late_status_routes(self):
        self.broker._session_profile['s'] = 'p'
        self.broker._session_worker_key['s'] = 'p'
        entered, release = threading.Event(), threading.Event()
        original = self.worker.request
        def request(req, timeout=None):
            if req['action'] == 'status':
                entered.set()
                self.assertTrue(release.wait(5))
                return {'session_id': 's', 'run_id': 'old-run', 'status': 'running'}
            return original(req, timeout)
        self.worker.request = request
        thread = threading.Thread(target=lambda: self.broker.handle({'action': 'status_if_loaded', 'profile': 'p', 'session_id': 's'}))
        thread.start()
        try:
            self.assertTrue(entered.wait(5))
            self.broker.handle({'action': 'destroy_profile', 'profile': 'p'})
            self.broker._workers['p'] = FakeWorker('p', 'p')
        finally:
            release.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.broker._run_profile, {})
        self.assertEqual(self.broker._session_profile, {})

    def test_failed_chat_releases_busy_reservation(self):
        with patch.object(self.worker, 'request', side_effect=RuntimeError('fixture failure')):
            self.assertEqual(self.broker.handle({'action': 'chat', 'profile': 'p', 'session_id': 's'}), {'ok': False, 'error': 'fixture failure'})
        self.assertEqual(self.broker._starting_session_requests, {})
        self.assertEqual(self.broker.handle({'action': 'ping'})['running_sessions'], 0)
        self.broker.handle({'action': 'destroy_profile', 'profile': 'p'})


if __name__ == '__main__':
    unittest.main()