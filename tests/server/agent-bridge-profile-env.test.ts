import { execFile } from 'child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { promisify } from 'util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

let tempDir = ''

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'hermes-bridge-profile-env-'))
})

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = ''
})

async function runBridgeProbe(script: string): Promise<any> {
  const bridgePath = resolve('packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py')
  const { stdout } = await execFileAsync('python3', ['-c', script], {
    cwd: resolve('.'),
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERMES_')
        && !key.startsWith('BILI_') && !key.startsWith('BILLION_CONTEXT_') && key !== 'PYTHONPATH')),
      HERMES_HOME: tempDir,
      HERMES_AGENT_BRIDGE_BASE_HOME: tempDir,
      BRIDGE_PATH: bridgePath,
      TEST_HERMES_HOME: tempDir,
    },
    maxBuffer: 1024 * 1024,
  })
  return JSON.parse(stdout)
}

describe('agent bridge JSON encoding', () => {
  it('replaces lone surrogate characters before bridge socket writes', async () => {
    const result = await runBridgeProbe(String.raw`
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("hermes_bridge", os.environ["BRIDGE_PATH"])
bridge = importlib.util.module_from_spec(spec)
sys.modules["hermes_bridge"] = bridge
spec.loader.exec_module(bridge)

class FakeSocket:
    def __init__(self):
        self.sent = []
        self.closed = False
        self._read = False

    def sendall(self, payload):
        self.sent.append(payload)

    def recv(self, size):
        if self._read:
            return b""
        self._read = True
        return b'{"ok":true}\n'

    def close(self):
        self.closed = True

class FakeConn:
    def __init__(self):
        self.sent = b""

    def sendall(self, payload):
        self.sent += payload

fake_socket = FakeSocket()
bridge._connect_bridge_socket = lambda endpoint, timeout: fake_socket
bridge._send_bridge_request("tcp://127.0.0.1:1", {
    "message": "request-\ud800",
    "items": ["nested-\udfff"],
}, 1)

fake_conn = FakeConn()
bridge._write_json_response(fake_conn, {
    "ok": True,
    "message": "response-\udc00",
    "nested": {"key-\ud800": "value-\udfff"},
})

print(json.dumps({
    "request": json.loads(fake_socket.sent[0].decode("utf-8")),
    "response": json.loads(fake_conn.sent.decode("utf-8")),
    "closed": fake_socket.closed,
}))
`)

    expect(result).toEqual({
      request: {
        message: 'request-\uFFFD',
        items: ['nested-\uFFFD'],
      },
      response: {
        ok: true,
        message: 'response-\uFFFD',
        nested: { 'key-\uFFFD': 'value-\uFFFD' },
      },
      closed: true,
    })
  })
})

