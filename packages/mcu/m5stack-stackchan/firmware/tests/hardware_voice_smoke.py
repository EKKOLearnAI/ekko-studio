#!/usr/bin/env python3
"""Read-only diagnostics plus optional local microphone test; never uploads speech.

Use --replay with a saved JSON trace to verify the same failure criteria against
an earlier boot. Live mode uses hardware flow-control to avoid resetting USB CDC.
"""
import argparse
import json
from pathlib import Path
import re
import sys
import time


def evaluate(rows, microphone):
    lines = [row["line"] for row in rows]
    crashes = [line for line in lines if any(word in line for word in (
        "Guru Meditation", "Backtrace:", "assert failed", "Brownout detector"))]
    fps, heaps, frames, statuses = [], [], [], []
    for line in lines:
        match = re.search(r"\[pulse\] ([0-9.]+) fps.*heap (\d+)", line)
        if match:
            fps.append(float(match[1])); heaps.append(int(match[2]))
        match = re.search(r"camera=1 worker=1.*frames=(\d+).*errors=0", line)
        if match:
            frames.append(int(match[1]))
        if line.startswith("{"):
            try:
                value = json.loads(line)
                if value.get("voice_status"):
                    statuses.append(value)
            except ValueError:
                pass
    checks = {
        "no_crash": not crashes,
        "voice_firmware": any("v2.2-voice-test" in line for line in lines),
        "display_progress": bool(fps) and min(fps) >= 1,
        "internal_ram_headroom": bool(heaps) and min(heaps) >= 16000,
        "camera_worker_progress": bool(frames) and max(frames) > 0,
        "microphone_initialized": any(s.get("mic") for s in statuses),
    }
    if microphone:
        checks["microphone_samples"] = any(
            s.get("mic") and s.get("listening") and s.get("rms", 0) > 0
            for s in statuses)
    return {"passed": all(checks.values()), "checks": checks, "fps": fps,
            "internal_free_bytes": heaps, "camera_frames": frames,
            "microphone_rms": [s.get("rms", 0) for s in statuses],
            "crash_count": len(crashes)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default="/dev/cu.usbmodem3101")
    parser.add_argument("--replay", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--microphone", action="store_true")
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.replay:
        rows = json.loads(args.replay.read_text())
    else:
        import serial
        port = serial.Serial(port=None, baudrate=115200, timeout=.1,
                             write_timeout=2, dsrdtr=True, rtscts=True)
        port.port = args.port
        port.open()
        rows, buffer = [], b""
        schedule = [(1, "diag"), (2, "voice status"), (5, "face status")]
        if args.microphone:
            schedule += [(6, "voice mic"), (9, "voice status"),
                         (12, "voice status"), (15, "voice status")]
        schedule += [(19, "voice status"), (22, "face status")]
        schedule.sort()
        started, index = time.monotonic(), 0
        try:
            while time.monotonic() - started < 27:
                elapsed = time.monotonic() - started
                if index < len(schedule) and elapsed >= schedule[index][0]:
                    command = schedule[index][1]
                    port.write((command + "\n").encode())
                    rows.append({"elapsed": round(elapsed, 3),
                                 "line": "HOST_QUERY " + command})
                    index += 1
                buffer += port.read(port.in_waiting or 1)
                while b"\n" in buffer:
                    raw, buffer = buffer.split(b"\n", 1)
                    line = raw.decode(errors="replace").strip()
                    rows.append({"elapsed": round(time.monotonic()-started, 3),
                                 "line": line})
        finally:
            port.close()
            args.output.with_suffix(".serial.json").write_text(
                json.dumps(rows, ensure_ascii=False, indent=2))
    result = evaluate(rows, args.microphone)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
