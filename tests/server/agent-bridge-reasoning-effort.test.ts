import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

function runPython(script: string): any {
  try {
    return JSON.parse(execFileSync('python3', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERMES_')
        && !key.startsWith('BILI_') && !key.startsWith('BILLION_CONTEXT_') && key !== 'PYTHONPATH')),
    }))
  }
  catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'Python bridge reasoning script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

const reasoningHarness = String.raw`
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

config = {
    "model": "gpt-5.6-luna",
    "agent": {
        "reasoning_effort": "xhigh",
        "reasoning_overrides": {
            "gpt-5.6-luna": "max",
            "gpt-5.6-sol": "xhigh",
        },
    },
}
resolved_configs = {
    "gpt-5.6-luna": {"enabled": True, "effort": "max"},
    "gpt-5.6-sol": {"enabled": True, "effort": "xhigh"},
    "gpt-5.6-orbit": {"enabled": True, "effort": "xhigh"},
}
resolver_calls = []

hermes_constants = types.ModuleType("hermes_constants")
def parse_reasoning_effort(effort):
    normalized = str(effort or "").strip()
    return {"enabled": True, "effort": normalized} if normalized else None
def resolve_reasoning_config(cfg, model):
    resolver_calls.append({"model": model, "received_config": cfg is config})
    return resolved_configs[model]
hermes_constants.parse_reasoning_effort = parse_reasoning_effort
hermes_constants.resolve_reasoning_config = resolve_reasoning_config
sys.modules["hermes_constants"] = hermes_constants

runtime_spec = importlib.util.spec_from_file_location(
    "bridge_runtime",
    "packages/server/src/modules/hermes/services/bridge/python/bridge_runtime.py",
)
bridge_runtime = importlib.util.module_from_spec(runtime_spec)
assert runtime_spec.loader is not None
sys.modules["bridge_runtime"] = bridge_runtime
runtime_spec.loader.exec_module(bridge_runtime)

bridge_runtime._ensure_agent_imports = lambda: None
bridge_runtime._load_cfg = lambda: config
bridge_runtime._base_hermes_home = lambda: Path(tempfile.gettempdir())
bridge_runtime._bridge_platform = lambda: "agent-bridge"
bridge_runtime._cfg_max_turns = lambda *_args, **_kwargs: 20
bridge_runtime._discover_bridge_mcp_tools = lambda *_args, **_kwargs: []
bridge_runtime._hermes_home = lambda *_args, **_kwargs: Path(tempfile.gettempdir())
bridge_runtime._install_execute_code_approval_memory_patch = lambda *_args, **_kwargs: None
bridge_runtime._jsonable = lambda value: value
bridge_runtime._load_enabled_toolsets = lambda *_args, **_kwargs: []
bridge_runtime._load_service_tier = lambda *_args, **_kwargs: None
bridge_runtime._mcp_tool_names_from_names = lambda *_args, **_kwargs: []
bridge_runtime._profile_home = lambda *_args, **_kwargs: Path(tempfile.gettempdir())
bridge_runtime._refresh_approval_allowlist = lambda *_args, **_kwargs: None
bridge_runtime._refresh_worker_profile_env = lambda *_args, **_kwargs: None
bridge_runtime._resolve_model = lambda cfg: str(cfg.get("model") or "")
bridge_runtime._resolve_runtime = lambda model, provider=None: {"provider": provider or "openai"}
bridge_runtime._suppress_bridge_platform_hint = lambda: None
bridge_runtime._tool_names_from_definitions = lambda *_args, **_kwargs: []

@contextlib.contextmanager
def profile_env(_profile):
    yield
bridge_runtime._profile_env = profile_env

class FakeAIAgent:
    def __init__(self, **kwargs):
        self.model = kwargs.get("model")
        self.provider = kwargs.get("provider")
        self.reasoning_config = kwargs.get("reasoning_config")
        self.tools = []
        self.raise_on_run = False
        self.run_reasoning_configs = []

    def switch_model(self, **kwargs):
        self.model = kwargs["new_model"]
        self.provider = kwargs["new_provider"]

    def run_conversation(self, _message, **_kwargs):
        self.run_reasoning_configs.append(dict(self.reasoning_config or {}))
        if self.raise_on_run:
            raise RuntimeError("run failed")
        return {"final_response": "ok", "messages": []}

run_agent = types.ModuleType("run_agent")
run_agent.AIAgent = FakeAIAgent
sys.modules["run_agent"] = run_agent

pool_spec = importlib.util.spec_from_file_location(
    "bridge_pool",
    "packages/server/src/modules/hermes/services/bridge/python/bridge_pool.py",
)
bridge_pool = importlib.util.module_from_spec(pool_spec)
assert pool_spec.loader is not None
sys.modules["bridge_pool"] = bridge_pool
pool_spec.loader.exec_module(bridge_pool)

pool = bridge_pool.AgentPool()
pool._db = types.SimpleNamespace(
    get_for_profile=lambda _profile: None,
    error=None,
)
`