describe('agent bridge Windows desktop subprocess defaults', () => {
  it('adds CREATE_NO_WINDOW to sync and async nested subprocesses without replacing existing flags', async () => {
    const result = await runBridgeProbe(String.raw`
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("hermes_bridge", os.environ["BRIDGE_PATH"])
bridge = importlib.util.module_from_spec(spec)
sys.modules["hermes_bridge"] = bridge
spec.loader.exec_module(bridge)

original_os_name = bridge.os.name
original_popen = bridge.subprocess.Popen
original_async_exec = bridge.asyncio.create_subprocess_exec
original_async_shell = bridge.asyncio.create_subprocess_shell
original_create_no_window = getattr(bridge.subprocess, "CREATE_NO_WINDOW", None)
original_startupinfo = getattr(bridge.subprocess, "STARTUPINFO", None)
original_startf = getattr(bridge.subprocess, "STARTF_USESHOWWINDOW", None)
original_sw_hide = getattr(bridge.subprocess, "SW_HIDE", None)
original_installed = getattr(bridge.subprocess, "_hermes_hidden_defaults_installed", None)

class FakePopen:
    calls = []

    def __init__(self, *args, **kwargs):
        FakePopen.calls.append({"args": args, "kwargs": kwargs})

async_calls = []

async def fake_create_subprocess_exec(*args, **kwargs):
    async_calls.append({"kind": "exec", "args": args, "kwargs": kwargs})
    return {"kind": "exec"}

async def fake_create_subprocess_shell(*args, **kwargs):
    async_calls.append({"kind": "shell", "args": args, "kwargs": kwargs})
    return {"kind": "shell"}

class FakeStartupInfo:
    def __init__(self):
        self.dwFlags = 0
        self.wShowWindow = None

try:
    bridge.os.name = "nt"
    bridge.os.environ["HERMES_DESKTOP"] = "true"
    bridge.subprocess.Popen = FakePopen
    bridge.asyncio.create_subprocess_exec = fake_create_subprocess_exec
    bridge.asyncio.create_subprocess_shell = fake_create_subprocess_shell
    bridge.subprocess.CREATE_NO_WINDOW = 0x08000000
    bridge.subprocess.STARTUPINFO = FakeStartupInfo
    bridge.subprocess.STARTF_USESHOWWINDOW = 0x00000001
    bridge.subprocess.SW_HIDE = 0
    if hasattr(bridge.subprocess, "_hermes_hidden_defaults_installed"):
        delattr(bridge.subprocess, "_hermes_hidden_defaults_installed")

    bridge._install_windows_hidden_subprocess_defaults()
    bridge.subprocess.Popen(["git", "status"], creationflags=0x00000200)
    flags = FakePopen.calls[0]["kwargs"]["creationflags"]
    startupinfo = FakePopen.calls[0]["kwargs"]["startupinfo"]
    bridge.asyncio.run(bridge.asyncio.create_subprocess_exec("git", "status", creationflags=0x00000400))
    bridge.asyncio.run(bridge.asyncio.create_subprocess_shell("git status"))
    async_exec_flags = async_calls[0]["kwargs"]["creationflags"]
    async_exec_startupinfo = async_calls[0]["kwargs"]["startupinfo"]
    async_shell_flags = async_calls[1]["kwargs"]["creationflags"]
    async_shell_startupinfo = async_calls[1]["kwargs"]["startupinfo"]
finally:
    bridge.os.name = original_os_name
    bridge.subprocess.Popen = original_popen
    bridge.asyncio.create_subprocess_exec = original_async_exec
    bridge.asyncio.create_subprocess_shell = original_async_shell
    if original_create_no_window is None:
        try:
            delattr(bridge.subprocess, "CREATE_NO_WINDOW")
        except AttributeError:
            pass
    else:
        bridge.subprocess.CREATE_NO_WINDOW = original_create_no_window
    for name, original in [
        ("STARTUPINFO", original_startupinfo),
        ("STARTF_USESHOWWINDOW", original_startf),
        ("SW_HIDE", original_sw_hide),
    ]:
        if original is None:
            try:
                delattr(bridge.subprocess, name)
            except AttributeError:
                pass
        else:
            setattr(bridge.subprocess, name, original)
    if original_installed is None:
        try:
            delattr(bridge.subprocess, "_hermes_hidden_defaults_installed")
        except AttributeError:
            pass
    else:
        bridge.subprocess._hermes_hidden_defaults_installed = original_installed

print(json.dumps({
    "flags": flags,
    "has_create_no_window": bool(flags & 0x08000000),
    "kept_existing_flag": bool(flags & 0x00000200),
    "startupinfo_hidden": bool(startupinfo.dwFlags & 0x00000001) and startupinfo.wShowWindow == 0,
    "async_exec_flags": async_exec_flags,
    "async_exec_has_create_no_window": bool(async_exec_flags & 0x08000000),
    "async_exec_kept_existing_flag": bool(async_exec_flags & 0x00000400),
    "async_exec_startupinfo_hidden": bool(async_exec_startupinfo.dwFlags & 0x00000001) and async_exec_startupinfo.wShowWindow == 0,
    "async_shell_flags": async_shell_flags,
    "async_shell_has_create_no_window": bool(async_shell_flags & 0x08000000),
    "async_shell_startupinfo_hidden": bool(async_shell_startupinfo.dwFlags & 0x00000001) and async_shell_startupinfo.wShowWindow == 0,
}))
`)

    expect(result).toEqual({
      flags: 0x08000200,
      has_create_no_window: true,
      kept_existing_flag: true,
      startupinfo_hidden: true,
      async_exec_flags: 0x08000400,
      async_exec_has_create_no_window: true,
      async_exec_kept_existing_flag: true,
      async_exec_startupinfo_hidden: true,
      async_shell_flags: 0x08000000,
      async_shell_has_create_no_window: true,
      async_shell_startupinfo_hidden: true,
    })
  })
})

