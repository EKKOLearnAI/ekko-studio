import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const python = process.platform === 'win32' ? 'python' : 'python3'
const setup = String.raw`
import copy, json, os, sys, types
from pathlib import Path
sys.path.insert(0, str(Path('packages/server/src/modules/hermes/services/bridge/python').resolve()))
from bridge_mcp import install_studio_mcp_env

tools = types.ModuleType('tools')
tools.__path__ = []
sys.modules['tools'] = tools
layout = sys.argv[1]
module_name = 'tools.mcp_tool_config' if layout == 'split' else 'tools.mcp_tool'
module = types.ModuleType(module_name)
def process_env(extra=None):
    base = {'PATH': os.environ.get('PATH', '')}
    # Node's Windows CSPRNG aborts unless SystemRoot is present. Hermes keeps
    # the process environment; this stub only models that baseline.
    if os.name == 'nt':
        system_root = os.environ.get('SystemRoot') or os.environ.get('SYSTEMROOT')
        if system_root:
            base['SystemRoot'] = system_root
    if extra:
        base.update(extra)
    return base
module._build_safe_env = process_env
sys.modules[module_name] = module
if layout == 'legacy':
    sys.modules['tools.mcp_tool_config'] = None

owner = {'HERMES_WEB_UI_URL': 'http://127.0.0.1:8748',
         'HERMES_WEB_UI_HOME': '/owner/state', 'HERMES_WEBUI_STATE_DIR': '/owner/state',
         'ELECTRON_RUN_AS_NODE': '1'}
os.environ['HERMES_AGENT_BRIDGE_STUDIO_MCP_ENV'] = json.dumps(owner)
os.environ['HERMES_AGENT_BRIDGE_WORKER_PROFILE'] = 'research'
stale = {'HERMES_WEB_UI_MANAGED_MCP': '1', 'HERMES_WEB_UI_URL': 'http://127.0.0.1:8647',
         'HERMES_WEB_UI_HOME': '/other/state', 'HERMES_WEBUI_STATE_DIR': '/other/state',
         'HERMES_WEB_UI_PROFILE': 'default', 'HERMES_WEB_UI_TOKEN': 'stale-token',
         'HERMES_MCP_TOOLSET': 'plan', 'CUSTOM': 'keep'}
original = copy.deepcopy(stale)
`

describe('Hermes Bridge managed MCP instance routing', () => {
  it.each(['split', 'legacy'])('pins managed MCP launch env to the owner on %s runtimes', layout => {
    const output = execFileSync(python, ['-c', setup + String.raw`
install_studio_mcp_env()
installed = module._build_safe_env
install_studio_mcp_env()
assert module._build_safe_env is installed
actual = installed(stale)
assert stale == original
for key, value in owner.items():
    assert actual[key] == value, (key, actual)
assert actual['HERMES_WEB_UI_PROFILE'] == 'research'
assert 'HERMES_WEB_UI_TOKEN' not in actual
assert actual['CUSTOM'] == 'keep' and actual['HERMES_MCP_TOOLSET'] == 'plan'
assert installed(None) == process_env()
custom = {**stale, 'HERMES_WEB_UI_MANAGED_MCP': '0'}
assert installed(custom) == process_env(custom)
print('ok')
`, layout], { encoding: 'utf8' })
    expect(output.trim()).toBe('ok')
  })

  it('does not change standalone Hermes launches without a Studio owner', () => {
    const output = execFileSync(python, ['-c', setup + String.raw`
del os.environ['HERMES_AGENT_BRIDGE_STUDIO_MCP_ENV']
original_builder = module._build_safe_env
install_studio_mcp_env()
assert module._build_safe_env is original_builder
print('ok')
`, 'split'], { encoding: 'utf8' })
    expect(output.trim()).toBe('ok')
  })

  it('sends real plan MCP requests to their owning server when shared config points elsewhere', () => {
    const output = execFileSync(python, ['-c', setup + String.raw`
import subprocess, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
hits = []
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        hits.append((self.server.server_port, self.path, self.headers.get('X-Hermes-Profile')))
        ok = self.server is owning and body['context_id'] == 'current-turn'
        self.send_response(200 if ok else 409)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'ok': True} if ok else {'error': 'Task plan context is unavailable or has expired'}).encode())
owning = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
other = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
for server in (owning, other):
    threading.Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory() as home:
    owner.update(HERMES_WEB_UI_URL=f'http://127.0.0.1:{owning.server_port}', HERMES_WEB_UI_HOME=home, HERMES_WEBUI_STATE_DIR=home)
    os.environ['HERMES_AGENT_BRIDGE_STUDIO_MCP_ENV'] = json.dumps(owner)
    stale['HERMES_WEB_UI_URL'] = f'http://127.0.0.1:{other.server_port}'
    # The same stale shared config first reproduces 409, then succeeds through the bridge hook.
    def call():
        env = module._build_safe_env(stale)
        child = subprocess.Popen([sys.argv[2], 'bin/ekko-studio-mcp.mjs', 'plan'], env=env,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        request = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {
            'name': 'ekko_studio_update_plan', 'arguments': {'context_id': 'current-turn',
                'plan': [{'id': 'verify', 'step': 'Verify routing', 'status': 'in_progress'}]}}}
        try:
            child.stdin.write(json.dumps(request) + '\n'); child.stdin.flush()
            response = json.loads(child.stdout.readline())
        finally:
            child.terminate(); child.communicate(timeout=5)
        return response['result']
    assert call()['isError'] is True
    install_studio_mcp_env()
    result = call()
    assert result.get('isError') is not True, result
    assert json.loads(result['content'][0]['text'])['ok'] is True
assert hits == [(other.server_port, '/api/studio/task-plans/update', 'default'),
                (owning.server_port, '/api/studio/task-plans/update', 'research')], hits
for server in (owning, other):
    server.shutdown(); server.server_close()
print('ok')
`, 'split', process.execPath], { encoding: 'utf8', timeout: 15_000 })
    expect(output.trim()).toBe('ok')
  })
})
