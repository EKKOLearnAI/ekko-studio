import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

function runPython(script: string): Record<string, unknown> {
  try {
    return JSON.parse(execFileSync('python3', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERMES_')
        && !key.startsWith('BILI_') && !key.startsWith('BILLION_CONTEXT_') && key !== 'PYTHONPATH')),
    }))
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'Python agent bridge fallback test failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

describe('Agent Bridge fallback providers', () => {
  it('passes the configured fallback chain to each newly created agent', () => {
    const result = runPython(String.raw`
import contextlib
import importlib.util
import json
import os
import sys
import tempfile
import types
from pathlib import Path

for key in list(os.environ):
    if key.startswith(("HERMES_", "BILI_", "BILLION_CONTEXT_")):
        os.environ.pop(key)
sys.path.insert(0, str(Path("packages/server/src/modules/hermes/services/bridge/python").resolve()))

hermes_plugins = types.ModuleType("hermes_cli.plugins")
hermes_plugins.get_plugin_manager = lambda: types.SimpleNamespace(discover_and_load=lambda: None, list_plugins=lambda: [])
sys.modules["hermes_cli.plugins"] = hermes_plugins

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
bridge_runtime._load_cfg = lambda *_args, **_kwargs: {"fallback_providers": [{"provider": "backup", "model": "backup-model"}]}
bridge_runtime._load_enabled_toolsets = lambda *_args, **_kwargs: []
bridge_runtime._load_fallback_model = lambda cfg: cfg["fallback_providers"]
bridge_runtime._load_reasoning_config = lambda *_args, **_kwargs: {}
bridge_runtime._load_service_tier = lambda *_args, **_kwargs: None
bridge_runtime._mcp_tool_names_from_names = lambda *_args, **_kwargs: []
bridge_runtime._persist_execute_code_approval_choice = lambda *_args, **_kwargs: None
bridge_runtime._profile_home = lambda *_args, **_kwargs: Path(tempfile.gettempdir())
bridge_runtime._refresh_approval_allowlist = lambda *_args, **_kwargs: None
bridge_runtime._refresh_worker_profile_env = lambda *_args, **_kwargs: None
bridge_runtime._resolve_model = lambda *_args, **_kwargs: "primary-model"
bridge_runtime._resolve_runtime = lambda *_args, **_kwargs: {"provider": "primary"}
bridge_runtime._suppress_bridge_platform_hint = lambda: None
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

run_agent = types.ModuleType("run_agent")
class AIAgent:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.tools = []
run_agent.AIAgent = AIAgent
sys.modules["run_agent"] = run_agent

session = bridge_pool.AgentPool().get_or_create("session-1")
print(json.dumps({"fallback_model": session.agent.kwargs.get("fallback_model")}))
`)

    expect(result).toEqual({
      fallback_model: [{ provider: 'backup', model: 'backup-model' }],
    })
  })
})
