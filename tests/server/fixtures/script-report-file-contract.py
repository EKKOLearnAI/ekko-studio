"""SYNTHETIC script report producer for importer tests: not the generated Ekko wrapper.

It runs the enrolled target as a real child and writes the spool records the importer reads
(started.json, then an atomically published final.json) in the wrapper report format. It does no
sanitization, preflight or revocation handling: those belong to the wrapper and its own tests.
SCRIPT_REPORT_FIXTURE_STARTED_ONLY=1 deliberately publishes no final record (an invocation whose
report never completed). Like the wrapper, the serialized final record stays within the import limit.
"""
import json, os, subprocess, sys, time, uuid

SILENT = {"[SILENT]", "SILENT", "NO_REPLY", "NO REPLY"}
manifest = json.load(open(sys.argv[1], encoding="utf-8"))
target = manifest["target"]
invocation_id = str(uuid.uuid4())
directory = os.path.join(manifest["spool_dir"], invocation_id)
os.mkdir(directory, 0o700)
started_at = time.time()
base = {"schema_version": 1, "identity_kind": "wrapper_invocation", "binding_id": manifest["binding_id"],
        "binding_revision": manifest["binding_revision"], "invocation_id": invocation_id, "native_execution_id": None,
        "wrapper_version": "1", "policy_version": "hermes-no-agent-silence-v1", "sanitizer_version": "ekko-report-sanitizer-v1"}
def publish(name, record):
    temp = os.path.join(directory, f".{name}.tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(record, handle, ensure_ascii=False, separators=(",", ":"))
    os.rename(temp, os.path.join(directory, name))
publish("started.json", {**base, "phase": "started", "started_at": started_at})
command = ["bash", target["path"]] if target["kind"] == "bash" else [sys.executable, target["path"]]
done = subprocess.run(command, cwd=target["cwd"], capture_output=True)
sys.stdout.write(done.stdout.decode("utf-8", "replace"))
output = done.stdout.decode("utf-8", "replace").strip()
if done.returncode != 0:
    outcome, content = "failed", output or None
elif not output:
    outcome, content = "silent", None
elif output in SILENT:
    outcome, content = "silent", None
else:
    outcome, content = "output", output
if os.environ.get("SCRIPT_REPORT_FIXTURE_STARTED_ONLY") == "1":
    sys.exit(done.returncode if done.returncode >= 0 else 1)
raw = (content or "").encode("utf-8")
truncated = len(raw) > 32 * 1024
if truncated:
    content = raw[: 32 * 1024].decode("utf-8", "ignore")
record = {**base, "phase": "final", "outcome": outcome, "exit_code": done.returncode if done.returncode >= 0 else None,
          "signal": -done.returncode if done.returncode < 0 else None, "content": content, "truncated": truncated,
          "omitted_reason": None, "redaction_status": "clean" if content is not None else "not_applicable",
          "child_launched": True, "started_at": started_at, "finished_at": time.time(),
          "duration_ms": int((time.time() - started_at) * 1000)}
# JSON escaping can grow the record past the import limit (96 KiB): shrink the content until it fits.
while content and len(json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 96 * 1024 - 256:
    content = content[: int(len(content) * 0.9)]
    record.update(content=content, truncated=True)
publish("final.json", record)
sys.exit(done.returncode if done.returncode >= 0 else 1)
