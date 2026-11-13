#!/usr/bin/env bash
# Synthetic fire-and-forget launcher (public test fixture) for Ekko detached completion.
#
# Like a detached daily producer: silent on a normal launch; an atomic mkdir lock keeps one worker
# (a live lock dedupes silently, a dead one is reclaimed); the worker runs in its own session (a
# python setsid shim, as on macOS) with redirected streams; the launcher returns once the worker has
# written durable startup evidence. The reserved Ekko invocation reaches the worker through the
# inherited EKKO_SCRIPT_REPORT_* environment.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${SYNTHETIC_REPORT_STATE:-$HERE/state}"
export SYNTHETIC_REPORT_STATE="$STATE"
PY="${EKKO_SCRIPT_REPORT_PYTHON:-$(command -v python3)}"
mkdir -p "$STATE/runs"
if ! mkdir "$STATE/lock" 2>/dev/null; then
  holder="$(cat "$STATE/lock/pid" 2>/dev/null || true)"
  # No pid yet: another launcher has only just taken the lock.
  if [ -z "$holder" ] || kill -0 "$holder" 2>/dev/null; then
    # A worker is active: dedupe silently and release this reserved invocation as silence.
    if [ -n "${EKKO_SCRIPT_REPORT_HELPER:-}" ]; then
      "$PY" "$EKKO_SCRIPT_REPORT_HELPER" complete --outcome silent --content-file /dev/null \
        --event-id "launcher-dedupe:$EKKO_SCRIPT_REPORT_INVOCATION" >/dev/null || true
    fi
    exit 0
  fi
  rm -rf "$STATE/lock" && mkdir "$STATE/lock"
fi
echo $$ >"$STATE/lock/pid"
RUN="$STATE/runs/$(date +%s)-$$"
mkdir -p "$RUN"
"$PY" -c 'import os, sys; os.setsid(); os.execv(sys.argv[1], sys.argv[1:])' "$PY" "$HERE/worker.py" "$RUN" \
  </dev/null >"$RUN/worker.log" 2>&1 &
for _ in $(seq 1 400); do
  [ -f "$RUN/started" ] && exit 0
  sleep 0.05
done
echo "synthetic worker produced no startup evidence" >&2
exit 1