describe('agent bridge profile environment', () => {
  it('runs agent calls with the requested profile HERMES_HOME and restores the bridge home', async () => {
    const profileHome = join(tempDir, 'profiles', 'work')
    await mkdir(profileHome, { recursive: true })
    await writeFile(join(tempDir, 'config.yaml'), 'model:\n  default: default-model\n', 'utf-8')
    await writeFile(join(tempDir, '.env'), 'OPENAI_API_KEY=default-openai\nBASE_ONLY_TOKEN=base-token\n', 'utf-8')
    await writeFile(join(profileHome, 'config.yaml'), 'model:\n  default: work-model\n', 'utf-8')
    await writeFile(join(profileHome, '.env'), 'GLM_API_KEY=work-glm\n', 'utf-8')
    const expectedProfileHome = await realpath(profileHome)

    const result = await runBridgeProbe(`
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("hermes_bridge", os.environ["BRIDGE_PATH"])
bridge = importlib.util.module_from_spec(spec)
sys.modules["hermes_bridge"] = bridge
spec.loader.exec_module(bridge)

root = os.environ["TEST_HERMES_HOME"]
profile_home = os.path.join(root, "profiles", "work")
os.environ["HERMES_HOME"] = root
os.environ["HERMES_AGENT_BRIDGE_BASE_HOME"] = root
os.environ["OPENAI_API_KEY"] = "shell-openai"
os.environ["GLM_API_KEY"] = "shell-glm"

class FakeAgent:
    def __init__(self):
        self.seen_home = None
        self.seen_openai = None
        self.seen_glm = None
        self.seen_base_only = None

    def run_conversation(self, message, **kwargs):
        self.seen_home = os.environ.get("HERMES_HOME")
        self.seen_openai = os.environ.get("OPENAI_API_KEY")
        self.seen_glm = os.environ.get("GLM_API_KEY")
        self.seen_base_only = os.environ.get("BASE_ONLY_TOKEN")
        return {"messages": [{"role": "assistant", "content": "ok"}]}

agent = FakeAgent()
with bridge._profile_env("work"):
    result = agent.run_conversation("hello")

print(json.dumps({
    "seen_home": agent.seen_home,
    "seen_openai": agent.seen_openai,
    "seen_glm": agent.seen_glm,
    "seen_base_only": agent.seen_base_only,
    "restored_home": os.environ.get("HERMES_HOME"),
    "restored_openai": os.environ.get("OPENAI_API_KEY"),
    "restored_glm": os.environ.get("GLM_API_KEY"),
    "restored_base_only": os.environ.get("BASE_ONLY_TOKEN"),
    "status": "complete" if result.get("messages") else "error",
}))
`)

    expect(result).toEqual({
      seen_home: expectedProfileHome,
      seen_openai: null,
      seen_glm: 'work-glm',
      seen_base_only: null,
      restored_home: tempDir,
      restored_openai: 'shell-openai',
      restored_glm: 'shell-glm',
      restored_base_only: null,
      status: 'complete',
    })
  })

  it('normalizes a profile-scoped bridge home back to the Hermes root for profile lookup', async () => {
    const agentRoot = join(tempDir, 'hermes-agent')
    const profileHome = join(tempDir, 'profiles', 'work')
    await mkdir(agentRoot, { recursive: true })
    await mkdir(profileHome, { recursive: true })
    await writeFile(join(agentRoot, 'run_agent.py'), '', 'utf-8')
    await writeFile(join(profileHome, 'config.yaml'), 'model:\n  default: work-model\n', 'utf-8')
    const expectedRoot = await realpath(tempDir)
    const expectedProfileHome = await realpath(profileHome)

    const result = await runBridgeProbe(`
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("hermes_bridge", os.environ["BRIDGE_PATH"])
bridge = importlib.util.module_from_spec(spec)
sys.modules["hermes_bridge"] = bridge
spec.loader.exec_module(bridge)

root = os.environ["TEST_HERMES_HOME"]
agent_root = os.path.join(root, "hermes-agent")
profile_home = os.path.join(root, "profiles", "work")
bridge._set_path_env(agent_root, profile_home)

print(json.dumps({
    "home": os.environ.get("HERMES_HOME"),
    "base": os.environ.get("HERMES_AGENT_BRIDGE_BASE_HOME"),
    "profile_home": str(bridge._profile_home("work")),
}))
`)

    expect(result).toEqual({
      home: expectedProfileHome,
      base: expectedRoot,
      profile_home: expectedProfileHome,
    })
  })

  it('falls back to package imports when no Hermes Agent source root exists', async () => {
    const packageDir = join(tempDir, 'site-packages')
    const hermesHome = join(tempDir, 'home')
    await mkdir(packageDir, { recursive: true })
    await mkdir(hermesHome, { recursive: true })
    await writeFile(join(packageDir, 'run_agent.py'), 'class AIAgent: pass\n', 'utf-8')
    const expectedHermesHome = await realpath(hermesHome)

    const result = await runBridgeProbe(`
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("hermes_bridge", os.environ["BRIDGE_PATH"])
bridge = importlib.util.module_from_spec(spec)
sys.modules["hermes_bridge"] = bridge
spec.loader.exec_module(bridge)

package_dir = os.path.join(os.environ["TEST_HERMES_HOME"], "site-packages")
hermes_home = os.path.join(os.environ["TEST_HERMES_HOME"], "home")
sys.path.insert(0, package_dir)
bridge._candidate_agent_roots = lambda raw=None: []
os.environ.pop("HERMES_AGENT_ROOT", None)

bridge._set_path_env(None, hermes_home)
bridge._ensure_agent_imports()
from run_agent import AIAgent

print(json.dumps({
    "agent_root": os.environ.get("HERMES_AGENT_ROOT"),
    "home": os.environ.get("HERMES_HOME"),
    "base": os.environ.get("HERMES_AGENT_BRIDGE_BASE_HOME"),
    "agent_class": AIAgent.__name__,
}))
`)

    expect(result).toEqual({
      agent_root: null,
      home: expectedHermesHome,
      base: expectedHermesHome,
      agent_class: 'AIAgent',
    })
  })

  it('keeps inherited profile env keys for default profile compatibility', async () => {
    await mkdir(join(tempDir, 'profiles', 'work'), { recursive: true })
    await writeFile(join(tempDir, '.env'), 'OPENAI_API_KEY=default-openai\n', 'utf-8')
    await writeFile(join(tempDir, 'profiles', 'work', '.env'), 'GLM_API_KEY=work-glm\n', 'utf-8')
    await writeFile(join(tempDir, 'config.yaml'), 'model:\n  default: default-model\n', 'utf-8')

    const result = await runBridgeProbe(`
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("hermes_bridge", os.environ["BRIDGE_PATH"])
bridge = importlib.util.module_from_spec(spec)
sys.modules["hermes_bridge"] = bridge
spec.loader.exec_module(bridge)

root = os.environ["TEST_HERMES_HOME"]
os.environ["HERMES_HOME"] = root
os.environ["HERMES_AGENT_BRIDGE_BASE_HOME"] = root
os.environ["OPENAI_API_KEY"] = "shell-openai"
os.environ["GLM_API_KEY"] = "shell-glm"

with bridge._profile_env("default"):
    inside = {
        "openai": os.environ.get("OPENAI_API_KEY"),
        "glm": os.environ.get("GLM_API_KEY"),
    }

print(json.dumps({
    "inside": inside,
    "restored_openai": os.environ.get("OPENAI_API_KEY"),
    "restored_glm": os.environ.get("GLM_API_KEY"),
}))
`)

    expect(result).toEqual({
      inside: {
        openai: 'default-openai',
        glm: 'shell-glm',
      },
      restored_openai: 'shell-openai',
      restored_glm: 'shell-glm',
    })
  })

  it('discovers MCP tools in the active profile before creating an agent', async () => {
    const profileHome = join(tempDir, 'profiles', 'work')
    await mkdir(profileHome, { recursive: true })
    await writeFile(join(profileHome, 'config.yaml'), 'model:\n  default: work-model\n', 'utf-8')
    const expectedProfileHome = await realpath(profileHome)

    const result = await runBridgeProbe(`
import importlib.util
import json
import os
import sys
import types

spec = importlib.util.spec_from_file_location("hermes_bridge", os.environ["BRIDGE_PATH"])
bridge = importlib.util.module_from_spec(spec)
sys.modules["hermes_bridge"] = bridge
spec.loader.exec_module(bridge)

root = os.environ["TEST_HERMES_HOME"]
os.environ["HERMES_HOME"] = root
os.environ["HERMES_AGENT_BRIDGE_BASE_HOME"] = root

events = []

tools_pkg = types.ModuleType("tools")
tools_pkg.__path__ = []
sys.modules["tools"] = tools_pkg

mcp_tool = types.ModuleType("tools.mcp_tool")
def discover_mcp_tools():
    events.append({"event": "discover", "home": os.environ.get("HERMES_HOME")})
    return ["mcp_anysearch_search"]
mcp_tool.discover_mcp_tools = discover_mcp_tools
sys.modules["tools.mcp_tool"] = mcp_tool
sys.modules["tools.mcp_tool_discovery"] = mcp_tool

run_agent = types.ModuleType("run_agent")
class FakeAgent:
    def __init__(self, **kwargs):
        events.append({
            "event": "agent",
            "home": os.environ.get("HERMES_HOME"),
            "enabled_toolsets": kwargs.get("enabled_toolsets"),
        })
        self.tools = []
run_agent.AIAgent = FakeAgent
sys.modules["run_agent"] = run_agent

class FakeDbHolder:
    error = None
    def get_for_profile(self, profile):
        return None

bridge._ensure_agent_imports = lambda: None
bridge._load_cfg = lambda: {"model": {"default": "work-model"}, "agent": {}}
bridge._resolve_runtime = lambda model, provider=None: {"provider": "fake"}
bridge._load_enabled_toolsets = lambda: ["mcp-anysearch"]
bridge._load_reasoning_config = lambda *_args: None
bridge._load_service_tier = lambda: None

pool = bridge.AgentPool()
pool._db = FakeDbHolder()
session = pool.get_or_create("session-1", profile="work")

print(json.dumps({
    "events": events,
    "mcp_tool_count": session.config.get("mcp_tool_count"),
    "restored_home": os.environ.get("HERMES_HOME"),
}))
`)

    expect(result).toEqual({
      events: [
        { event: 'discover', home: expectedProfileHome },
        { event: 'agent', home: expectedProfileHome, enabled_toolsets: ['mcp-anysearch'] },
      ],
      mcp_tool_count: 1,
      restored_home: tempDir,
    })
  })

  it('forwards agent turn-boundary callbacks without duplicating streamed text', async () => {
    await writeFile(join(tempDir, 'config.yaml'), 'model:\n  default: fake-model\n', 'utf-8')

    const result = await runBridgeProbe(`
import importlib.util
import json
import os
import sys
import time
import types

spec = importlib.util.spec_from_file_location("hermes_bridge", os.environ["BRIDGE_PATH"])
bridge = importlib.util.module_from_spec(spec)
sys.modules["hermes_bridge"] = bridge
spec.loader.exec_module(bridge)

root = os.environ["TEST_HERMES_HOME"]
os.environ["HERMES_HOME"] = root
os.environ["HERMES_AGENT_BRIDGE_BASE_HOME"] = root

run_agent = types.ModuleType("run_agent")
class FakeAgent:
    def __init__(self, **kwargs):
        self.tools = []
        self.stream_delta_callback = kwargs.get("stream_delta_callback")
        self.interim_assistant_callback = kwargs.get("interim_assistant_callback")

    def run_conversation(self, message, **kwargs):
        stream_callback = kwargs.get("stream_callback")
        if stream_callback:
            stream_callback("hello")
        if self.stream_delta_callback:
            self.stream_delta_callback("ignored-duplicate-text")
            self.stream_delta_callback(None)
        if self.interim_assistant_callback:
            self.interim_assistant_callback("hello", already_streamed=True)
            self.interim_assistant_callback("callback-only", already_streamed=False)
        return {
            "final_response": "hello",
            "messages": [
                {"role": "user", "content": message},
                {"role": "assistant", "content": "hello"},
            ],
        }
run_agent.AIAgent = FakeAgent
sys.modules["run_agent"] = run_agent

class FakeDbHolder:
    error = None
    def get_for_profile(self, profile):
        return None

bridge._ensure_agent_imports = lambda: None
bridge._load_cfg = lambda: {"model": {"default": "fake-model"}, "agent": {}}
bridge._resolve_runtime = lambda model, provider=None: {"provider": "fake"}
bridge._load_enabled_toolsets = lambda: []
bridge._discover_bridge_mcp_tools = lambda: []
bridge._load_reasoning_config = lambda *_args: None
bridge._load_service_tier = lambda: None

pool = bridge.AgentPool()
pool._db = FakeDbHolder()
record = pool.start_chat("session-1", "hi", profile="default")
deadline = time.time() + 2
while record.status == "running" and time.time() < deadline:
    time.sleep(0.01)

output = pool.get_output(record.run_id)
print(json.dumps({
    "status": output["status"],
    "delta": output["delta"],
    "events": output["events"],
}))
`)

    expect(result.status).toBe('complete')
    expect(result.delta).toBe('hello')
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'stream.delta', delta: 'hello' }),
      expect.objectContaining({ event: 'turn.boundary' }),
      expect.objectContaining({ event: 'message.interim', text: 'hello', already_streamed: true }),
      expect.objectContaining({ event: 'message.interim', text: 'callback-only', already_streamed: false }),
    ]))
    expect(result.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'stream.delta', delta: 'ignored-duplicate-text' }),
    ]))
  })

  it('reloads command allowlist for bridge agent creation and runs', async () => {
    await writeFile(join(tempDir, 'config.yaml'), 'model:\n  default: fake-model\n', 'utf-8')

    const result = await runBridgeProbe(`
import importlib.util
import json
import os
import sys
import time
import types

spec = importlib.util.spec_from_file_location("hermes_bridge", os.environ["BRIDGE_PATH"])
bridge = importlib.util.module_from_spec(spec)
sys.modules["hermes_bridge"] = bridge
spec.loader.exec_module(bridge)

root = os.environ["TEST_HERMES_HOME"]
os.environ["HERMES_HOME"] = root
os.environ["HERMES_AGENT_BRIDGE_BASE_HOME"] = root

allowlist_homes = []
tools_pkg = types.ModuleType("tools")
tools_pkg.__path__ = []
sys.modules["tools"] = tools_pkg

approval = types.ModuleType("tools.approval")
def load_permanent_allowlist():
    allowlist_homes.append(os.environ.get("HERMES_HOME", ""))
    return {"script execution via -e/-c flag"}
def set_current_session_key(session_key):
    return None
def register_gateway_notify(session_key, callback):
    pass
def reset_current_session_key(token):
    pass
def unregister_gateway_notify(session_key):
    pass
approval.load_permanent_allowlist = load_permanent_allowlist
approval.set_current_session_key = set_current_session_key
approval.register_gateway_notify = register_gateway_notify
approval.reset_current_session_key = reset_current_session_key
approval.unregister_gateway_notify = unregister_gateway_notify
sys.modules["tools.approval"] = approval

terminal_tool = types.ModuleType("tools.terminal_tool")
terminal_tool.set_approval_callback = lambda callback: None
sys.modules["tools.terminal_tool"] = terminal_tool

run_agent = types.ModuleType("run_agent")
class FakeAgent:
    def __init__(self, **kwargs):
        self.tools = []

    def run_conversation(self, message, **kwargs):
        stream_callback = kwargs.get("stream_callback")
        if stream_callback:
            stream_callback("ok")
        return {
            "final_response": "ok",
            "messages": [
                {"role": "user", "content": message},
                {"role": "assistant", "content": "ok"},
            ],
        }
run_agent.AIAgent = FakeAgent
sys.modules["run_agent"] = run_agent

class FakeDbHolder:
    error = None
    def get_for_profile(self, profile):
        return None

bridge._ensure_agent_imports = lambda: None
bridge._load_cfg = lambda: {"model": {"default": "fake-model"}, "agent": {}}
bridge._resolve_runtime = lambda model, provider=None: {"provider": "fake"}
bridge._load_enabled_toolsets = lambda: []
bridge._discover_bridge_mcp_tools = lambda: []
bridge._load_reasoning_config = lambda *_args: None
bridge._load_service_tier = lambda: None

pool = bridge.AgentPool()
pool._db = FakeDbHolder()
record = pool.start_chat("session-allowlist", "hi", profile="default")
deadline = time.time() + 2
while record.status == "running" and time.time() < deadline:
    time.sleep(0.01)

print(json.dumps({
    "status": record.status,
    "allowlist_homes": allowlist_homes,
}))
`)

    const expectedHome = await realpath(tempDir)
    expect(result.status).toBe('complete')
    expect(result.allowlist_homes.length).toBeGreaterThanOrEqual(2)
    expect(result.allowlist_homes.every((home: string) => home === expectedHome)).toBe(true)
  })

  it('handles Windows netstat output decode failures without crashing', async () => {
    const result = await runBridgeProbe(`
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("hermes_bridge", os.environ["BRIDGE_PATH"])
bridge = importlib.util.module_from_spec(spec)
sys.modules["hermes_bridge"] = bridge
spec.loader.exec_module(bridge)

class EmptyStdoutResult:
    stdout = None

def fake_run_empty(*args, **kwargs):
    return EmptyStdoutResult()

class NetstatResult:
    stdout = "  TCP    127.0.0.1:18765    0.0.0.0:0    LISTENING    4321\\r\\n"

def fake_run_listener(*args, **kwargs):
    return NetstatResult()

original_name = bridge.os.name
original_pid = bridge.os.getpid
original_run = bridge.subprocess.run
try:
    bridge.os.name = "nt"
    bridge.os.getpid = lambda: 1234
    bridge.subprocess.run = fake_run_empty
    empty = bridge._windows_listening_pids_on_port(18765)
    bridge.subprocess.run = fake_run_listener
    listener = bridge._windows_listening_pids_on_port(18765)
finally:
    bridge.os.name = original_name
    bridge.os.getpid = original_pid
    bridge.subprocess.run = original_run

print(json.dumps({
    "empty": empty,
    "listener": listener,
}))
`)

    expect(result).toEqual({
      empty: [],
      listener: [4321],
    })
  })


})
