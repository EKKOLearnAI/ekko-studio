import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Runs the real bridge_mcp.run_cron_admission in a Python child. Hermes' tools.* modules are stubbed
// (recording any dispatch); outbound sockets are refused before the helper is imported.
const BRIDGE = resolve(__dirname, '../../packages/server/src/modules/hermes/services/bridge/python')
const PROBE = String.raw`
import json, socket, sys, threading, types
def deny(self, *a, **k): raise PermissionError("egress denied")
socket.socket.connect = deny; socket.socket.connect_ex = deny
calls = []
def stub(name, **attrs):
    module = types.ModuleType(name); module.__dict__.update(attrs); sys.modules[name] = module
stub("tools"); stub("tools.interrupt", set_interrupt=lambda *a: calls.append("interrupt"))
stub("tools.mcp_tool_discovery", discover_mcp_tools=lambda servers: calls.append("discover"))
stub("tools.mcp_tool_schema", mcp_prefixed_tool_name=lambda server, tool: f"{server}__{tool}")
stub("model_tools", handle_function_call=lambda tool, args: calls.append("dispatch") or "{}")
sys.path.insert(0, sys.argv[1])
import bridge_mcp
def failing_start(self): raise RuntimeError("cannot start timer")
threading.Timer.start = failing_start
out = {}
for label, outer in (("nonempty", "outer-capability"), ("default", None)):
    token = bridge_mcp.CRON_CAPABILITY.set(outer) if outer is not None else None
    try:
        bridge_mcp.run_cron_admission("inner-capability", {"kind": "cron_job"}, 1.0)
        out[label] = {"raised": None}
    except RuntimeError as error:
        out[label] = {"raised": str(error)}
    out[label]["after"] = bridge_mcp.CRON_CAPABILITY.get()
    if token is not None: bridge_mcp.CRON_CAPABILITY.reset(token)
out["calls"] = calls
print(json.dumps(out))
`

describe('bridge_mcp run_cron_admission', () => {
  it('a timer that cannot start restores the caller capability and dispatches nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'bridge-mcp-'))
    const result = spawnSync('python3', ['-c', PROBE, BRIDGE], { encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home, HERMES_HOME: join(home, 'hermes'), PYTHONDONTWRITEBYTECODE: '1' } })
    expect(result.status, result.stderr).toBe(0)
    const out = JSON.parse(result.stdout)
    expect(out.nonempty).toEqual({ raised: 'cannot start timer', after: 'outer-capability' })
    expect(out.default).toEqual({ raised: 'cannot start timer', after: null })
    expect(out.calls).toEqual([])
  })
})
