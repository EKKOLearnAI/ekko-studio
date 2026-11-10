import socket, sys, os, inspect, threading, types, json
def deny(self, *a, **k): raise PermissionError("egress denied")
socket.socket.connect = deny; socket.socket.connect_ex = deny
sys.path.insert(0, os.environ["BRIDGE_DIR"])
import bridge_pool, bridge_mcp
cls = [c for c in vars(bridge_pool).values() if inspect.isclass(c) and hasattr(c, 'start_chat') and c.__module__ == 'bridge_pool'][0]
pool = cls.__new__(cls); pool._lock = threading.Lock(); pool._runs = {}
seen = []
def make_session(sid):
    return types.SimpleNamespace(session_id=sid, config={}, boundary_supported=False, boundary_error=None, lock=threading.Lock(), running=False,
                                 current_run_id=None, boundary_phase=None, boundary_pending_run_id=None, boundary_reached_run_id=None, last_used_at=0)
pool.get_or_create = lambda sid, **k: make_session(sid)
pool._install_usage_hook = lambda: None; pool._install_boundary_interrupt = lambda s: None
pool._bridge_context_ready_event = lambda *a: None; pool._fail_unexpected_run = lambda *a: None
mode = {"raise": None}
def observer(session, record, *rest):
    seen.append((session.session_id, bridge_mcp.CRON_CAPABILITY.get()))
    if mode["raise"]: raise mode["raise"]
pool._run_chat = observer
parent = bridge_mcp.CRON_CAPABILITY.set("parent-A")  # a caller already inside another run's authority
out = {}
r1 = pool.start_chat("with-cap", "hi", studio_cron_capability="studio_run_TEST"); r1.worker_thread.join(5)
r2 = pool.start_chat("no-cap", "hi"); r2.worker_thread.join(5)
r2b = pool.start_chat("none-cap", "hi", studio_cron_capability=None); r2b.worker_thread.join(5)
mode["raise"] = RuntimeError("boom"); r3 = pool.start_chat("err-cap", "hi", studio_cron_capability="studio_run_ERR"); r3.worker_thread.join(5)
mode["raise"] = KeyboardInterrupt(); r4 = pool.start_chat("abort-cap", "hi", studio_cron_capability="studio_run_ABORT"); r4.worker_thread.join(5)
out = {"seen": seen, "caller_after": bridge_mcp.CRON_CAPABILITY.get(), "class": cls.__name__}
bridge_mcp.CRON_CAPABILITY.reset(parent)
out["caller_reset"] = bridge_mcp.CRON_CAPABILITY.get()
ok = (dict(seen) == {"with-cap": "studio_run_TEST", "no-cap": None, "none-cap": None, "err-cap": "studio_run_ERR", "abort-cap": "studio_run_ABORT"} and out["caller_after"] == "parent-A" and out["caller_reset"] is None)
print("RESULT", json.dumps({**out, "ok": ok})); sys.exit(0 if ok else 1)