describe('AgentBridgeClient.chat reasoning_effort forwarding', () => {
  it('uses Hermes model-aware reasoning for fresh AgentPool sessions', () => {
    const result = runPython(`${reasoningHarness}
luna = pool.get_or_create("luna", model="gpt-5.6-luna")
sol = pool.get_or_create("sol", model="gpt-5.6-sol")
orbit = pool.get_or_create("orbit", model="gpt-5.6-orbit")
print(json.dumps({
    "luna": luna.agent.reasoning_config,
    "sol": sol.agent.reasoning_config,
    "orbit": orbit.agent.reasoning_config,
    "resolver_calls": resolver_calls,
}))
`)

    expect(result.luna.effort).toBe('max')
    expect(result.sol.effort).toBe('xhigh')
    expect(result.orbit.effort).toBe('xhigh')
    expect(result.resolver_calls).toEqual([
      { model: 'gpt-5.6-luna', received_config: true },
      { model: 'gpt-5.6-sol', received_config: true },
      { model: 'gpt-5.6-orbit', received_config: true },
    ])
  })

  it('refreshes model-aware reasoning for a loaded session switched from Luna to Sol', () => {
    const result = runPython(`${reasoningHarness}
session = pool.get_or_create("switched", model="gpt-5.6-luna")
before = dict(session.agent.reasoning_config)
pool.switch_session_model("switched", "gpt-5.6-sol", "openai", "default")
print(json.dumps({
    "before": before,
    "after": session.agent.reasoning_config,
    "model": session.config["model"],
}))
`)

    expect(result.before.effort).toBe('max')
    expect(result.after.effort).toBe('xhigh')
    expect(result.model).toBe('gpt-5.6-sol')
  })

  it('keeps the global parser fallback for Hermes runtimes without the shared resolver', () => {
    const result = runPython(`${reasoningHarness}
delattr(hermes_constants, "resolve_reasoning_config")
legacy = bridge_runtime._load_reasoning_config("gpt-5.6-luna")
print(json.dumps(legacy))
`)

    expect(result).toEqual({ enabled: true, effort: 'xhigh' })
  })

  it('does not hide errors raised inside the shared Hermes resolver', () => {
    const result = runPython(`${reasoningHarness}
def exploding_resolver(_cfg, _model):
    raise RuntimeError("resolver exploded")
hermes_constants.resolve_reasoning_config = exploding_resolver
caught = None
try:
    bridge_runtime._load_reasoning_config("gpt-5.6-luna")
except RuntimeError as exc:
    caught = str(exc)
print(json.dumps({"caught": caught}))
`)

    expect(result.caught).toBe('resolver exploded')
  })

  it('restores the model-aware default after explicit run overrides succeed or fail', () => {
    const result = runPython(`${reasoningHarness}
session = pool.get_or_create("override", model="gpt-5.6-luna")
pool._enter_exec_ask_scope = lambda: None
pool._exit_exec_ask_scope = lambda: None
pool._install_approval_dispatcher_for_current_thread = lambda *_args: None
pool._approval_callback = lambda *_args: None
pool._prepersist_user_message = lambda *_args: None
pool._session_db_message_count = lambda *_args: None
pool._prepend_pending_model_switch_note = lambda _session, message: message
pool._sync_result_tail_to_session_db = lambda *_args: None
pool._result_from_agent_messages_for_sync = lambda *_args: None
pool._apply_pending_session_model_switch = lambda *_args: None

default_before = dict(session.agent.reasoning_config)
session.running = True
success = bridge_pool.RunRecord("success", session.session_id)
pool._run_chat(session, success, "hello", reasoning_effort="high")
after_success = dict(session.agent.reasoning_config)

session.agent.raise_on_run = True
session.running = True
failure = bridge_pool.RunRecord("failure", session.session_id)
pool._run_chat(session, failure, "hello", reasoning_effort="low")
after_failure = dict(session.agent.reasoning_config)

print(json.dumps({
    "default_before": default_before,
    "seen_during_runs": session.agent.run_reasoning_configs,
    "after_success": after_success,
    "after_failure": after_failure,
    "statuses": [success.status, failure.status],
    "failure_error": failure.error,
}))
`)

    expect(result.default_before.effort).toBe('max')
    expect(result.seen_during_runs).toEqual([
      { enabled: true, effort: 'high' },
      { enabled: true, effort: 'low' },
    ])
    expect(result.after_success.effort).toBe('max')
    expect(result.after_failure.effort).toBe('max')
    expect(result.statuses).toEqual(['complete', 'error'])
    expect(result.failure_error).toBe('run failed')
  })

  it('forwards maximum reasoning_effort when provided in options', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({
      ok: true,
      run_id: 'r-1',
      session_id: 's-1',
      status: 'running',
    })

    await client.chat('s-1', 'hello', undefined, undefined, 'default', {
      reasoning_effort: 'max',
    })

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      action: 'chat',
      session_id: 's-1',
      reasoning_effort: 'max',
    }))
  })

  it('omits reasoning_effort entirely when the option is not set', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({
      ok: true,
      run_id: 'r-2',
      session_id: 's-2',
      status: 'running',
    })

    await client.chat('s-2', 'hello')

    const call = request.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(call).toBeDefined()
    expect(call).not.toHaveProperty('reasoning_effort')
  })

  it('omits reasoning_effort when option is an empty string', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({
      ok: true,
      run_id: 'r-3',
      session_id: 's-3',
      status: 'running',
    })

    await client.chat('s-3', 'hello', undefined, undefined, undefined, {
      reasoning_effort: '',
    })

    const call = request.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(call).toBeDefined()
    expect(call).not.toHaveProperty('reasoning_effort')
  })

  it('keeps Agent Bridge on profile defaults without Workflow execution-policy plumbing', () => {
    const sources = [
      'packages/server/src/modules/hermes/services/bridge/client.ts',
      'packages/server/src/modules/studio/services/chat-run/types.ts',
      'packages/server/src/modules/studio/sockets/chat-run.ts',
      'packages/server/src/modules/studio/services/chat-run/handle-bridge-run.ts',
      'packages/server/src/modules/hermes/services/bridge/python/bridge_server.py',
      'packages/server/src/modules/hermes/services/bridge/python/bridge_pool.py',
      'packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py',
    ].map(path => readFileSync(path, 'utf8'))
    for (const source of sources) {
      for (const removed of ['executionPolicy', 'execution_policy', 'allowedToolsets', 'allowedTools', 'skipMemory', 'skipContextFiles']) {
        expect(source).not.toContain(removed)
      }
    }
  })

  it('does not expose a caller-controlled api mode through Agent Bridge', () => {
    const client = readFileSync('packages/server/src/modules/hermes/services/bridge/client.ts', 'utf8')
    const bridgeRun = readFileSync('packages/server/src/modules/studio/services/chat-run/handle-bridge-run.ts', 'utf8')
    const server = readFileSync('packages/server/src/modules/hermes/services/bridge/python/bridge_server.py', 'utf8')
    const pool = readFileSync('packages/server/src/modules/hermes/services/bridge/python/bridge_pool.py', 'utf8')
    expect(client).not.toContain('options.apiMode')
    expect(bridgeRun).not.toContain('data.apiMode')
    expect(bridgeRun).not.toContain('data.api_mode')
    expect(server).not.toContain('req.get("api_mode")')
    expect(pool).not.toContain('requested_api_mode')
    expect(pool).not.toContain('api_mode: str | None')
  })

  it('forwards workspace to chat and context estimate requests', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({
        ok: true,
        run_id: 'r-workspace',
        session_id: 's-workspace',
        status: 'running',
      })
      .mockResolvedValueOnce({
        ok: true,
        session_id: 's-workspace',
        token_count: 0,
        message_count: 0,
        tool_count: 0,
        system_prompt_chars: 0,
      })

    await client.chat('s-workspace', 'hello', undefined, undefined, 'default', {
      workspace: 'C:\\Users\\tester\\workspace',
    })
    await client.contextEstimate('s-workspace', [], undefined, 'default', {
      workspace: 'C:\\Users\\tester\\workspace',
    })

    expect(request.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      action: 'chat',
      session_id: 's-workspace',
      workspace: 'C:\\Users\\tester\\workspace',
    }))
    expect(request.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      action: 'context_estimate',
      session_id: 's-workspace',
      workspace: 'C:\\Users\\tester\\workspace',
    }))
  })
  it('falls back to the profile default when the Python runtime cannot apply the requested reasoning effort', () => {
    const source = readFileSync('packages/server/src/modules/hermes/services/bridge/python/bridge_pool.py', 'utf8')
    expect(source).not.toContain('raise ValueError(f"reasoning effort is unavailable: {reasoning_effort}")')
    expect(source).toContain('Non-fatal: fall through to default reasoning_config')
  })

  it('preserves reasoning and api mode across the run queue', () => {
    const source = readFileSync('packages/server/src/modules/studio/sockets/chat-run.ts', 'utf8')
    expect(source).toContain('reasoningEffort: data.reasoning_effort')
    expect(source).toContain('apiMode: data.apiMode')
    expect(source).toContain('reasoning_effort: next.reasoningEffort')
    expect(source).toContain('apiMode: next.apiMode')
  })

})
