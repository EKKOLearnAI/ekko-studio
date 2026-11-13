"""Ekko Studio script invocation report wrapper (generated at enrollment; do not edit).

Hermes runs this file as the job's native ``no_agent`` script. It runs the enrolled target
script once, relays its stdout, stderr and exit status unchanged, and records a sanitized,
bounded report of that invocation in Ekko Studio's private spool. Studio imports the report
into the bound session as a passive notice.

The report identifies this wrapper invocation (a fresh UUID). It is not a native Hermes
execution receipt: ``native_execution_id`` is always null and every launch of this file is
reported, whether scheduled, run manually or started directly.

Standard library only. Nothing here imports Hermes or reads credentials.
"""

from __future__ import annotations

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
    """Exclusive temp file, fsync, atomic rename, directory fsync. Never overwrites."""
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
        if os.path.lexists(final):
            raise FileExistsError(final)
        os.rename(temp, final)
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise
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
            "started_at": started_at,
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


def build_final(manifest: dict, invocation_id: str, started_at: float, monotonic_start: float,
                result: dict, launched: bool) -> dict:
    content, truncated, redaction = None, False, "not_applicable"
    omitted = result.get("reason") if result.get("detail") is None else None
    if result.get("detail") is not None:
        try:
            # Studio refuses NUL in a report body (find -print0, git -z): show it as a visible symbol.
            sanitized, changed = sanitize(result["detail"].replace("\x00", "\u2400"))
            content, truncated = clip_utf8(sanitized, BODY_LIMIT_BYTES)
            redaction = "redacted" if changed else "clean"
        except Exception:
            content, omitted, redaction = None, "redaction_failed", "failed"
    record = {
        "schema_version": SCHEMA_VERSION, "phase": "final", "identity_kind": "wrapper_invocation",
        "binding_id": manifest["binding_id"], "binding_revision": manifest["binding_revision"],
        "invocation_id": invocation_id, "native_execution_id": None,
        "wrapper_version": WRAPPER_VERSION, "policy_version": POLICY_VERSION, "sanitizer_version": SANITIZER_VERSION,
        "child_launched": launched, "outcome": result["outcome"], "exit_code": result.get("exit_code"),
        "signal": result.get("signal"), "content": content, "truncated": truncated, "omitted_reason": omitted,
        "redaction_status": redaction, "started_at": started_at, "finished_at": time.time(),
        "duration_ms": int((time.monotonic() - monotonic_start) * 1000),
    }
    # JSON escaping can multiply the body (control characters become \\u0001): shrink it until the
    # serialized record fits instead of producing a report Studio must refuse.
    while record["content"] and len(serialize(record)) > RECORD_LIMIT_BYTES:
        record["content"], _ = clip_utf8(record["content"], len(record["content"].encode("utf-8")) * 3 // 4)
        record["truncated"] = True
    return record


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
    try:
        child = subprocess.Popen(argv, cwd=target["cwd"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
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
        publish_json(directory, "final.json", build_final(manifest, invocation_id, started_at, monotonic_start,
                                                          result, True))
    except Exception:
        # Report storage failed after the target ran: never rerun it and never change its
        # streams or exit status. Studio sees a started invocation without a final report.
        pass
    _exit_like(returncode)


if __name__ == "__main__":
    main()
