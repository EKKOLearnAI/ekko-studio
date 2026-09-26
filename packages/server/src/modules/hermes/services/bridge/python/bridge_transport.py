from __future__ import annotations

import hashlib
import json
import locale
import os
import posixpath
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from bridge_runtime import _hidden_subprocess_kwargs, _json_line_bytes, _platform_text_encoding

class WorkerProcess:
    STARTUP_TIMEOUT_SECONDS = 120
    REQUEST_TIMEOUT_SECONDS = 120
    SHUTDOWN_REQUEST_TIMEOUT_SECONDS = 15

    def __init__(self, key: str, profile: str, endpoint: str, agent_root: str | None, hermes_home: str | None) -> None:
        self.key = key or profile or "default"
        self.profile = profile or "default"
        self.endpoint = endpoint
        self.agent_root = agent_root
        self.hermes_home = hermes_home
        self.process: subprocess.Popen[str] | None = None
        self.last_used_at = time.time()
        self._lock = threading.RLock()

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.poll() is None

    @property
    def pid(self) -> int | None:
        return self.process.pid if self.process is not None else None

    def start(self) -> None:
        with self._lock:
            if self.running:
                return
            args = [
                sys.executable,
                str(Path(__file__).with_name("hermes_bridge.py").resolve()),
                "--endpoint",
                self.endpoint,
                "--worker-profile",
                self.profile,
            ]
            if self.agent_root:
                args.extend(["--agent-root", self.agent_root])
            if self.hermes_home:
                args.extend(["--hermes-home", self.hermes_home])

            env = {
                **os.environ,
                "HERMES_AGENT_BRIDGE_ENDPOINT": self.endpoint,
                "HERMES_AGENT_BRIDGE_WORKER_PROFILE": self.profile,
                "HERMES_AGENT_BRIDGE_BROKER_PID": str(os.getpid()),
            }
            env.pop("ANTHROPIC_AUTH_TOKEN", None)
            self.process = subprocess.Popen(
                args,
                env=env,
                cwd=os.getcwd(),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                **_hidden_subprocess_kwargs(),
            )
            self._pipe_stderr()
            self._wait_ready()

    def _pipe_stderr(self) -> None:
        proc = self.process
        if proc is None or proc.stderr is None:
            return

        def run() -> None:
            assert proc.stderr is not None
            for line in proc.stderr:
                text = line.rstrip()
                if text:
                    print(f"[hermes-bridge-worker:{self.key}] {text}", file=sys.stderr, flush=True)

        threading.Thread(target=run, daemon=True, name=f"hermes-bridge-worker-stderr-{self.key}").start()

    def _wait_ready(self) -> None:
        proc = self.process
        if proc is None or proc.stdout is None:
            raise RuntimeError(f"profile worker {self.key} did not start")
        lines: queue.Queue[str | None] = queue.Queue()
        ready_event = threading.Event()

        def read_stdout() -> None:
            assert proc.stdout is not None
            try:
                for line in proc.stdout:
                    if ready_event.is_set():
                        text = line.rstrip()
                        if text:
                            print(f"[hermes-bridge-worker:{self.key}] {text}", file=sys.stderr, flush=True)
                    else:
                        lines.put(line)
            finally:
                lines.put(None)

        threading.Thread(target=read_stdout, daemon=True, name=f"hermes-bridge-worker-stdout-{self.key}").start()
        deadline = time.time() + self.STARTUP_TIMEOUT_SECONDS
        while time.time() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f"profile worker {self.key} exited before ready")
            try:
                line = lines.get(timeout=0.1)
            except queue.Empty:
                continue
            if line is None:
                time.sleep(0.05)
                continue
            text = line.strip()
            if text:
                print(f"[hermes-bridge-worker:{self.key}] {text}", file=sys.stderr, flush=True)
            try:
                data = json.loads(text)
                if data.get("event") == "ready":
                    ready_event.set()
                    return
            except Exception:
                pass
        self.stop()
        raise RuntimeError(f"profile worker {self.key} did not become ready within {self.STARTUP_TIMEOUT_SECONDS}s")

    def stop(self) -> None:
        with self._lock:
            proc = self.process
            self.process = None
        if proc is None:
            return
        if proc.poll() is None:
            try:
                self.request({"action": "shutdown"}, timeout=self.SHUTDOWN_REQUEST_TIMEOUT_SECONDS)
            except Exception as exc:
                print(f"[hermes-bridge-worker:{self.key}] graceful shutdown failed: {exc}", file=sys.stderr, flush=True)
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=3)
        if self.endpoint.startswith("ipc://"):
            try:
                Path(self.endpoint.removeprefix("ipc://")).unlink(missing_ok=True)
            except OSError:
                pass

    def request(self, req: dict[str, Any], timeout: float | None = None) -> dict[str, Any]:
        self.start()
        self.last_used_at = time.time()
        request_timeout = timeout if timeout is not None and timeout > 0 else self.REQUEST_TIMEOUT_SECONDS
        return _send_bridge_request(self.endpoint, req, request_timeout)


