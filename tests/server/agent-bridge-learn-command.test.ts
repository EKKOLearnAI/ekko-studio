import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'

function runPython(script: string): any {
  try {
    const output = execFileSync('python3', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    return JSON.parse(output)
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'Python bridge learn command script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

const harness = String.raw`
import contextlib
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

bridge_runtime = types.ModuleType("bridge_runtime")
bridge_runtime.APPROVAL_TIMEOUT_MS = 1000
bridge_runtime.APPROVAL_TIMEOUT_SECONDS = 1
bridge_runtime._approval_pattern_keys = lambda *_args, **_kwargs: []
bridge_runtime._base_hermes_home = lambda: Path(tempfile.gettempdir())
bridge_runtime._bridge_platform = lambda: "agent-bridge"
bridge_runtime._cfg_max_turns = lambda *_args, **_kwargs: 20
bridge_runtime._discover_bridge_mcp_tools = lambda *_args, **_kwargs: []
bridge_runtime._ensure_agent_imports = lambda: None
bridge_runtime._hermes_home = lambda *_args, **_kwargs: Path(tempfile.gettempdir())
bridge_runtime._install_execute_code_approval_memory_patch = lambda *_args, **_kwargs: None
bridge_runtime._jsonable = lambda value: value
bridge_runtime._load_cfg = lambda *_args, **_kwargs: {}
bridge_runtime._load_disabled_toolsets = lambda *_args, **_kwargs: None
bridge_runtime._load_enabled_toolsets = lambda *_args, **_kwargs: []
bridge_runtime._load_fallback_model = lambda *_args, **_kwargs: None
bridge_runtime._load_reasoning_config = lambda *_args, **_kwargs: {}
bridge_runtime._load_service_tier = lambda *_args, **_kwargs: None
bridge_runtime._mcp_tool_names_from_names = lambda *_args, **_kwargs: []
bridge_runtime._persist_execute_code_approval_choice = lambda *_args, **_kwargs: None
bridge_runtime._profile_home = lambda *_args, **_kwargs: Path(tempfile.gettempdir())
bridge_runtime._refresh_approval_allowlist = lambda *_args, **_kwargs: None
bridge_runtime._refresh_worker_profile_env = lambda *_args, **_kwargs: None
bridge_runtime._resolve_model = lambda *_args, **_kwargs: ("model", "provider")
bridge_runtime._resolve_runtime = lambda *_args, **_kwargs: {}
bridge_runtime._suppress_bridge_platform_hint = contextlib.nullcontext
bridge_runtime._title_user_message = lambda value: value
bridge_runtime._tool_names_from_definitions = lambda *_args, **_kwargs: []

@contextlib.contextmanager
def _profile_env(_profile):
    yield

bridge_runtime._profile_env = _profile_env
sys.modules["bridge_runtime"] = bridge_runtime

spec = importlib.util.spec_from_file_location(
    "bridge_pool",
    "packages/server/src/modules/hermes/services/bridge/python/bridge_pool.py",
)
bridge_pool = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["bridge_pool"] = bridge_pool
spec.loader.exec_module(bridge_pool)
`

describe('agent bridge /learn command', () => {
  it('returns a generated learn prompt as a handled bridge command', () => {
    const result = runPython(`${harness}
agent_pkg = types.ModuleType("agent")
agent_pkg.__path__ = []
sys.modules["agent"] = agent_pkg

learn_prompt = types.ModuleType("agent.learn_prompt")
learn_prompt.build_learn_prompt = lambda arg: "expanded learn prompt: " + arg
sys.modules["agent.learn_prompt"] = learn_prompt

pool = bridge_pool.AgentPool()
print(json.dumps(pool.dispatch_command("session-1", "/learn from docs", "default")))
`)

    expect(result).toEqual({
      session_id: 'session-1',
      command: 'learn',
      handled: true,
      type: 'learn',
      message: 'expanded learn prompt: from docs',
    })
  })

  it('returns a clear unsupported-runtime message when agent.learn_prompt is missing', () => {
    const result = runPython(`${harness}
agent_pkg = types.ModuleType("agent")
agent_pkg.__path__ = []
sys.modules["agent"] = agent_pkg
sys.modules.pop("agent.learn_prompt", None)

pool = bridge_pool.AgentPool()
print(json.dumps(pool.dispatch_command("session-1", "/learn from docs", "default")))
`)

    expect(result).toEqual({
      session_id: 'session-1',
      command: 'learn',
      handled: false,
      type: 'learn',
      message: '/learn requires a newer Hermes Agent runtime with agent.learn_prompt.',
    })
  })
})
