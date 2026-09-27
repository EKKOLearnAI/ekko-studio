import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'

function runPython(script: string, args: string[] = []): any {
  try {
    return JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script, ...args], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 20_000, stdio: 'pipe',
    }))
  } catch (error) {
    const detail = error as { message?: string; stdout?: string; stderr?: string }
    throw new Error([detail.message, detail.stdout, detail.stderr].filter(Boolean).join('\n'))
  }
}

describe('agent bridge runtime bootstrap', () => {
  it.each(['broker', 'worker'])('finishes interpreter re-exec before the %s accepts requests', (mode) => {
    const result = runPython(String.raw`
import json
import os
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

bridge = Path('packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py').resolve()
with tempfile.TemporaryDirectory(prefix='bridge-bootstrap-') as temp:
    root = Path(temp)
    marker = root / 'bootstrapped'
    (root / 'run_agent.py').write_text('import hermes_bootstrap\nraise RuntimeError("fixture agent import reached")\n')
    (root / 'hermes_bootstrap.py').write_text('''import os, sys
from pathlib import Path
if os.environ.get('BRIDGE_TEST_REEXEC') != '1':
    os.environ['BRIDGE_TEST_REEXEC'] = '1'
    os.execv(sys.executable, [sys.executable, *sys.argv])
Path(os.environ['BRIDGE_TEST_MARKER']).write_text('ready')
''')
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
    endpoint = f'tcp://127.0.0.1:{port}'
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(('HERMES_', 'BRIDGE_TEST_', 'PYTHON'))}
    env.update(HERMES_HOME=temp, BRIDGE_TEST_MARKER=str(marker), PYTHONDONTWRITEBYTECODE='1')
    command = [sys.executable, str(bridge), '--endpoint', endpoint,
               '--agent-root', temp, '--hermes-home', temp]
    if sys.argv[1] == 'worker':
        command += ['--worker-profile', 'default']
    with (root / 'stderr.log').open('w+') as stderr:
        proc = subprocess.Popen(command, cwd=temp, env=env, stdout=subprocess.PIPE,
                                stderr=stderr, text=True)
        lines = queue.Queue()
        def read_stdout():
            for line in proc.stdout:
                lines.put(line)
            lines.put(None)
        threading.Thread(target=read_stdout, daemon=True).start()
        def request(action):
            with socket.create_connection(('127.0.0.1', port), timeout=3) as conn:
                conn.sendall((json.dumps({'action': action, 'message': 'probe', 'messages': []}) + '\n').encode())
                with conn.makefile('rb') as wire:
                    return json.loads(wire.readline())
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                line = lines.get(timeout=max(0.1, deadline - time.monotonic()))
                if line is None:
                    raise RuntimeError('bridge exited before ready')
                try:
                    if json.loads(line).get('event') == 'ready':
                        break
                except ValueError:
                    continue
            else:
                raise RuntimeError('bridge did not become ready')
            ready_after_bootstrap = marker.exists()
            # The fixture stops at the real chat import boundary: no model calls,
            # credentials, user sessions or installed Hermes runtime are needed.
            responses = []
            if sys.argv[1] == 'worker':
                for action in ('context_estimate', 'chat'):
                    responses.append(request(action)['error'])
            pong = request('ping')['pong']
            request('shutdown')
            proc.wait(timeout=5)
            print(json.dumps({'bootstrapped_before_ready': ready_after_bootstrap,
                              'responses': responses, 'pong': pong}))
        except Exception:
            stderr.flush()
            print((root / 'stderr.log').read_text(), file=sys.stderr)
            raise
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
`, [mode])
    expect(result).toEqual({
      bootstrapped_before_ready: true,
      responses: mode === 'worker' ? ['fixture agent import reached', 'fixture agent import reached'] : [],
      pong: true,
    })
  })

  it.each(['legacy', 'broken'])('handles a %s bootstrap without hiding dependency failures', (mode) => {
    const result = runPython(String.raw`
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path
path = Path('packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py').resolve()
spec = importlib.util.spec_from_file_location('hermes_bridge', path)
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)
with tempfile.TemporaryDirectory(prefix='bridge-bootstrap-import-') as temp:
    root = Path(temp)
    (root / 'run_agent.py').write_text('')
    if sys.argv[1] == 'broken':
        (root / 'hermes_bootstrap.py').write_text('import missing_bootstrap_dependency\n')
    else:
        sys.modules['hermes_bootstrap'] = None
    bridge._set_path_env(temp, temp)
    import bridge_runtime
    bridge_runtime._apply_openrouter_attribution_override = lambda: None
    os.environ.pop('HERMES_AGENT_BRIDGE_STUDIO_MCP_ENV', None)
    try:
        bridge_runtime._ensure_agent_imports()
        result = {'ok': True}
    except ModuleNotFoundError as exc:
        result = {'missing': exc.name}
    print(json.dumps(result))
`, [mode])
    expect(result).toEqual(mode === 'legacy' ? { ok: true } : { missing: 'missing_bootstrap_dependency' })
  })
})