# Unix-domain socket paths are limited by sun_path (macOS/BSD: 104 bytes,
# Linux: 108 bytes, including the trailing NUL). Keep a small safety margin.
_AF_UNIX_MAX_PATH = 104 if sys.platform == "darwin" else 108


def _worker_endpoint(key: str, namespace: str | None = None) -> str:
    namespace_key = f"{namespace or ''}\0{key}"
    safe = hashlib.sha256(namespace_key.encode("utf-8")).hexdigest()[:16]
    transport = os.environ.get("HERMES_AGENT_BRIDGE_WORKER_TRANSPORT", "").strip().lower()
    forced_ipc = transport in {"ipc", "unix"}
    use_tcp = transport == "tcp" or (transport not in {"ipc", "unix"} and os.name == "nt")
    if not use_tcp:
        # Join as text when the process is not Windows. pathlib.Path follows the
        # host flavour, and Python 3.13+ refuses to build a PosixPath on Windows
        # even when a caller is simulating a posix temp directory.
        sock_path = (
            str(Path(tempfile.gettempdir()) / "hermes-agent-bridge-workers" / f"{safe}.sock")
            if os.name == "nt"
            else posixpath.join(tempfile.gettempdir(), "hermes-agent-bridge-workers", f"{safe}.sock")
        )
        # A deep temp dir can push the socket path past the platform's sun_path
        # limit; the worker then fails to bind and exits before it can report
        # ready (surfaced as "profile worker ... exited before ready"). Fall
        # back to a TCP endpoint in that case.
        if forced_ipc or len(os.fsencode(str(sock_path))) < _AF_UNIX_MAX_PATH - 1:
            return f"ipc://{sock_path}"
        use_tcp = True
    if use_tcp:
        port_base = int(os.environ.get("HERMES_AGENT_BRIDGE_WORKER_PORT_BASE", "18780"))
        port_offset = int(safe[:4], 16) % 1000
        port = port_base + port_offset
        # Windows can reserve/exclude ports in the dynamic range (49152-65535).
        # Desktop/runtime environments may provide a high worker port base; adding
        # the per-worker hash can then choose an excluded port and make the
        # profile worker exit before it can report ready. Prefer the known-safe
        # default range when the final worker port would fall in that dynamic
        # range.
        if os.name == "nt" and port >= 49152:
            port = 18780 + port_offset
        return f"tcp://127.0.0.1:{port}"
    root = Path(tempfile.gettempdir()) / "hermes-agent-bridge-workers"
    return f"ipc://{root / f'{safe}.sock'}"


def _connect_bridge_socket(endpoint: str, timeout: float) -> socket.socket:
    if endpoint.startswith("ipc://"):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect(endpoint.removeprefix("ipc://"))
        return sock
    parsed = urlparse(endpoint)
    if parsed.scheme != "tcp":
        raise RuntimeError(f"unsupported endpoint scheme: {endpoint}")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    sock.connect((parsed.hostname or "127.0.0.1", int(parsed.port or 0)))
    return sock


def _send_bridge_request(endpoint: str, req: dict[str, Any], timeout: float) -> dict[str, Any]:
    sock = _connect_bridge_socket(endpoint, timeout)
    try:
        sock.sendall(_json_line_bytes(req))
        chunks: list[bytes] = []
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
            if b"\n" in chunk:
                break
        line = b"".join(chunks).split(b"\n", 1)[0].strip()
        if not line:
            raise RuntimeError("worker closed without a response")
        resp = json.loads(line.decode("utf-8"))
        if not resp.get("ok"):
            raise RuntimeError(str(resp.get("error") or "worker request failed"))
        return resp
    finally:
        try:
            sock.close()
        except OSError:
            pass


