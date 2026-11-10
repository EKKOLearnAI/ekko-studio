# Runtime probe (v85 venv + private agent-src): the real bridge_server chat handler forwards the request's
# studio_cron_capability to pool.start_chat, and forwards nothing when the request carries none.
import socket, sys, os, inspect, json, types
def deny(self, *a, **k): raise PermissionError("egress denied")
socket.socket.connect = deny; socket.socket.connect_ex = deny
sys.path.insert(0, os.environ["BRIDGE_DIR"])
import bridge_server
cls = [c for c in vars(bridge_server).values() if inspect.isclass(c) and hasattr(c, 'handle') and c.__module__ == 'bridge_server'][0]
calls = []
class Pool:
    def start_chat(self, *args, **kwargs):
        calls.append(kwargs)
        raise RuntimeError("stop after forwarding")  # nothing runs: no agent, no dispatch
server = cls.__new__(cls); server.pool = Pool()
def chat(extra):
    try: server.handle({"action": "chat", "session_id": "s1", "message": "hi", "profile": "default", **extra})
    except Exception: pass
chat({"studio_cron_capability": "studio_run_FORWARD"}); chat({}); chat({"studio_cron_capability": ""})
seen = [c.get("studio_cron_capability", "<absent>") for c in calls]
ok = seen == ["studio_run_FORWARD", "<absent>", "<absent>"]
print("RESULT", json.dumps({"class": cls.__name__, "forwarded": seen, "ok": ok})); sys.exit(0 if ok else 1)
