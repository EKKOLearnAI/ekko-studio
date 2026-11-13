"""Offline tests for the stdlib pulse_notify.py CLI: a local fake device only."""
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, HTTPServer
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

import pulse_notify

TOKEN = "b" * 64  # Synthetic test credential.


class FakeDevice:
    def __init__(self):
        self.requests = []
        self.reply = (202, {"ok": True, "status": "queued", "kind": "task_done", "truncated": False, "pending": 1})
        device = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _answer(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                device.requests.append((self.command, self.path, dict(self.headers), body))
                code, document = device.reply
                raw = json.dumps(document).encode()
                self.send_response(code)
                if isinstance(document, dict) and "location" in document:
                    self.send_header("Location", document["location"])
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST = _answer

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.endpoint = "http://127.0.0.1:%d" % self.server.server_address[1]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class CliTests(unittest.TestCase):
    def setUp(self):
        self.device = FakeDevice()
        self.addCleanup(self.device.close)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.connection = Path(self.directory.name) / "pulse-connection.json"
        self.write_connection(self.device.endpoint)

    def write_connection(self, endpoint, mode=0o600):
        self.connection.write_text(json.dumps({"endpoint": endpoint, "control_token": TOKEN}))
        self.connection.chmod(mode)

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            try:
                code = pulse_notify.main(["--connection", str(self.connection), "--timeout", "2", *argv])
            except SystemExit as exit_:
                code = exit_.code
        self.assertNotIn(TOKEN, out.getvalue() + err.getvalue())
        return code, out.getvalue(), err.getvalue()

    def test_done_posts_one_bounded_notice(self):
        code, out, _ = self.run_cli("done", "周报", "写好了", "--id", "run-42")
        self.assertEqual(code, 0)
        self.assertIn("已送到", out)
        self.assertEqual(len(self.device.requests), 1)
        method, path, headers, body = self.device.requests[0]
        self.assertEqual((method, path), ("POST", "/api/notify"))
        self.assertEqual(headers["Authorization"], "Bearer " + TOKEN)
        self.assertEqual(json.loads(body), {"kind": "task_done", "title": "周报 写好了", "source": "Ekko Studio", "id": "run-42"})

    def test_kind_aliases(self):
        for alias, kind in (("failed", "task_failed"), ("error", "task_failed"), ("remind", "reminder"), ("praise", "praise")):
            self.device.requests.clear()
            self.assertEqual(self.run_cli(alias)[0], 0)
            self.assertEqual(json.loads(self.device.requests[0][3])["kind"], kind)

    def test_duplicate_is_success(self):
        self.device.reply = (200, {"ok": True, "status": "duplicate"})
        code, out, _ = self.run_cli("done", "x", "--id", "same")
        self.assertEqual(code, 0)
        self.assertIn("已经送过", out)

    def test_device_refusals_exit_4_with_reason(self):
        for status, words in ((409, "任务提醒"), (429, "太频繁"), (404, "2.8"), (403, "凭据")):
            self.device.reply = (status, {"ok": False, "error": "e " + TOKEN})
            code, _, err = self.run_cli("failed", "构建失败")
            self.assertEqual(code, 4)
            self.assertIn(words, err)

    def test_unknown_success_shape_is_not_success(self):
        self.device.reply = (202, {"ok": True, "status": "displayed"})
        self.assertEqual(self.run_cli("done")[0], 4)

    def test_redirect_is_never_followed(self):
        other = FakeDevice()
        self.addCleanup(other.close)
        self.device.reply = (302, {"location": other.endpoint + "/api/notify"})
        code, _, _ = self.run_cli("done", "x")
        self.assertEqual(code, 4)
        self.assertEqual(other.requests, [])

    def test_proxy_environment_is_ignored(self):
        with patch.dict(os.environ, {"http_proxy": "http://203.0.113.9:9", "HTTP_PROXY": "http://203.0.113.9:9",
                                     "no_proxy": "", "NO_PROXY": ""}):
            self.assertEqual(self.run_cli("done")[0], 0)
        self.assertEqual(len(self.device.requests), 1)

    def test_connection_file_rules(self):
        self.write_connection(self.device.endpoint, 0o644)
        self.assertEqual(self.run_cli("done")[0], 3)
        for endpoint in ("http://8.8.8.8", "http://user:pw@192.168.1.5", "file:///tmp/x", "http://192.168.1.5/api"):
            self.write_connection(endpoint)
            self.assertEqual(self.run_cli("done")[0], 3)
        self.assertEqual(self.device.requests, [])

    def test_usage_errors_before_any_io(self):
        for argv in (("celebrate",), (), ("done", "--id", "has space"), ("done", "--id", "x" * 41),
                     ("done", "--timeout", "0")):
            self.assertEqual(self.run_cli(*argv)[0], 2)
        for argv in (("done", "--source", "s" * 25), ("done", "bad\x07title"), ("done", "长" * 200)):
            self.assertEqual(self.run_cli(*argv)[0], 2)
        self.assertEqual(self.device.requests, [])

    def test_network_error_exit_5(self):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        self.write_connection("http://127.0.0.1:%d" % port)
        code, _, err = self.run_cli("done")
        self.assertEqual(code, 5)
        self.assertIn("没有自动重试", err)

    def test_status_prints_only_care_and_notify(self):
        self.device.reply = (200, {"ok": True, "version": "2.8-companion.1", "care": {"level": "on"},
                                   "notify": {"enabled": True}, "ip": "192.168.1.5", "deviceId": "secret-ish"})
        code, out, _ = self.run_cli("--status")
        self.assertEqual(code, 0)
        shown = json.loads(out)
        self.assertEqual(set(shown), {"version", "care", "notify"})
        self.assertEqual(self.device.requests[0][:2], ("GET", "/api/status"))


if __name__ == "__main__":
    unittest.main()
