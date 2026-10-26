import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import YAML from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { materializeFakePython } from './helpers/windows-fake-python'

describe('Hermes plugin configuration', () => {
  const originalEnv = { ...process.env }
  let tempDir = ''

  beforeEach(() => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-plugins-config-'))
    process.env = { ...originalEnv }
    process.env.HERMES_HOME = join(tempDir, 'home')
    installFakeHermes()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  function installFakeHermes() {
    const agentRoot = join(tempDir, 'agent')
    const venvBin = join(agentRoot, '.venv', 'bin')
    const hermesCliDir = join(agentRoot, 'hermes_cli')
    let fakePython = join(venvBin, 'python')
    const fakeHermes = join(venvBin, 'hermes')

    mkdirSync(venvBin, { recursive: true })
    mkdirSync(hermesCliDir, { recursive: true })
    writeFileSync(join(agentRoot, 'run_agent.py'), '')
    writeFileSync(join(hermesCliDir, 'plugins.py'), '')
    writeFileSync(fakePython, [
      '#!/bin/sh',
      'printf "%s\\n" "$PLUGIN_JSON"',
      '',
    ].join('\n'))
    chmodSync(fakePython, 0o755)
    fakePython = materializeFakePython(fakePython)
    writeFileSync(fakeHermes, `#!${fakePython}\n`)
    chmodSync(fakeHermes, 0o755)

    process.env.HERMES_BIN = fakeHermes
    process.env.HERMES_AGENT_ROOT = agentRoot
    process.env.HERMES_AGENT_BRIDGE_PYTHON = fakePython
    process.env.PLUGIN_JSON = JSON.stringify({
      plugins: [{
        key: 'local-plugin',
        name: 'local-plugin',
        kind: 'standalone',
        source: 'user',
        configStatus: 'not-enabled',
        effectiveStatus: 'inactive',
        version: '',
        description: '',
        author: '',
        path: join(process.env.HERMES_HOME!, 'plugins', 'local-plugin'),
        providesTools: [],
        providesHooks: [],
        requiresEnv: [],
      }],
      warnings: [],
      metadata: {
        hermesAgentRoot: agentRoot,
        pythonExecutable: fakePython,
        cwd: process.cwd(),
        projectPluginsEnabled: false,
      },
    })
  }

  function readConfig() {
    return YAML.load(readFileSync(join(process.env.HERMES_HOME!, 'config.yaml'), 'utf-8')) as any
  }

  it('enables standalone user plugins in the active profile config', async () => {
    mkdirSync(process.env.HERMES_HOME!, { recursive: true })
    writeFileSync(join(process.env.HERMES_HOME!, 'config.yaml'), [
      'plugins:',
      '  disabled:',
      '    - local-plugin',
      '',
    ].join('\n'))

    const { setHermesPluginEnabled } = await import('../../packages/server/src/modules/hermes/services/plugins/plugins')
    await expect(setHermesPluginEnabled(undefined, 'local-plugin', true)).resolves.toEqual({
      key: 'local-plugin',
      enabled: true,
    })

    expect(readConfig().plugins).toEqual({
      enabled: ['local-plugin'],
      disabled: [],
    })
  })

  it('disables standalone user plugins in the active profile config', async () => {
    mkdirSync(process.env.HERMES_HOME!, { recursive: true })
    writeFileSync(join(process.env.HERMES_HOME!, 'config.yaml'), [
      'plugins:',
      '  enabled:',
      '    - local-plugin',
      '',
    ].join('\n'))

    const { setHermesPluginEnabled } = await import('../../packages/server/src/modules/hermes/services/plugins/plugins')
    await expect(setHermesPluginEnabled(undefined, 'local-plugin', false)).resolves.toEqual({
      key: 'local-plugin',
      enabled: false,
    })

    expect(readConfig().plugins).toEqual({
      enabled: [],
      disabled: ['local-plugin'],
    })
  })

  it('rejects bundled plugins because they are managed by Hermes Agent', async () => {
    process.env.PLUGIN_JSON = JSON.stringify({
      plugins: [{
        key: 'bundled-plugin',
        name: 'bundled-plugin',
        kind: 'standalone',
        source: 'bundled',
        configStatus: 'auto',
        effectiveStatus: 'auto-active',
        version: '',
        description: '',
        author: '',
        path: '',
        providesTools: [],
        providesHooks: [],
        requiresEnv: [],
      }],
      warnings: [],
      metadata: { hermesAgentRoot: '', pythonExecutable: '', cwd: '', projectPluginsEnabled: false },
    })

    const { setHermesPluginEnabled } = await import('../../packages/server/src/modules/hermes/services/plugins/plugins')
    await expect(setHermesPluginEnabled(undefined, 'bundled-plugin', false)).rejects.toThrow('cannot be managed')
  })
})
