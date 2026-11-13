"""Run Hermes' own cron create-time lifecycle guard on one script, without creating a job.

Ekko uses this before adopting an EXISTING no_agent job into script reports: native ``update_job``
does not repeat the create-time scan, so the job's current target is checked here with the same
function Hermes calls in ``create_job``. Read-only: imports the installed Hermes checkout, reads the
script through Hermes' resolver (relative to ``$HERMES_HOME/scripts``) and writes nothing.

Exit codes: 0 allowed, 3 refused by the guard (reason on stdout), 4 guard unavailable.
"""

import sys


def main() -> int:
    if len(sys.argv) != 2 or not sys.argv[1]:
        print("usage: ekko_native_guard_check.py <script>", file=sys.stderr)
        return 4
    try:
        from cron.lifecycle_guard import check_gateway_lifecycle
    except Exception as error:  # noqa: BLE001 - any import failure means the guard cannot vouch
        print(f"native lifecycle guard unavailable: {type(error).__name__}", file=sys.stderr)
        return 4
    try:
        check_gateway_lifecycle(None, sys.argv[1])
    except ValueError as error:  # GatewayLifecycleBlocked is a ValueError
        print(str(error)[:500])
        return 3
    except Exception as error:  # noqa: BLE001 - fail closed on anything unexpected
        print(f"native lifecycle guard failed: {type(error).__name__}", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
