import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('packages/server/src/modules/hermes/services/plugins/plugins.ts', 'utf8')
const discovery = source.match(/const PYTHON_BRIDGE = String.raw`([\s\S]*?)`/)![1]

function probe(mode: string): any {
  try {
    return JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-c', String.raw`
import importlib.abc
import importlib.util
import json
import os
import sys
import tempfile
import types
from pathlib import Path

code, mode = sys.argv[1:]
bootstrapped = mode == 'legacy'
class Bootstrap(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'hermes_bootstrap':
            return importlib.util.spec_from_loader(fullname, self)
    def create_module(self, spec):
        return None
    def exec_module(self, module):
        global bootstrapped
        if mode == 'broken':
            raise ModuleNotFoundError("No module named 'bootstrap_dependency'", name='bootstrap_dependency')
        bootstrapped = True
sys.meta_path.insert(0, Bootstrap())
if mode == 'legacy':
    sys.modules['hermes_bootstrap'] = None

yaml = types.ModuleType('yaml')
yaml.safe_load = json.loads
sys.modules['yaml'] = yaml if mode == 'legacy' else None
sys.modules['hermes_yaml'] = None if mode == 'legacy' else yaml

with tempfile.TemporaryDirectory(prefix='plugin-runtime-') as temp:
    base = Path(temp)
    home = base / 'profiles' / 'work'
    plugin_dir = home / 'plugins' / 'demo'
    plugin_dir.mkdir(parents=True)
    (base / 'config.yaml').write_text(json.dumps({'plugins': {'disabled': ['demo']}}))
    (home / 'config.yaml').write_text(json.dumps({'plugins': {'enabled': ['demo']}}))
    (plugin_dir / 'plugin.yaml').write_text(json.dumps({'tools': ['demo_tool'], 'hooks': ['on_event'], 'requires_env': ['DEMO_KEY']}))
    os.environ.update(HERMES_AGENT_BASE_HOME=str(base), HERMES_HOME=str(home),
                      HERMES_AGENT_ROOT_RESOLVED='', HERMES_ENABLE_PROJECT_PLUGINS='0')

    class PluginManager:
        def __init__(self):
            assert bootstrapped, 'plugin discovery ran before Hermes bootstrap'
        def _scan_directory(self, path, source, **kwargs):
            if source != 'user':
                return []
            return [types.SimpleNamespace(key='demo', name='demo', kind='standalone',
                source='user', version='1', description='', author='', path=str(plugin_dir))]
        def _scan_entry_points(self):
            return []
    plugins = types.ModuleType('hermes_cli.plugins')
    plugins.PluginManager = PluginManager
    plugins.get_bundled_plugins_dir = lambda: base / 'bundled'
    plugins._get_disabled_plugins = lambda: set()
    plugins._get_enabled_plugins = lambda: None
    package = types.ModuleType('hermes_cli')
    package.__path__ = []
    sys.modules['hermes_cli'] = package
    sys.modules['hermes_cli.plugins'] = plugins
    constants = types.ModuleType('hermes_constants')
    constants.get_hermes_home = lambda: home
    sys.modules['hermes_constants'] = constants
    exec(code)
`, discovery, mode], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }))
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string }
    throw new Error([detail.stdout, detail.stderr].filter(Boolean).join('\n'))
  }
}

describe('Hermes plugin runtime compatibility', () => {
  it.each(['native', 'legacy'])('loads profile configuration and manifest metadata with the %s runtime', (mode) => {
    const result = probe(mode)
    expect(result.warnings).toEqual([])
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]).toMatchObject({
      key: 'demo', configStatus: 'enabled', effectiveStatus: 'enabled',
      providesTools: ['demo_tool'], providesHooks: ['on_event'], requiresEnv: ['DEMO_KEY'],
    })
  })

  it('surfaces missing dependencies inside the bootstrap', () => {
    expect(() => probe('broken')).toThrow('bootstrap_dependency')
  })
})
