from __future__ import annotations

import atexit
import json
import os
import socket
import sys
import threading
import time
from pathlib import Path
from typing import Any

from bridge_runtime import _install_stop_signal_handlers, _jsonable
from bridge_transport import (
    WorkerProcess,
    _make_listen_socket,
    _read_json_request,
    _worker_endpoint,
    _write_json_response,
)

class BridgeBroker:
    IDLE_TIMEOUT_SECONDS = 30 * 60
    GC_INTERVAL_SECONDS = 60

    def __init__(self, endpoint: str, agent_root: str | None = None, hermes_home: str | None = None) -> None:
        self.endpoint = endpoint
        self.agent_root = agent_root
        self.hermes_home = hermes_home
        self._workers: dict[str, WorkerProcess] = {}
        self._run_profile: dict[str, str] = {}
        self._run_worker_key: dict[str, str] = {}
        self._running_run_profile: dict[str, str] = {}
        self._running_run_worker_key: dict[str, str] = {}
        self._session_profile: dict[str, str] = {}
        self._session_worker_key: dict[str, str] = {}
        self._approval_profile: dict[str, str] = {}
        self._approval_worker_key: dict[str, str] = {}
        self._clarify_profile: dict[str, str] = {}
        self._clarify_worker_key: dict[str, str] = {}
        self._compression_profile: dict[str, str] = {}
        self._compression_worker_key: dict[str, str] = {}
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._last_gc = time.time()

    def _normalize_profile(self, value: Any) -> str:
        profile = str(value or "").strip()
        return profile or "default"

    def _normalize_worker_key(self, profile: str, value: Any = None) -> str:
        worker_key = str(value or "").strip()
        return worker_key or profile

    def _worker_for_profile(self, profile: str, worker_key: str | None = None) -> WorkerProcess:
        profile = self._normalize_profile(profile)
        key = self._normalize_worker_key(profile, worker_key)
        with self._lock:
            worker = self._workers.get(key)
            if worker is None:
                worker = WorkerProcess(key, profile, _worker_endpoint(key, self.endpoint), self.agent_root, self.hermes_home)
                self._workers[key] = worker
        return worker

    def _route_for_run(self, run_id: str) -> tuple[str, str | None]:
        with self._lock:
            profile = self._run_profile.get(run_id)
            worker_key = self._run_worker_key.get(run_id)
        if not profile:
            raise KeyError(f"unknown run: {run_id}")
        return profile, worker_key

    def _route_for_session(self, session_id: str, fallback_profile: Any = None, worker_key: Any = None) -> tuple[str, str | None]:
        with self._lock:
            profile = self._session_profile.get(session_id)
            stored_worker_key = self._session_worker_key.get(session_id)
        if not profile:
            fallback = self._normalize_profile(fallback_profile)
            if fallback_profile is not None and fallback:
                return fallback, self._normalize_worker_key(fallback, worker_key)
            raise KeyError(f"unknown session: {session_id}")
        return profile, self._normalize_worker_key(profile, worker_key) if worker_key is not None else stored_worker_key

    def _record_response_routes(self, profile: str, worker_key: str, resp: dict[str, Any]) -> None:
        run_id = str(resp.get("run_id") or "")
        session_id = str(resp.get("session_id") or "")
        with self._lock:
            if run_id:
                self._run_profile[run_id] = profile
                self._run_worker_key[run_id] = worker_key
                if resp.get("status") == "running":
                    self._running_run_profile[run_id] = profile
                    self._running_run_worker_key[run_id] = worker_key
                else:
                    self._running_run_profile.pop(run_id, None)
                    self._running_run_worker_key.pop(run_id, None)
            if session_id:
                self._session_profile[session_id] = profile
                self._session_worker_key[session_id] = worker_key
            for event in resp.get("events") or []:
                if not isinstance(event, dict):
                    continue
                approval_id = str(event.get("approval_id") or "")
                if approval_id:
                    self._approval_profile[approval_id] = profile
                    self._approval_worker_key[approval_id] = worker_key
                clarify_id = str(event.get("clarify_id") or "")
                if clarify_id:
                    self._clarify_profile[clarify_id] = profile
                    self._clarify_worker_key[clarify_id] = worker_key
                request_id = str(event.get("request_id") or "")
                if event.get("event") == "bridge.compression.requested" and request_id:
                    self._compression_profile[request_id] = profile
                    self._compression_worker_key[request_id] = worker_key
                if event.get("event") in {"bridge.compression.completed", "bridge.compression.failed"} and request_id:
                    self._compression_profile.pop(request_id, None)
                    self._compression_worker_key.pop(request_id, None)

    def stop(self) -> None:
        self._stop.set()
        with self._lock:
            workers = list(self._workers.values())
            self._workers.clear()
            self._run_profile.clear()
            self._run_worker_key.clear()
            self._running_run_profile.clear()
            self._running_run_worker_key.clear()
            self._session_profile.clear()
            self._session_worker_key.clear()
            self._approval_profile.clear()
            self._approval_worker_key.clear()
            self._clarify_profile.clear()
            self._clarify_worker_key.clear()
            self._compression_profile.clear()
            self._compression_worker_key.clear()
        for worker in workers:
            worker.stop()

    def _forward(self, profile: str, req: dict[str, Any], worker_key: str | None = None) -> dict[str, Any]:
        profile = self._normalize_profile(profile)
        key = self._normalize_worker_key(profile, worker_key)
        worker = self._worker_for_profile(profile, key)
        forwarded = dict(req)
        forwarded["profile"] = profile
        forwarded.pop("worker_key", None)
        try:
            resp = worker.request(forwarded, self._worker_request_timeout(req))
            self._record_response_routes(profile, key, resp)
            return resp
        except RuntimeError as e:
            # Worker returned ok=false or connection error — return error response
            return {"ok": False, "error": str(e)}

    def _worker_request_timeout(self, req: dict[str, Any]) -> float:
        try:
            timeout = float(req.get("timeout", 0) or 0)
        except (TypeError, ValueError):
            timeout = 0
        if timeout <= 0:
            return WorkerProcess.REQUEST_TIMEOUT_SECONDS
        return max(WorkerProcess.REQUEST_TIMEOUT_SECONDS, timeout + 10)

    def _status_if_loaded(self, req: dict[str, Any]) -> dict[str, Any]:
        session_id = str(req.get("session_id") or "")
        with self._lock:
            profile = self._session_profile.get(session_id)
            worker_key = self._session_worker_key.get(session_id)
            if profile:
                key = self._normalize_worker_key(profile, req.get("worker_key")) if "worker_key" in req else worker_key
            else:
                fallback_profile = req.get("profile")
                if fallback_profile is None:
                    return {"ok": True, "session_id": session_id, "exists": False, "running": False, "loaded": False}
                profile = self._normalize_profile(fallback_profile)
                key = self._normalize_worker_key(profile, req.get("worker_key") if "worker_key" in req else None)
            worker = self._workers.get(key or profile)

        if worker is None or not getattr(worker, "running", False):
            return {"ok": True, "session_id": session_id, "exists": False, "running": False, "loaded": False}

        forwarded = dict(req)
        forwarded["action"] = "status"
        forwarded["profile"] = profile
        forwarded.pop("worker_key", None)
        try:
            resp = worker.request(forwarded, self._worker_request_timeout(req))
            if resp.get("exists") is not False:
                self._record_response_routes(profile, key or profile, resp)
            resp.setdefault("loaded", True)
            return resp
        except RuntimeError as e:
            return {"ok": False, "error": str(e)}

    def handle(self, req: dict[str, Any]) -> dict[str, Any]:
        action = str(req.get("action") or "").strip()
        if not action:
            raise ValueError("action is required")

        if action == "ping":
            with self._lock:
                worker_details = {
                    key: {
                        "running": worker.running,
                        "pid": worker.pid,
                        "endpoint": worker.endpoint,
                        "profile": getattr(worker, "profile", key),
                        "last_used_at": worker.last_used_at,
                    }
                    for key, worker in self._workers.items()
                }
                workers = {key: details["running"] for key, details in worker_details.items()}
                sessions_by_profile: dict[str, int] = {}
                for profile in self._session_profile.values():
                    sessions_by_profile[profile] = sessions_by_profile.get(profile, 0) + 1
                running_sessions_by_profile: dict[str, int] = {}
                for profile in self._running_run_profile.values():
                    running_sessions_by_profile[profile] = running_sessions_by_profile.get(profile, 0) + 1
                active_sessions = len(self._session_profile)
                running_sessions = len(self._running_run_profile)
            return {
                "pong": True,
                "time": time.time(),
                "mode": "broker",
                "broker": {
                    "pid": os.getpid(),
                    "endpoint": self.endpoint,
                },
                "workers": workers,
                "worker_details": worker_details,
                "active_sessions": active_sessions,
                "running_sessions": running_sessions,
                "sessions_by_profile": sessions_by_profile,
                "running_sessions_by_profile": running_sessions_by_profile,
            }

        if action == "worker_ping":
            profile = self._normalize_profile(req.get("profile"))
            worker_key = self._normalize_worker_key(profile, req.get("worker_key"))
            resp = self._forward(profile, {"action": "ping"}, worker_key)
            resp["worker_profile"] = profile
            resp["worker_key"] = worker_key
            return resp

        if action == "chat":
            profile = self._normalize_profile(req.get("profile"))
            return self._forward(profile, req, self._normalize_worker_key(profile, req.get("worker_key")))

        if action == "context_estimate":
            profile = self._normalize_profile(req.get("profile"))
            return self._forward(profile, req, self._normalize_worker_key(profile, req.get("worker_key")))

        if action in {"provider_credentials", "image_providers", "image_generate"}:
            profile = self._normalize_profile(req.get("profile"))
            return self._forward(profile, req, self._normalize_worker_key(profile, req.get("worker_key")))

        if action in {"get_result", "get_output"}:
            profile, worker_key = self._route_for_run(str(req.get("run_id") or ""))
            return self._forward(profile, req, worker_key)

        if action == "status_if_loaded":
            return self._status_if_loaded(req)

        if action == "background_poll":
            requested_routes: dict[str, set[str]] = {}
            for route in req.get("routes") or []:
                if not isinstance(route, dict):
                    continue
                profile = self._normalize_profile(route.get("profile"))
                requested_routes.setdefault(profile, set()).update(
                    str(session_id).strip()
                    for session_id in (route.get("session_ids") or [])
                    if str(session_id).strip()
                )
            for profile in requested_routes:
                self._worker_for_profile(profile)
            with self._lock:
                workers = list(self._workers.values())
            sessions: list[dict[str, Any]] = []
            notifications: list[dict[str, Any]] = []
            pending_count = 0
            for worker in workers:
                profile = getattr(worker, "profile", "default") or "default"
                if not worker.running:
                    if profile not in requested_routes:
                        continue
                try:
                    response = worker.request({
                        "action": "background_poll",
                        "session_ids": sorted(requested_routes.get(profile, set())),
                    })
                except Exception:
                    continue
                pending_count += int(response.get("pending_count") or 0)
                for session in response.get("sessions") or []:
                    if isinstance(session, dict):
                        sessions.append({**session, "profile": profile})
                for notification in response.get("notifications") or []:
                    if isinstance(notification, dict):
                        notifications.append({**notification, "profile": profile})
            return {
                "broker_id": str(os.getpid()),
                "pending_count": pending_count,
                "sessions": sessions,
                "notifications": notifications,
            }

        if action in {"background_notification_complete", "background_notification_release"}:
            session_id = str(req.get("session_id") or "")
            profile, worker_key = self._route_for_session(
                session_id,
                req.get("profile"),
                req.get("worker_key") if "worker_key" in req else None,
            )
            return self._forward(profile, req, worker_key)

        if action in {"interrupt", "request_boundary_interrupt", "steer", "command", "switch_session_model", "goal_evaluate", "goal_pause", "status", "get_history", "get_session_title", "destroy"}:
            session_id = str(req.get("session_id") or "")
            profile, worker_key = self._route_for_session(session_id, req.get("profile"), req.get("worker_key") if "worker_key" in req else None)
            resp = self._forward(profile, req, worker_key)
            if action == "destroy":
                with self._lock:
                    self._session_profile.pop(session_id, None)
                    self._session_worker_key.pop(session_id, None)
            return resp

        if action == "approval_respond":
            approval_id = str(req.get("approval_id") or "").strip()
            if not approval_id:
                raise ValueError("approval_id is required")
            with self._lock:
                profile = self._approval_profile.get(approval_id)
                worker_key = self._approval_worker_key.get(approval_id)
            if not profile:
                raise KeyError(f"unknown approval request: {approval_id}")
            return self._forward(profile, req, worker_key)

        if action == "clarify_respond":
            clarify_id = str(req.get("clarify_id") or "").strip()
            if not clarify_id:
                raise ValueError("clarify_id is required")
            with self._lock:
                profile = self._clarify_profile.get(clarify_id)
                worker_key = self._clarify_worker_key.get(clarify_id)
            if not profile:
                raise KeyError(f"unknown clarify request: {clarify_id}")
            return self._forward(profile, req, worker_key)

        if action == "compression_respond":
            request_id = str(req.get("request_id") or "").strip()
            if not request_id:
                raise ValueError("request_id is required")
            with self._lock:
                profile = self._compression_profile.get(request_id)
                worker_key = self._compression_worker_key.get(request_id)
            if not profile:
                raise KeyError(f"unknown compression request: {request_id}")
            return self._forward(profile, req, worker_key)

        if action == "destroy_all":
            with self._lock:
                workers = list(self._workers.values())
                self._workers.clear()
                self._run_profile.clear()
                self._run_worker_key.clear()
                self._running_run_profile.clear()
                self._running_run_worker_key.clear()
                self._session_profile.clear()
                self._session_worker_key.clear()
                self._approval_profile.clear()
                self._approval_worker_key.clear()
                self._clarify_profile.clear()
                self._clarify_worker_key.clear()
                self._compression_profile.clear()
                self._compression_worker_key.clear()
            destroyed = 0
            for worker in workers:
                try:
                    if worker.running:
                        resp = worker.request({"action": "destroy_all"})
                        destroyed += int(resp.get("destroyed") or 0)
                except Exception:
                    pass
                finally:
                    worker.stop()
            return {"destroyed": destroyed}

        if action == "destroy_profile":
            profile = self._normalize_profile(req.get("profile"))
            with self._lock:
                workers = [
                    worker
                    for key, worker in list(self._workers.items())
                    if getattr(worker, "profile", key) == profile
                ]
                for worker in workers:
                    self._workers.pop(worker.key, None)
                self._run_profile = {key: value for key, value in self._run_profile.items() if value != profile}
                self._run_worker_key = {key: value for key, value in self._run_worker_key.items() if key in self._run_profile}
                self._running_run_profile = {key: value for key, value in self._running_run_profile.items() if value != profile}
                self._running_run_worker_key = {key: value for key, value in self._running_run_worker_key.items() if key in self._running_run_profile}
                self._session_profile = {key: value for key, value in self._session_profile.items() if value != profile}
                self._session_worker_key = {key: value for key, value in self._session_worker_key.items() if key in self._session_profile}
                self._approval_profile = {key: value for key, value in self._approval_profile.items() if value != profile}
                self._approval_worker_key = {key: value for key, value in self._approval_worker_key.items() if key in self._approval_profile}
                self._clarify_profile = {key: value for key, value in self._clarify_profile.items() if value != profile}
                self._clarify_worker_key = {key: value for key, value in self._clarify_worker_key.items() if key in self._clarify_profile}
                self._compression_profile = {key: value for key, value in self._compression_profile.items() if value != profile}
                self._compression_worker_key = {key: value for key, value in self._compression_worker_key.items() if key in self._compression_profile}

            if not workers:
                return {"profile": profile, "destroyed": 0}

            destroyed = 0
            for worker in workers:
                if not worker.running:
                    worker.stop()
                    continue
                try:
                    resp = worker.request({"action": "destroy_all"})
                    destroyed += int(resp.get("destroyed") or 0)
                except Exception:
                    pass
                finally:
                    worker.stop()
            return {"profile": profile, "destroyed": destroyed}

        if action == "list":
            sessions: list[Any] = []
            with self._lock:
                workers = list(self._workers.items())
            for key, worker in workers:
                if not worker.running:
                    continue
                try:
                    resp = worker.request({"action": "list"})
                    for session in resp.get("sessions") or []:
                        if isinstance(session, dict):
                            session.setdefault("profile", getattr(worker, "profile", key))
                            session.setdefault("worker_key", key)
                        sessions.append(session)
                except Exception:
                    pass
            return {"sessions": sessions}

        if action == "shutdown":
            self.stop()
            return {"status": "shutting_down"}

        # ───── MCP Management ─────
        if action.startswith("mcp_"):
            profile = self._normalize_profile(req.get("profile"))
            return self._forward(profile, req)

        raise ValueError(f"unknown action: {action}")

    def _make_server_socket(self) -> socket.socket:
        return _make_listen_socket(self.endpoint)

    def _read_request(self, conn: socket.socket) -> dict[str, Any]:
        return _read_json_request(conn)

    def _write_response(self, conn: socket.socket, resp: dict[str, Any]) -> None:
        _write_json_response(conn, resp)

    def _handle_connection(self, conn: socket.socket) -> None:
        try:
            try:
                req = self._read_request(conn)
                data = self.handle(req)
                resp = {"ok": True, **_jsonable(data)}
            except Exception as exc:
                resp = {
                    "ok": False,
                    "error": str(exc),
                    "error_type": exc.__class__.__name__,
                }
            self._write_response(conn, resp)
        except Exception as exc:
            print(f"[hermes-bridge-broker] connection error: {exc}", file=sys.stderr, flush=True)
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _gc_idle_workers(self) -> None:
        now = time.time()
        if now - self._last_gc < self.GC_INTERVAL_SECONDS:
            return
        self._last_gc = now
        with self._lock:
            idle = [
                key for key, worker in self._workers.items()
                if worker.running and now - worker.last_used_at > self.IDLE_TIMEOUT_SECONDS
            ]
        for key in idle:
            with self._lock:
                worker = self._workers.pop(key, None)
            if worker:
                worker.stop()

    def serve_forever(self) -> None:
        server = self._make_server_socket()
        restore_signals = _install_stop_signal_handlers(self._stop)
        atexit.register(self.stop)
        try:
            server.listen(64)
            server.settimeout(0.2)
            print(json.dumps({"event": "ready", "endpoint": self.endpoint, "mode": "broker"}), flush=True)

            while not self._stop.is_set():
                try:
                    try:
                        conn, _addr = server.accept()
                    except socket.timeout:
                        self._gc_idle_workers()
                        continue
                    threading.Thread(
                        target=self._handle_connection,
                        args=(conn,),
                        daemon=True,
                        name="hermes-bridge-broker-connection",
                    ).start()
                except KeyboardInterrupt:
                    break
                except Exception as exc:
                    print(f"[hermes-bridge-broker] server loop error: {exc}", file=sys.stderr, flush=True)
        finally:
            restore_signals()
            try:
                atexit.unregister(self.stop)
            except Exception:
                pass
            self.stop()
            server.close()
            if self.endpoint.startswith("ipc://"):
                try:
                    Path(self.endpoint.removeprefix("ipc://")).unlink(missing_ok=True)
                except OSError:
                    pass
