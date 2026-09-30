import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'

function probe(mode: string): any {
  try {
    return JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', String.raw`
import importlib.util
import json
import os
import sys
import tempfile
import types
from pathlib import Path

path = Path('packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py').resolve()
spec = importlib.util.spec_from_file_location('hermes_bridge', path)
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)
import bridge_runtime

mode = sys.argv[1]
calls = []
def safe_load(value):
    calls.append('load')
    return json.loads(value.read() if hasattr(value, 'read') else value)

preferred = types.ModuleType('hermes_yaml')
preferred.safe_load = safe_load
legacy = types.ModuleType('yaml')
legacy.safe_load = safe_load
sys.modules['hermes_yaml'] = None if mode == 'legacy' else preferred
sys.modules['yaml'] = legacy if mode == 'legacy' else None
if mode == 'broken-native':
    del sys.modules['hermes_yaml']
    sys.modules['yaml'] = legacy
    class BrokenNativeYaml:
        def find_spec(self, fullname, path=None, target=None):
            if fullname == 'hermes_yaml':
                raise ModuleNotFoundError("No module named 'yaml_dependency'", name='yaml_dependency')
    sys.meta_path.insert(0, BrokenNativeYaml())

utils = types.ModuleType('utils')
def atomic_yaml_write(path, data, **kwargs):
    calls.append('atomic_write')
    assert kwargs == {'sort_keys': False}
    Path(path).write_text(json.dumps(data))
utils.atomic_yaml_write = atomic_yaml_write
sys.modules['utils'] = utils
bridge._ensure_agent_imports = lambda: None
sys.modules['hermes_cli.config'] = None

with tempfile.TemporaryDirectory(prefix='bridge-yaml-') as temp:
    root = Path(temp)
    profile = root / 'profiles' / 'work'
    profile.mkdir(parents=True)
    original = {'mcp_servers': {'probe': {'command': 'test', 'enabled': False}},
                'terminal': {'backend': 'local', 'cwd': '/profile-workspace',
                             'docker_env': {'LABEL': '值'}}, 'unrelated': 'keep'}
    (root / 'config.yaml').write_text(json.dumps({'unrelated': 'base'}))
    (profile / 'config.yaml').write_text(json.dumps(original))
    os.environ['HERMES_AGENT_BRIDGE_BASE_HOME'] = str(root)
    os.environ['HERMES_HOME'] = str(profile)
    os.environ['TERMINAL_CWD'] = '/stale-workspace'
    server = bridge.BridgeServer('tcp://127.0.0.1:1')
    read = server._read_mcp_config('work')
    updated = {**read, 'mcp_servers': {'replacement': {'command': 'test2'}}}
    server._save_mcp_config(updated, 'work')
    saved = server._read_mcp_config('work')
    fallback = bridge_runtime._load_cfg()
    bridge_runtime._refresh_terminal_env()
    print(json.dumps({'read': read, 'saved': saved, 'fallback': fallback,
                      'base': json.loads((root / 'config.yaml').read_text()),
                      'terminal': {'backend': os.environ.get('TERMINAL_ENV'),
                                   'cwd': os.environ.get('TERMINAL_CWD'),
                                   'docker_env': json.loads(os.environ['TERMINAL_DOCKER_ENV'])},
                      'atomic_writes': calls.count('atomic_write')}))
`, mode], { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: 4000 }))
  } catch (error) {
    const detail = error as { stderr?: string; stdout?: string }
    throw new Error([detail.stdout, detail.stderr].filter(Boolean).join('\n'))
  }
}

describe('Hermes bridge YAML compatibility', () => {
  it.each(['native', 'legacy'])('reads and saves MCP config with the %s YAML implementation', (mode) => {
    const result = probe(mode)
    expect(result.read.mcp_servers.probe.enabled).toBe(false)
    expect(result.saved).toEqual({
      ...result.read,
      mcp_servers: { replacement: { command: 'test2' } },
    })
    expect(result.fallback).toEqual(result.saved)
    expect(result.base).toEqual({ unrelated: 'base' })
    expect(result.terminal).toEqual({ backend: 'local', cwd: '/profile-workspace', docker_env: { LABEL: '值' } })
    expect(result.atomic_writes).toBe(1)
  })

  it('does not hide a broken native YAML dependency behind the legacy parser', () => {
    expect(() => probe('broken-native')).toThrow("No module named 'yaml_dependency'")
  })
})