def _tcp_endpoint_port(endpoint: str) -> int | None:
    parsed = urlparse(endpoint)
    if parsed.scheme != "tcp":
        return None
    try:
        port = int(parsed.port or 0)
        return port if port > 0 else None
    except (TypeError, ValueError):
        return None


def _platform_text_encoding() -> str:
    getencoding = getattr(locale, "getencoding", None)
    if callable(getencoding):
        return getencoding() or "utf-8"
    return locale.getpreferredencoding(False) or "utf-8"


def _windows_listening_pids_on_port(port: int) -> list[int]:
    if os.name != "nt":
        return []
    try:
        result = subprocess.run(
            ["netstat.exe", "-ano", "-p", "tcp"],
            check=False,
            capture_output=True,
            text=True,
            encoding=_platform_text_encoding(),
            errors="ignore",
            timeout=5,
            **_hidden_subprocess_kwargs(),
        )
    except Exception:
        return []
    stdout = result.stdout or ""
    pids: set[int] = set()
    for line in stdout.splitlines():
        parts = line.strip().split()
        if len(parts) < 5:
            continue
        proto, local_address, _remote_address, state, pid_raw = parts[:5]
        if proto.upper() != "TCP" or state.upper() != "LISTENING":
            continue
        if not local_address.endswith(f":{port}"):
            continue
        try:
            pid = int(pid_raw)
        except ValueError:
            continue
        if pid > 0 and pid != os.getpid():
            pids.add(pid)
    return sorted(pids)


def _kill_windows_endpoint_occupants(endpoint: str) -> None:
    if os.name != "nt":
        return
    port = _tcp_endpoint_port(endpoint)
    if not port:
        return
    for pid in _windows_listening_pids_on_port(port):
        try:
            print(
                f"[hermes-bridge] killing stale process tree pid={pid} port={port}",
                file=sys.stderr,
                flush=True,
            )
            subprocess.run(
                ["taskkill.exe", "/PID", str(pid), "/T", "/F"],
                check=False,
                capture_output=True,
                text=True,
                encoding=_platform_text_encoding(),
                errors="ignore",
                timeout=10,
                **_hidden_subprocess_kwargs(),
            )
        except Exception as exc:
            print(
                f"[hermes-bridge] failed to kill stale process pid={pid}: {exc}",
                file=sys.stderr,
                flush=True,
            )
    deadline = time.time() + 3
    while time.time() < deadline:
        if not _windows_listening_pids_on_port(port):
            return
        time.sleep(0.1)


def _make_listen_socket(endpoint: str) -> socket.socket:
    _kill_windows_endpoint_occupants(endpoint)
    if endpoint.startswith("ipc://"):
        if not hasattr(socket, "AF_UNIX"):
            raise RuntimeError("ipc:// endpoints require Unix domain socket support; use tcp://host:port on this platform")
        sock_path = Path(endpoint.removeprefix("ipc://"))
        sock_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            sock_path.unlink(missing_ok=True)
        except OSError:
            pass
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(sock_path))
        return server

    parsed = urlparse(endpoint)
    if parsed.scheme != "tcp":
        raise RuntimeError(f"unsupported endpoint scheme: {endpoint}")
    host = parsed.hostname or "127.0.0.1"
    port = int(parsed.port or 0)
    if port <= 0:
        raise RuntimeError(f"tcp endpoint requires a port: {endpoint}")
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((host, port))
    return server


def _read_json_request(conn: socket.socket) -> dict[str, Any]:
    chunks: list[bytes] = []
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            break
        chunks.append(chunk)
        if b"\n" in chunk:
            break
    if not chunks:
        raise RuntimeError("empty request")
    line = b"".join(chunks).split(b"\n", 1)[0].strip()
    if not line:
        raise RuntimeError("empty request")
    return json.loads(line.decode("utf-8"))


def _write_json_response(conn: socket.socket, resp: dict[str, Any]) -> None:
    conn.sendall(_json_line_bytes(resp))
