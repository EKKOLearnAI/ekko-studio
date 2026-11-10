"""Synthetic detached report worker (public test fixture) for Ekko detached completion.

Composes the day's report at most once, persists the draft and its event id as the pending delivery
BEFORE submitting, and commits business state only after Studio's receipt for the original
invocation. An ambiguous result keeps the pending draft; a later run (even on another day)
resubmits the identical bytes under the event id stored with them. Slack-style links in the draft are converted to Markdown deterministically.
"""
import datetime
import json
import os
import re
import subprocess
import sys
import time

run = sys.argv[1]
state = os.environ["SYNTHETIC_REPORT_STATE"]
lock = os.path.join(state, "lock")
open(os.path.join(lock, "pid"), "w").write(str(os.getpid()))
open(os.path.join(run, "started"), "w").write(str(os.getpid()))
day_file = os.path.join(state, "day")
day = (os.environ.get("SYNTHETIC_REPORT_DAY") or (open(day_file).read().strip() if os.path.exists(day_file) else "")
       or datetime.date.today().isoformat())
event = f"synthetic-daily-report:v1:{day}"
pending = os.path.join(state, "pending.md")
pending_event = os.path.join(state, "pending.event")
ledger = os.path.join(state, "delivered.json")


def slack_links_to_markdown(text: str) -> str:
    """``<https://url|label>`` -> ``[label](https://url)``; only http(s), label brackets escaped."""
    def link(match: re.Match) -> str:
        label = re.sub(r"([\[\]\\])", r"\\\1", match.group(2))
        return f"[{label}]({match.group(1).replace('(', '%28').replace(')', '%29')})"
    return re.sub(r"<(https?://[^|>\s]+)\|([^>\n]+)>", link, text)


def compose() -> str:
    with open(os.path.join(state, "compositions"), "a") as counter:
        counter.write(f"{day}\n")
    draft = "\n".join([
        f"## Synthetic daily report {day}", "",
        "| Ticket | Status | Owner |", "| --- | --- | --- |",
        "| <https://example.com/issues/SYN-1|SYN-1> | In progress | alice |",
        "| <https://example.com/issues/SYN-2|SYN-2 [flaky]> | Done | bob |", "",
        f"Full report: <https://example.com/reports/{day}|{day}>", "",
    ])
    return slack_links_to_markdown(draft)


def persist(path: str, text: str) -> None:
    with open(path + ".tmp", "w") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.rename(path + ".tmp", path)


def main() -> int:
    global event
    gate = os.environ.get("SYNTHETIC_REPORT_GATE")
    for _ in range(600):  # tests release the worker explicitly instead of racing it
        if not gate or os.path.exists(gate):
            break
        time.sleep(0.05)
    delivered = json.load(open(ledger)) if os.path.exists(ledger) else {}
    if os.path.exists(pending):
        event = open(pending_event).read().strip()  # the pending draft keeps its own event
    nothing_new = event in delivered and not os.path.exists(pending)
    if not nothing_new and not os.path.exists(pending):
        persist(pending_event, event)
        persist(pending, compose())
    helper = os.environ.get("EKKO_SCRIPT_REPORT_HELPER")
    if not helper:
        print("no Ekko completion context; draft stays pending")
        return 1
    if nothing_new:
        # Nothing new today: release the handed-off invocation as silence.
        args = ["--outcome", "silent", "--content-file", os.devnull, "--event-id", f"noop:{os.environ['EKKO_SCRIPT_REPORT_INVOCATION']}"]
    else:
        args = ["--event-id", event, "--content-file", pending]
    wait_file = os.path.join(state, "wait")
    wait = os.environ.get("SYNTHETIC_REPORT_WAIT") or (open(wait_file).read().strip() if os.path.exists(wait_file) else "0")
    result = subprocess.run([os.environ["EKKO_SCRIPT_REPORT_PYTHON"], helper, "complete", *args, "--wait", wait],
                            capture_output=True, text=True)
    print(f"helper exit {result.returncode}: {result.stdout.strip()} {result.stderr.strip()}")
    answer = json.loads(result.stdout or "{}")
    if result.returncode == 0 and answer.get("event_id") == event and answer.get("receipt", {}).get("notification_id"):
        delivered[event] = answer["receipt"]
        with open(ledger + ".tmp", "w") as handle:
            json.dump(delivered, handle)
        os.rename(ledger + ".tmp", ledger)
        os.unlink(pending)
        os.unlink(pending_event)
    return 0


try:
    sys.exit(main())
finally:
    subprocess.run(["rm", "-rf", lock])
