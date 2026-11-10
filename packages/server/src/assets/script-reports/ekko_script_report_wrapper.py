"""Ekko Studio script invocation report wrapper (generated at enrollment; do not edit).

Hermes runs this file as the job's native ``no_agent`` script. It runs the enrolled target
script once, relays its stdout, stderr and exit status unchanged, and records a sanitized,
bounded report of that invocation in Ekko Studio's private spool. Studio imports the report
into the bound session as a passive notice.

The report identifies this wrapper invocation (a fresh UUID). It is not a native Hermes
execution receipt: ``native_execution_id`` is always null and every launch of this file is
reported, whether scheduled, run manually or started directly.

With ``completion: "detached"`` in the manifest the target is a launcher that hands this
invocation to a detached worker: a clean launcher exit records a handoff, never a final report,
and the worker completes the invocation with ``python <this file> complete``. Before that, the
worker may add up to eight nonterminal notices to the same invocation with ``append``. See ``helper``.

Standard library only. Nothing here imports Hermes or reads credentials.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import threading
import time
import unicodedata
import uuid

MANIFEST_PATH = None  # @EKKO_SCRIPT_REPORT_MANIFEST@

WRAPPER_VERSION = "1"
SCHEMA_VERSION = 1
# Classification mirrors Hermes bf0203a: cron/scheduler_prompt._parse_wake_gate,
# cron/scheduler._run_no_agent_job and gateway/response_filters.is_autonomous_silence_response.
POLICY_VERSION = "hermes-no-agent-silence-v1"
SANITIZER_VERSION = "ekko-report-sanitizer-v1"

CAPTURE_LIMIT_BYTES = 1024 * 1024
BODY_LIMIT_BYTES = 32 * 1024
# Studio refuses a final record over 96 KiB; keep a margin for the other fields.
RECORD_LIMIT_BYTES = 92 * 1024
MANIFEST_LIMIT_BYTES = 64 * 1024
READ_CHUNK = 64 * 1024
PREFLIGHT_EXIT = 2


class PreflightError(Exception):
    """Report storage is unusable before the target starts: the target is not launched."""


COMPLETIONS = ("sync", "detached")


# --- manifest -----------------------------------------------------------------------------------

def _read_private_file(path: str, limit: int) -> bytes:
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > limit:
            raise ValueError("manifest is not a private regular file")
        data = os.read(fd, limit + 1)
        if len(data) > limit:
            raise ValueError("manifest is too large")
        return data
    finally:
        os.close(fd)


def load_manifest(path: str | None) -> dict:
    if not path:
        raise PreflightError("manifest path missing")
    try:
        manifest = json.loads(_read_private_file(path, MANIFEST_LIMIT_BYTES).decode("utf-8"))
    except Exception as exc:
        raise PreflightError("manifest unreadable") from exc
    if not isinstance(manifest, dict) or manifest.get("schema_version") != SCHEMA_VERSION:
        raise PreflightError("manifest schema unsupported")
    target = manifest.get("target")
    if not isinstance(target, dict):
        raise PreflightError("manifest target missing")
    for key in ("path", "cwd"):
        if not isinstance(target.get(key), str) or not os.path.isabs(target[key]):
            raise PreflightError("manifest target incomplete")
    if target.get("kind") not in ("bash", "python"):
        raise PreflightError("manifest target kind unsupported")
    for key in ("binding_id", "spool_dir", "revoked_marker", "target_sha256"):
        if not isinstance(manifest.get(key), str) or not manifest[key]:
            raise PreflightError("manifest binding incomplete")
    if not isinstance(manifest.get("binding_revision"), int):
        raise PreflightError("manifest revision missing")
    manifest.setdefault("completion", "sync")
    if manifest["completion"] not in COMPLETIONS:
        raise PreflightError("manifest completion unsupported")
    if manifest["completion"] == "detached":
        for key in ("outbox_dir", "receipts_dir"):
            if not isinstance(manifest.get(key), str) or not os.path.isabs(manifest[key]):
                raise PreflightError("manifest completion incomplete")
    return manifest


def target_argv(target: dict) -> list[str]:
    """Native interpreter choice: .sh/.bash under bash; Python under the interpreter Hermes chose
    for this wrapper (the job's ``interpreter`` when set). Shebangs are ignored, as natively."""
    if target["kind"] == "bash":
        import shutil
        bash = shutil.which("bash") or ("/bin/bash" if os.path.isfile("/bin/bash") else None)
        if bash is None:
            raise OSError("bash not found on PATH")
        return [bash, target["path"]]
    return [sys.executable, target["path"]]


# --- classification (native parity) -------------------------------------------------------------

_SILENT_MARKERS = frozenset({"[SILENT]", "SILENT", "NO_REPLY", "NO REPLY", "[静默]", "静默", "[沉默]", "沉默"})
_BRACKETED = tuple(sorted(m for m in _SILENT_MARKERS if m.startswith("[")))
_MARKER_LENGTH_CAP = 64


def wake_gate_allows(output: str) -> bool:
    lines = [line for line in (output or "").splitlines() if line.strip()]
    if not lines:
        return True
    try:
        gate = json.loads(lines[-1].strip())
    except (json.JSONDecodeError, ValueError):
        return True
    return not isinstance(gate, dict) or gate.get("wakeAgent", True) is not False


def _edge_punct(ch: str) -> bool:
    return ch not in "[]" and unicodedata.category(ch).startswith("P")


def _candidates(text: str) -> tuple[str, ...]:
    stripped = text.strip()
    if not 0 < len(stripped) <= _MARKER_LENGTH_CAP:
        return ()
    start, end = 0, len(stripped)
    while start < end and _edge_punct(stripped[start]):
        start += 1
    while end > start and _edge_punct(stripped[end - 1]):
        end -= 1
    depunct = stripped[start:end].strip()
    forms = (stripped,) if depunct == stripped else (stripped, depunct)
    return tuple(" ".join(form.strip().upper().split()) for form in forms)


def _exact_silence(text: str) -> bool:
    return any(c in _SILENT_MARKERS for c in _candidates(text))


def is_silence(output: str) -> bool:
    stripped = output.strip()
    if not stripped:
        return False
    lines = [line for line in stripped.splitlines() if line.strip()]
    return stripped.upper().startswith(_BRACKETED) or any(
        _exact_silence(c) for c in (stripped, lines[0], lines[-1]))


# --- sanitizer (before any durable write; conservative) -----------------------------------------

# Assignment-shaped secrets. Linear: a key is a bounded run that starts at a key boundary; only a
# secret-named key consumes its value (quoted values honour backslash escapes), so assignments nested
# in the value of another key are still visited.
_SECRET_NAME = re.compile(r"(?i)secret|token|passw(?:or)?d|passwd|pwd|api[_\-]?key|access[_\-]?key|private[_\-]?key|credential|session[_\-]?id|cookie|auth")
_KEY = re.compile(r"(?<![A-Za-z0-9_.\-])([\"']?)([A-Za-z0-9_.\-]{1,128})\1[ \t]{0,16}[:=][ \t]{0,16}")
_VALUE = re.compile(r"\"(?:[^\"\\\n]|\\.)*\"?|'(?:[^'\\\n]|\\.)*'?|[^\s,;&]+")


def _structured_end(text: str, start: int) -> int:
    """End of the balanced object or array at ``start`` (quotes and escapes honoured); the end of the
    text when it never closes, so an unparseable secret value is omitted whole."""
    depth, quote, escaped = 0, "", False
    for index in range(start, len(text)):
        ch = text[index]
        if quote:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                quote = ""
        elif ch in "\"'":
            quote = ch
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
            if depth == 0:
                return index + 1
    return len(text)


def _redact_assignments(text: str) -> str:
    out, copied, pos = [], 0, 0
    while True:
        key = _KEY.search(text, pos)
        if key is None:
            break
        pos = key.end()
        if not _SECRET_NAME.search(key[2]):
            continue
        if pos < len(text) and text[pos] in "[{":
            end = _structured_end(text, pos)
        else:
            value = _VALUE.match(text, pos)
            if value is None:
                continue
            end = value.end()
        out.append(text[copied:pos])
        out.append("[REDACTED]")
        copied = pos = end
    out.append(text[copied:])
    return "".join(out)
_RULES = [
    (re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\Z)"), "[REDACTED PRIVATE KEY]"),
    (re.compile(r"(?im)^([ \t]*(?:proxy-)?authorization[ \t]*[:=][ \t]*).+$"), r"\1[REDACTED]"),
    (re.compile(r"(?i)\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=\-]{8,}"), r"\1 [REDACTED]"),
    (re.compile(r"(?i)\b([a-z][a-z0-9+.\-]{0,31}://)[^/\s:@]{1,256}:[^/\s@]{1,256}@"), r"\1[REDACTED]@"),
    # A JWT starts at the beginning of a base64url run, so each run is scanned once.
    (re.compile(r"(?<![A-Za-z0-9_\-])eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"), "[REDACTED JWT]"),
    (re.compile(r"\b(?:sk|rk|pk)-[A-Za-z0-9_\-]{16,}"), "[REDACTED KEY]"),
    (re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}"), "[REDACTED KEY]"),
    (re.compile(r"\bxox[abposr]-[A-Za-z0-9\-]{10,}"), "[REDACTED KEY]"),
    (re.compile(r"\bglpat-[A-Za-z0-9_\-]{16,}|\bnpm_[A-Za-z0-9]{30,}"), "[REDACTED KEY]"),
    (re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "[REDACTED KEY]"),
    (re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b"), "[REDACTED KEY]"),
]


def sanitize(text: str) -> tuple[str, bool]:
    """``(sanitized, changed)``. Raises on any failure; callers must then omit the content."""
    if not isinstance(text, str):
        raise TypeError("text expected")
    result = text
    for pattern, replacement in _RULES:
        result = pattern.sub(replacement, result)
    result = _redact_assignments(result)
    return result, result != text


def clip_utf8(text: str, limit: int) -> tuple[str, bool]:
    data = text.encode("utf-8")
    if len(data) <= limit:
        return text, False
    return data[:limit].decode("utf-8", errors="ignore"), True


# --- private spool ------------------------------------------------------------------------------

def _fsync_dir(path: str) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _private_dir(path: str) -> None:
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise PreflightError("spool directory is not private")


def serialize(record: dict) -> bytes:
    return json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def publish_json(directory: str, name: str, record: dict) -> None:
    """Exclusive temp file, fsync, atomic no-replace link, directory fsync. Never overwrites, so two
    publishers of one record (a detached launcher and its worker) cannot replace each other."""
    data = serialize(record)
    final = os.path.join(directory, name)
    temp = os.path.join(directory, f".{name}.{uuid.uuid4().hex}.tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.link(temp, final)  # fails with FileExistsError when the record already exists
    finally:
        try:
            os.unlink(temp)
        except OSError:
            pass
    _fsync_dir(directory)


def reserve_invocation(manifest: dict, invocation_id: str, started_at: float) -> str:
    """Count and reserve under an exclusive lock, so concurrent launches cannot exceed the quota."""
    import fcntl
    spool = manifest["spool_dir"]
    try:
        _private_dir(spool)
        lock = os.open(os.path.join(spool, ".reserve.lock"), os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except PreflightError:
        raise
    except OSError as exc:
        raise PreflightError("spool directory unavailable") from exc
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _reserve_locked(manifest, spool, invocation_id, started_at)
    finally:
        os.close(lock)


def _reserve_locked(manifest: dict, spool: str, invocation_id: str, started_at: float) -> str:
    try:
        pending = sum(1 for entry in os.scandir(spool) if not entry.name.startswith("."))
    except OSError as exc:
        raise PreflightError("spool directory unavailable") from exc
    if pending >= int(manifest.get("max_pending") or 200):
        raise PreflightError("report spool is full")
    directory = os.path.join(spool, invocation_id)
    try:
        os.mkdir(directory, 0o700)
        publish_json(directory, "started.json", {
            "schema_version": SCHEMA_VERSION, "phase": "started", "identity_kind": "wrapper_invocation",
            "binding_id": manifest["binding_id"], "binding_revision": manifest["binding_revision"],
            "invocation_id": invocation_id, "native_execution_id": None, "wrapper_version": WRAPPER_VERSION,
            "started_at": started_at, **({"completion": "detached"} if manifest.get("completion") == "detached" else {}),
        })
    except OSError as exc:
        try:
            os.rmdir(directory)
        except OSError:
            pass
        raise PreflightError("report start could not be recorded") from exc
    return directory


# --- child relay ---------------------------------------------------------------------------------

class Capture:
    def __init__(self) -> None:
        self.chunks: list[bytes] = []
        self.size = 0
        self.overflow = False

    def add(self, chunk: bytes) -> None:
        if self.overflow:
            return
        if self.size + len(chunk) > CAPTURE_LIMIT_BYTES:
            self.overflow = True
            self.chunks = []
            return
        self.chunks.append(chunk)
        self.size += len(chunk)

    def text(self) -> str:
        return b"".join(self.chunks).decode("utf-8", errors="replace")


def _relay(source, sink, capture: Capture) -> None:
    fd = source.fileno()
    sink_ok = True
    while True:
        try:
            chunk = os.read(fd, READ_CHUNK)
        except InterruptedError:
            continue
        except OSError:
            break
        if not chunk:
            break
        capture.add(chunk)
        if sink_ok:
            try:
                sink.write(chunk)
                sink.flush()
            except (OSError, ValueError):
                sink_ok = False  # keep draining so the child never blocks on a full pipe


def classify(returncode: int, stdout: Capture, stderr: Capture, interrupted: int | None) -> dict:
    """Outcome and unsanitized detail. Failure takes precedence over silence."""
    signal_number = -returncode if returncode < 0 else None
    exit_code = returncode if returncode >= 0 else None
    if interrupted is not None:
        return {"outcome": "interrupted", "exit_code": exit_code, "signal": signal_number or interrupted,
                "detail": None, "reason": "wrapper_signalled"}
    if returncode != 0:
        if stdout.overflow or stderr.overflow:
            return {"outcome": "failed", "exit_code": exit_code, "signal": signal_number, "detail": None,
                    "reason": "capture_limit"}
        out, err = stdout.text().strip(), stderr.text().strip()
        parts = [f"Script exited with code {returncode}"]
        if err:
            parts.append(f"stderr:\n{err}")
        if out:
            parts.append(f"stdout:\n{out}")
        return {"outcome": "failed", "exit_code": exit_code, "signal": signal_number, "detail": "\n".join(parts),
                "reason": None}
    if stdout.overflow:
        return {"outcome": "output_unavailable", "exit_code": 0, "signal": None, "detail": None, "reason": "capture_limit"}
    output = stdout.text().strip()
    if not wake_gate_allows(output):
        return {"outcome": "silent", "exit_code": 0, "signal": None, "detail": None, "reason": "wake_gate"}
    if not output:
        return {"outcome": "silent", "exit_code": 0, "signal": None, "detail": None, "reason": "empty_output"}
    if is_silence(output):
        return {"outcome": "silent", "exit_code": 0, "signal": None, "detail": None, "reason": "silence_marker"}
    return {"outcome": "output", "exit_code": 0, "signal": None, "detail": output, "reason": None}


def render_body(detail: str | None, reason: str | None) -> dict:
    """Sanitized, clipped body fields of a final record: sanitization precedes any durable write."""
    if detail is None:
        return {"content": None, "truncated": False, "omitted_reason": reason, "redaction_status": "not_applicable"}
    try:
        # Studio refuses NUL in a report body (find -print0, git -z): show it as a visible symbol.
        sanitized, changed = sanitize(detail.replace("\x00", "\u2400"))
        content, truncated = clip_utf8(sanitized, BODY_LIMIT_BYTES)
        return {"content": content, "truncated": truncated, "omitted_reason": None,
                "redaction_status": "redacted" if changed else "clean"}
    except Exception:
        return {"content": None, "truncated": False, "omitted_reason": "redaction_failed", "redaction_status": "failed"}


def fit_record(record: dict) -> dict:
    # JSON escaping can multiply the body (control characters become \\u0001): shrink it until the
    # serialized record fits instead of producing a report Studio must refuse.
    while record["content"] and len(serialize(record)) > RECORD_LIMIT_BYTES:
        record["content"], _ = clip_utf8(record["content"], len(record["content"].encode("utf-8")) * 3 // 4)
        record["truncated"] = True
    return record


def build_final(manifest: dict, invocation_id: str, started_at: float, monotonic_start: float,
                result: dict, launched: bool) -> dict:
    body = render_body(result.get("detail"), result.get("reason"))
    record = {
        "schema_version": SCHEMA_VERSION, "phase": "final", "identity_kind": "wrapper_invocation",
        "binding_id": manifest["binding_id"], "binding_revision": manifest["binding_revision"],
        "invocation_id": invocation_id, "native_execution_id": None,
        "wrapper_version": WRAPPER_VERSION, "policy_version": POLICY_VERSION, "sanitizer_version": SANITIZER_VERSION,
        "child_launched": launched, "outcome": result["outcome"], "exit_code": result.get("exit_code"),
        "signal": result.get("signal"), **body, "started_at": started_at, "finished_at": time.time(),
        "duration_ms": int((time.monotonic() - monotonic_start) * 1000),
    }
    if manifest.get("completion") == "detached":
        record.update({"completion": "detached", "event_id": None, "submitted_sha256": None, "retry_of": None})
    return fit_record(record)


def _exit_like(returncode: int) -> None:
    sys.stdout.flush()
    sys.stderr.flush()
    if returncode < 0:
        sig = -returncode
        # SIGKILL and SIGSTOP cannot be handled, so resetting their disposition raises; still die by them.
        try:
            signal.signal(sig, signal.SIG_DFL)
        except (OSError, ValueError):
            pass
        try:
            os.kill(os.getpid(), sig)
        except (OSError, ValueError):
            pass
        os._exit(128 + sig)
    os._exit(returncode)


def verify_target(target: dict, digest: str) -> None:
    """The enrolled file only: same resolved path (no symlink swapped into it or an ancestor), a
    regular file, same content. Hermes validated that file at enrollment; anything else is refused."""
    import hashlib
    try:
        if os.path.realpath(target["path"]) != target["path"] or not stat.S_ISREG(os.lstat(target["path"]).st_mode):
            raise PreflightError("target script moved or replaced since enrollment; enroll it again")
        with open(target["path"], "rb") as handle:
            current = hashlib.sha256(handle.read()).hexdigest()
    except OSError as exc:
        raise PreflightError("target script unavailable") from exc
    if current != digest:
        raise PreflightError("target script changed since enrollment; enroll it again")


def main() -> None:
    try:
        manifest = load_manifest(MANIFEST_PATH)
    except PreflightError as exc:
        sys.stderr.write(f"Ekko script report: {exc}; the target script was not started\n")
        sys.stderr.flush()
        os._exit(PREFLIGHT_EXIT)
    target = manifest["target"]
    try:
        verify_target(target, manifest["target_sha256"])
    except PreflightError as exc:
        sys.stderr.write(f"Ekko script report: {exc}; the target script was not started\n")
        sys.stderr.flush()
        os._exit(PREFLIGHT_EXIT)
    argv = target_argv(target)

    # Revoked: run the target directly with nothing captured or stored.
    if os.path.lexists(manifest["revoked_marker"]):
        os.chdir(target["cwd"])
        os.execv(argv[0], argv)

    invocation_id = str(uuid.uuid4())
    started_at = time.time()
    monotonic_start = time.monotonic()
    try:
        directory = reserve_invocation(manifest, invocation_id, started_at)
    except PreflightError as exc:
        sys.stderr.write(f"Ekko script report: {exc}; the target script was not started\n")
        sys.stderr.flush()
        os._exit(PREFLIGHT_EXIT)

    stdout, stderr = Capture(), Capture()
    interrupted: list[int] = []
    detached = manifest["completion"] == "detached"
    # Detached completion: the launcher passes this reserved invocation to its worker by inheritance.
    env = dict(os.environ, EKKO_SCRIPT_REPORT_INVOCATION=invocation_id, EKKO_SCRIPT_REPORT_HELPER=os.path.realpath(__file__),
               EKKO_SCRIPT_REPORT_PYTHON=sys.executable) if detached else None
    try:
        child = subprocess.Popen(argv, cwd=target["cwd"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    except OSError as exc:
        message = f"Script execution failed: {exc}"
        sys.stderr.write(message + "\n")
        sys.stderr.flush()
        final = build_final(manifest, invocation_id, started_at, monotonic_start,
                            {"outcome": "launch_failed", "exit_code": None, "signal": None, "detail": message,
                             "reason": None}, False)
        try:
            publish_json(directory, "final.json", final)
        except Exception:
            pass
        os._exit(1)

    def forward(signum, _frame):
        interrupted.append(signum)
        try:
            child.send_signal(signum)
        except OSError:
            pass

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, forward)

    readers = [threading.Thread(target=_relay, args=(child.stdout, sys.stdout.buffer, stdout), daemon=True),
               threading.Thread(target=_relay, args=(child.stderr, sys.stderr.buffer, stderr), daemon=True)]
    for reader in readers:
        reader.start()
    while True:
        try:
            returncode = child.wait()
            break
        except InterruptedError:
            continue
    for reader in readers:
        reader.join()

    result = classify(returncode, stdout, stderr, interrupted[0] if interrupted else None)
    try:
        if detached and result["outcome"] in ("output", "silent", "output_unavailable"):
            # A clean launcher exit is a handoff, not the report: the worker completes the invocation.
            # Without its completion the invocation stays incomplete; nothing is inferred from time.
            publish_json(directory, "handoff.json", {
                "schema_version": SCHEMA_VERSION, "phase": "handoff", "binding_id": manifest["binding_id"],
                "binding_revision": manifest["binding_revision"], "invocation_id": invocation_id,
                "launcher_exit_code": 0, "handed_off_at": time.time()})
        else:
            # Never overwrites: a worker that already completed this invocation keeps its report.
            # Detached: closed under the helper's lock, after restoring every notice it admitted.
            # Without the lock an admission may be in flight: fail closed, the invocation stays incomplete.
            lock = _locked(manifest) if detached else None
            try:
                if detached:
                    _close_events(manifest, invocation_id)
                publish_json(directory, "final.json", build_final(manifest, invocation_id, started_at, monotonic_start,
                                                                  result, True))
            finally:
                if lock is not None:
                    os.close(lock)
    except Exception:
        # Report storage failed after the target ran: never rerun it and never change its
        # streams or exit status. Studio sees a started invocation without a final report.
        pass
    _exit_like(returncode)


# --- detached completion helper ------------------------------------------------------------------
#
# ``python <wrapper> complete --event-id ID --content-file PATH|- [--outcome output|silent|failed]
#                            [--invocation UUID] [--wait SECONDS]``
# ``python <wrapper> receipt --event-id ID [--stream complete|append] [--wait SECONDS]``
# ``python <wrapper> append --event-id ID --event-kind start|body|success|failure --content-file PATH|-
#                          [--invocation UUID] [--wait SECONDS]``
#
# The destination is the embedded manifest's binding; nothing here selects a session. ``complete``
# persists the original delivery envelope of ``ID`` (sanitized body, digest of the submitted bytes,
# the reserved invocation) before publishing its final report. A later call for the same ID reuses
# that envelope and its ORIGINAL invocation: identical bytes are a retry (the new invocation, if any,
# is recorded as silent ``event_retry``), different bytes are refused as a conflict. Delivery is
# proven only by Studio's receipt for the original invocation, never by the spool or stdout.
#
# ``append`` adds a nonterminal notice to the reserved invocation without finalizing it: at most
# APPEND_LIMIT per invocation, numbered in admission order. Its envelope (the frozen event record)
# is durable before it reaches the spool; the same ID with the same bytes and kind returns that
# record, anything else under the ID is a conflict. ``complete`` remains the terminal report: it
# closes admission and first restores every admitted notice, which Studio imports before it.

HELPER_EXIT = {"accepted": 0, "silent": 0, "queued": 3, "incomplete": 3, "rejected": 4, "quarantined": 4,
               "conflict": 5, "unknown": 6}
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
EVENT_LIMIT = 200
APPEND_LIMIT = 8
EVENT_KINDS = ("start", "body", "success", "failure")
WAIT_LIMIT_SECONDS = 600


class HelperError(Exception):
    def __init__(self, code: str, status: str = "unknown", exit_code: int = PREFLIGHT_EXIT) -> None:
        super().__init__(code)
        self.code, self.status, self.exit_code = code, status, exit_code


def _read_json(path: str, limit: int):
    try:
        return json.loads(_read_private_file(path, limit).decode("utf-8"))
    except FileNotFoundError:
        return None
    except Exception as exc:
        raise HelperError("unreadable_record") from exc


def _started(manifest: dict, invocation_id: str) -> dict | None:
    """The started record of a reserved detached invocation of this binding revision, else None."""
    if not UUID_RE.match(invocation_id or ""):
        return None
    directory = os.path.join(manifest["spool_dir"], invocation_id)
    try:
        _private_dir(directory)
        started = _read_json(os.path.join(directory, "started.json"), 4096)
    except (OSError, PreflightError, HelperError):
        return None
    if not isinstance(started, dict) or started.get("completion") != "detached" or started.get("invocation_id") != invocation_id \
            or started.get("binding_id") != manifest["binding_id"] or started.get("binding_revision") != manifest["binding_revision"]:
        return None
    return started


def _receipt(manifest: dict, invocation_id: str) -> dict | None:
    receipt = _read_json(os.path.join(manifest["receipts_dir"], f"{invocation_id}.json"), 64 * 1024)
    if receipt is not None and (not isinstance(receipt, dict) or receipt.get("binding_id") != manifest["binding_id"]
                                or receipt.get("invocation_id") != invocation_id):
        raise HelperError("receipt_invalid")
    return receipt


def _complete_invocation(manifest: dict, invocation_id: str, started: dict, outcome: str, body: dict,
                         event_id: str, submitted: str | None, retry_of: str | None = None) -> None:
    _close_events(manifest, invocation_id)
    now = time.time()
    record = {
        "schema_version": SCHEMA_VERSION, "phase": "final", "identity_kind": "wrapper_invocation",
        "binding_id": manifest["binding_id"], "binding_revision": manifest["binding_revision"],
        "invocation_id": invocation_id, "native_execution_id": None,
        "wrapper_version": WRAPPER_VERSION, "policy_version": POLICY_VERSION, "sanitizer_version": SANITIZER_VERSION,
        "child_launched": True, "outcome": outcome, "exit_code": 0 if outcome != "failed" else None, "signal": None,
        **body, "started_at": started["started_at"], "finished_at": now,
        "duration_ms": max(0, int((now - started["started_at"]) * 1000)),
        "completion": "detached", "event_id": event_id, "submitted_sha256": submitted, "retry_of": retry_of,
    }
    publish_json(os.path.join(manifest["spool_dir"], invocation_id), "final.json", fit_record(record))


def _status(manifest: dict, envelope: dict, publish: bool) -> tuple[str, dict | None]:
    """Where the original invocation of an envelope stands; publishes its final report when missing."""
    original = envelope["invocation_id"]
    receipt = _receipt(manifest, original)
    if receipt is not None:
        # The original invocation may have been settled by something else (a failed launcher): only a
        # receipt of this envelope's event and bytes says anything about this delivery.
        if receipt.get("event_id") != envelope["event_id"] or receipt.get("submitted_sha256") != envelope["submitted_sha256"]:
            return "unknown", receipt
        return receipt.get("state", "unknown"), receipt
    if os.path.lexists(os.path.join(manifest["spool_dir"], original, "final.json")):
        return "queued", None
    started = _started(manifest, original)
    if started is None:
        return "unknown", None
    if not publish:
        return "incomplete", None
    _complete_invocation(manifest, original, started, envelope["outcome"], envelope["body"], envelope["event_id"],
                         envelope["submitted_sha256"])
    return "queued", None


def _envelope_path(manifest: dict, event_id: str) -> str:
    return os.path.join(manifest["outbox_dir"], hashlib.sha256(event_id.encode("utf-8")).hexdigest() + ".json")


def _load_envelope(manifest: dict, path: str, event_id: str) -> dict | None:
    envelope = _read_json(path, 256 * 1024)
    if envelope is None:
        return None
    if not isinstance(envelope, dict) or envelope.get("schema_version") != SCHEMA_VERSION \
            or envelope.get("binding_id") != manifest["binding_id"] or envelope.get("binding_revision") != manifest["binding_revision"] \
            or envelope.get("event_id") != event_id or not UUID_RE.match(str(envelope.get("invocation_id"))) \
            or not isinstance(envelope.get("body"), dict) or envelope.get("outcome") not in ("output", "silent", "failed"):
        # Preserved as is: a malformed pending delivery is never replaced or guessed.
        raise HelperError("envelope_invalid")
    return envelope


def _event(value: str) -> str:
    if not value or len(value) > EVENT_LIMIT or any(unicodedata.category(ch).startswith("C") for ch in value):
        raise HelperError("invalid_event_id")
    return value


def _read_content(path: str) -> bytes:
    handle = sys.stdin.buffer if path == "-" else open(path, "rb")
    try:
        data = handle.read(CAPTURE_LIMIT_BYTES + 1)
    finally:
        if handle is not sys.stdin.buffer:
            handle.close()
    if len(data) > CAPTURE_LIMIT_BYTES:
        raise HelperError("content_too_large")
    return data


def _locked(manifest: dict):
    import fcntl
    _private_dir(manifest["outbox_dir"])
    lock = os.open(os.path.join(manifest["outbox_dir"], ".lock"), os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX)
    return lock


def complete(manifest: dict, args) -> dict:
    event_id = _event(args.event_id)
    raw = _read_content(args.content_file)
    submitted = hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8", errors="replace")
    if args.outcome != "silent" and not text.strip():
        raise HelperError("empty_content")
    current = args.invocation or os.environ.get("EKKO_SCRIPT_REPORT_INVOCATION") or None
    lock = _locked(manifest)
    try:
        path = _envelope_path(manifest, event_id)
        envelope = _load_envelope(manifest, path, event_id)
        started = _started(manifest, current) if current else None
        # The reserved invocation this call may still complete (the "vehicle"); a repeated call after
        # its report exists, or after Studio settled it, only reads the envelope's status.
        finished = started is not None and os.path.lexists(os.path.join(manifest["spool_dir"], current, "final.json"))
        vehicle = None if finished else started
        if envelope is None:
            if vehicle is None:
                raise HelperError("invocation_finalized" if finished else "invocation_not_reserved" if current else "invocation_required")
            envelope = {"schema_version": SCHEMA_VERSION, "binding_id": manifest["binding_id"],
                        "binding_revision": manifest["binding_revision"], "event_id": event_id, "invocation_id": current,
                        "outcome": args.outcome, "submitted_sha256": submitted, "created_at": time.time(),
                        "body": render_body(None, "producer_silent") if args.outcome == "silent" else render_body(text, None)}
            # Durable before the report exists: a crash after this line retries the same identity and bytes.
            publish_json(manifest["outbox_dir"], os.path.basename(path), envelope)
        elif envelope["submitted_sha256"] != submitted or envelope["outcome"] != args.outcome:
            # Never on the envelope's own invocation: it stays reserved for the original bytes.
            if vehicle is not None and current != envelope["invocation_id"]:
                detail = (f"Report event {event_id} was already submitted with different content "
                          f"(invocation {envelope['invocation_id']}); this submission was refused.")
                _complete_invocation(manifest, current, vehicle, "failed", render_body(detail, None), event_id, submitted)
            return {"status": "conflict", "event_id": event_id, "invocation_id": envelope["invocation_id"],
                    "vehicle_invocation_id": current, "receipt": None}
        elif vehicle is not None and current != envelope["invocation_id"]:
            _complete_invocation(manifest, current, vehicle, "silent", render_body(None, "event_retry"), event_id, submitted,
                                 retry_of=envelope["invocation_id"])
        status, receipt = _status(manifest, envelope, publish=True)
    finally:
        os.close(lock)
    return {"status": status, "event_id": event_id, "invocation_id": envelope["invocation_id"],
            "vehicle_invocation_id": current, "receipt": receipt}


# --- appended notices ----------------------------------------------------------------------------

def _durable_dir(path: str) -> None:
    """Create missing directories (0700), fsyncing each parent so an acknowledged admission survives power loss."""
    if os.path.isdir(path):
        return
    _durable_dir(os.path.dirname(path))
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        return
    _fsync_dir(os.path.dirname(path))


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _append_paths(manifest: dict, event_id: str) -> tuple[str, str]:
    """(envelope directory, file name): the envelope is keyed by the event alone, never by an invocation."""
    return os.path.join(manifest["outbox_dir"], "events"), _digest(event_id) + ".json"


def _slots_dir(manifest: dict, invocation_id: str) -> str:
    return os.path.join(manifest["outbox_dir"], "invocations", invocation_id)


def _valid_append(manifest: dict, envelope, event_id: str | None) -> dict:
    if not isinstance(envelope, dict) or envelope.get("schema_version") != SCHEMA_VERSION or envelope.get("phase") != "event" \
            or envelope.get("binding_id") != manifest["binding_id"] or envelope.get("binding_revision") != manifest["binding_revision"] \
            or not isinstance(envelope.get("event_id"), str) or event_id not in (None, envelope["event_id"]) \
            or not UUID_RE.match(str(envelope.get("invocation_id"))) or envelope.get("event_kind") not in EVENT_KINDS \
            or not isinstance(envelope.get("sequence"), int):
        # Preserved as is: a malformed record is never replaced or guessed.
        raise HelperError("envelope_invalid")
    return envelope


def _load_append(manifest: dict, event_id: str) -> dict | None:
    directory, name = _append_paths(manifest, event_id)
    envelope = _read_json(os.path.join(directory, name), 256 * 1024)
    return None if envelope is None else _valid_append(manifest, envelope, event_id)


def _slot_records(manifest: dict, invocation_id: str) -> list[dict]:
    """The frozen records admitted to an invocation, in slot order (at most APPEND_LIMIT)."""
    slots = _slots_dir(manifest, invocation_id)
    try:
        names = sorted(name for name in os.listdir(slots) if not name.startswith("."))
    except FileNotFoundError:
        return []
    records = [_valid_append(manifest, _read_json(os.path.join(slots, name), 256 * 1024), None) for name in names]
    if any(record["invocation_id"] != invocation_id or name != f"{record['sequence']:02d}.json" for name, record in zip(names, records)):
        raise HelperError("envelope_invalid")
    return records


def _intent_path(manifest: dict) -> str:
    return os.path.join(manifest["outbox_dir"], "admitting.json")


def _finish_admission(manifest: dict) -> None:
    """Under the lock: complete an admission a crash interrupted after its slot record, so the event is
    findable by its id from ANY invocation before anything else is admitted (one admission at a time)."""
    path = _intent_path(manifest)
    intent = _read_json(path, 4096)
    if intent is None:
        return
    if not isinstance(intent, dict) or not UUID_RE.match(str(intent.get("invocation_id"))) or not isinstance(intent.get("sequence"), int):
        raise HelperError("envelope_invalid")
    slot = os.path.join(_slots_dir(manifest, intent["invocation_id"]), f"{intent['sequence']:02d}.json")
    record = _read_json(slot, 256 * 1024)
    if record is not None:  # no slot record: the admission never happened and its caller got no answer
        _index(manifest, _valid_append(manifest, record, intent.get("event_id")))
    os.unlink(path)
    _fsync_dir(manifest["outbox_dir"])


def _index(manifest: dict, envelope: dict) -> None:
    """The event's lookup copy of its slot record; never replaces an existing one."""
    directory, name = _append_paths(manifest, envelope["event_id"])
    _durable_dir(directory)
    try:
        publish_json(directory, name, envelope)
    except FileExistsError:
        pass


def _deliver_event(manifest: dict, envelope: dict) -> None:
    """Publish the frozen record into its invocation's spool unless Studio already settled it."""
    status, receipt = _event_status(manifest, envelope)
    if receipt is not None and status != "unknown":
        return
    directory = os.path.join(manifest["spool_dir"], envelope["invocation_id"])
    if not os.path.isdir(directory):
        return
    events = os.path.join(directory, "events")
    name = f"{envelope['sequence']:02d}.json"
    try:
        # Only beneath the existing reservation: Studio may remove the invocation at any moment, and
        # recreating it would leave a phantom spool entry.
        if not os.path.isdir(events):
            os.mkdir(events, 0o700)
            _fsync_dir(directory)
        if not os.path.lexists(os.path.join(events, name)):
            publish_json(events, name, envelope)
    except (FileExistsError, FileNotFoundError):
        pass


def _close_events(manifest: dict, invocation_id: str) -> None:
    """Before an invocation is finalized: every notice it admitted is in its spool (crash recovery)."""
    if manifest.get("completion") != "detached":
        return
    if os.path.isdir(manifest["outbox_dir"]):
        _finish_admission(manifest)
    for envelope in _slot_records(manifest, invocation_id):
        _index(manifest, envelope)
        _deliver_event(manifest, envelope)


def _event_receipt(manifest: dict, event_id: str) -> dict | None:
    return _read_json(os.path.join(manifest["receipts_dir"], "events", _digest(event_id) + ".json"), 64 * 1024)


def _event_status(manifest: dict, envelope: dict) -> tuple[str, dict | None]:
    receipt = _event_receipt(manifest, envelope["event_id"])
    if receipt is not None:
        keys = ("binding_id", "binding_revision", "event_id", "event_kind", "invocation_id", "sequence", "submitted_sha256")
        if not isinstance(receipt, dict) or any(receipt.get(key) != envelope[key] for key in keys):
            return "unknown", receipt
        return receipt.get("state", "unknown"), receipt
    events = os.path.join(manifest["spool_dir"], envelope["invocation_id"], "events")
    return ("queued" if os.path.lexists(os.path.join(events, f"{envelope['sequence']:02d}.json")) else "unknown"), None


def append(manifest: dict, args) -> dict:
    event_id = _event(args.event_id)
    raw = _read_content(args.content_file)
    submitted = hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8", errors="replace")
    current = args.invocation or os.environ.get("EKKO_SCRIPT_REPORT_INVOCATION") or None
    lock = _locked(manifest)
    try:
        _finish_admission(manifest)
        envelope = _load_append(manifest, event_id)
        if envelope is None:
            # A new notice needs this caller's own reserved, still open invocation.
            started = _started(manifest, current) if current else None
            if started is None:
                raise HelperError("invocation_not_reserved" if current else "invocation_required")
            # Closed once its final report exists, and still closed after Studio removed it (its receipt is first).
            if os.path.lexists(os.path.join(manifest["spool_dir"], current, "final.json")) or _receipt(manifest, current) is not None:
                raise HelperError("invocation_finalized")
            if not text.strip():
                raise HelperError("empty_content")
            records = _slot_records(manifest, current)
            # A record admitted before a crash (its index not yet written) is resumed, never admitted twice.
            mine = [record for record in records if record["event_id"] == event_id]
            if mine:
                envelope = mine[0]
            elif len(records) >= APPEND_LIMIT:
                raise HelperError("event_limit_reached", "rejected", HELPER_EXIT["rejected"])
            else:
                body = render_body(text, None)
                if body["content"] is None:
                    # Sanitization failed: refuse before anything durable, so no identity or slot is consumed.
                    raise HelperError("redaction_failed")
                envelope = fit_record({
                    "schema_version": SCHEMA_VERSION, "phase": "event", "binding_id": manifest["binding_id"],
                    "binding_revision": manifest["binding_revision"], "invocation_id": current, "event_id": event_id,
                    "event_kind": args.event_kind, "sequence": len(records) + 1, "submitted_sha256": submitted,
                    "created_at": time.time(), "wrapper_version": WRAPPER_VERSION, "sanitizer_version": SANITIZER_VERSION,
                    **body})
                slots = _slots_dir(manifest, current)
                _durable_dir(slots)
                publish_json(manifest["outbox_dir"], os.path.basename(_intent_path(manifest)),
                             {"event_id": event_id, "invocation_id": current, "sequence": envelope["sequence"]})
                # The admission point: the slot holds the frozen record itself, so a crash after this line
                # leaves a complete record that closure delivers and the next admission indexes.
                publish_json(slots, f"{envelope['sequence']:02d}.json", envelope)
            _index(manifest, envelope)
            if os.path.lexists(_intent_path(manifest)):
                os.unlink(_intent_path(manifest))
        if envelope["submitted_sha256"] != submitted or envelope["event_kind"] != args.event_kind:
            return {"status": "conflict", "event_id": event_id, "invocation_id": envelope["invocation_id"],
                    "sequence": envelope["sequence"], "receipt": None}
        _deliver_event(manifest, envelope)
        status, receipt = _event_status(manifest, envelope)
    finally:
        os.close(lock)
    return {"status": status, "event_id": event_id, "invocation_id": envelope["invocation_id"],
            "sequence": envelope["sequence"], "receipt": receipt}


def receipt(manifest: dict, args) -> dict:
    event_id = _event(args.event_id)
    if args.stream == "append":
        envelope = _load_append(manifest, event_id)
        if envelope is None:
            return {"status": "unknown", "event_id": event_id, "invocation_id": None, "receipt": None}
        status, found = _event_status(manifest, envelope)
        return {"status": status, "event_id": event_id, "invocation_id": envelope["invocation_id"],
                "sequence": envelope["sequence"], "receipt": found}
    envelope = _load_envelope(manifest, _envelope_path(manifest, event_id), event_id)
    if envelope is None:
        return {"status": "unknown", "event_id": event_id, "invocation_id": None, "receipt": None}
    status, found = _status(manifest, envelope, publish=False)
    return {"status": status, "event_id": event_id, "invocation_id": envelope["invocation_id"], "receipt": found}


def helper(argv: list[str]) -> int:
    import argparse
    parser = argparse.ArgumentParser(prog="ekko-script-report")
    commands = parser.add_subparsers(dest="command", required=True)
    done = commands.add_parser("complete")
    done.add_argument("--event-id", required=True)
    done.add_argument("--content-file", required=True)
    done.add_argument("--outcome", choices=("output", "silent", "failed"), default="output")
    done.add_argument("--invocation")
    done.add_argument("--wait", type=float, default=0)
    read = commands.add_parser("receipt")
    read.add_argument("--event-id", required=True)
    read.add_argument("--stream", choices=("complete", "append"), default="complete")
    read.add_argument("--wait", type=float, default=0)
    add = commands.add_parser("append")
    add.add_argument("--event-id", required=True)
    add.add_argument("--event-kind", choices=EVENT_KINDS, required=True)
    add.add_argument("--content-file", required=True)
    add.add_argument("--invocation")
    add.add_argument("--wait", type=float, default=0)
    args = parser.parse_args(argv)
    try:
        manifest = load_manifest(MANIFEST_PATH)
        if manifest["completion"] != "detached":
            raise HelperError("completion_not_detached")
        result = {"complete": complete, "receipt": receipt, "append": append}[args.command](manifest, args)
        appended = args.command == "append" or getattr(args, "stream", None) == "append"
        deadline = time.monotonic() + max(0.0, min(args.wait, WAIT_LIMIT_SECONDS))
        while result["status"] in ("queued", "incomplete") and result["invocation_id"] and time.monotonic() < deadline:
            time.sleep(0.5)
            # The same envelope match as the first answer: a receipt of another event or other bytes
            # for that invocation (a failed launcher) never confirms this delivery.
            if appended:
                envelope = _load_append(manifest, result["event_id"])
                status, found = _event_status(manifest, envelope) if envelope else ("unknown", None)
            else:
                envelope = _load_envelope(manifest, _envelope_path(manifest, result["event_id"]), result["event_id"])
                status, found = _status(manifest, envelope, publish=False) if envelope else ("unknown", None)
            result.update(status=status, receipt=found)
    except (HelperError, PreflightError, OSError) as exc:
        code = exc.code if isinstance(exc, HelperError) else type(exc).__name__
        sys.stdout.write(json.dumps({"status": "error", "error": code}) + "\n")
        return exc.exit_code if isinstance(exc, HelperError) else PREFLIGHT_EXIT
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    return HELPER_EXIT.get(result["status"], HELPER_EXIT["unknown"])


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in ("complete", "receipt", "append"):
        sys.exit(helper(sys.argv[1:]))
    main()
