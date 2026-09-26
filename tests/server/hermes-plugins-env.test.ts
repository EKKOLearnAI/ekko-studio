import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { materializeFakePython } from './helpers/windows-fake-python'

describe('Hermes plugin discovery environment', () => {
  const originalEnv = { ...process.env }
  let tempDir = ''

  beforeEach(() => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-plugins-env-'))
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  it('uses the same venv python and agent root resolved from the hermes binary as the bridge', async () => {
    const agentRoot = join(tempDir, 'agent')
    const venvBin = join(agentRoot, '.venv', 'bin')
    const hermesCliDir = join(agentRoot, 'hermes_cli')
    const captureFile = join(tempDir, 'capture.txt')
    let fakePython = join(venvBin, 'python')
    const fakeHermes = join(venvBin, 'hermes')

    mkdirSync(venvBin, { recursive: true })
    mkdirSync(hermesCliDir, { recursive: true })
    writeFileSync(join(agentRoot, 'run_agent.py'), '')
    writeFileSync(join(hermesCliDir, 'plugins.py'), '')
    writeFileSync(fakePython, [
      '#!/bin/sh',
      'printf "%s\\n%s\\n%s\\n%s\\n" "$0" "$1" "$2" "$HERMES_AGENT_ROOT_RESOLVED" > "$CAPTURE_FILE"',
      'printf "%s\\n" \'{"plugins":[],"warnings":[],"metadata":{"hermesAgentRoot":"","pythonExecutable":"","cwd":"","projectPluginsEnabled":false}}\'',
      '',
    ].join('\n'))
    chmodSync(fakePython, 0o755)
    fakePython = materializeFakePython(fakePython)
    writeFileSync(fakeHermes, `#!${fakePython}\n`)
    chmodSync(fakeHermes, 0o755)

    delete process.env.HERMES_AGENT_ROOT
    delete process.env.HERMES_AGENT_BRIDGE_PYTHON
    delete process.env.HERMES_AGENT_BRIDGE_UV
    delete process.env.HERMES_PYTHON
    process.env.HERMES_HOME = join(tempDir, 'home')
    process.env.HERMES_BIN = fakeHermes
    process.env.CAPTURE_FILE = captureFile

    const { listHermesPlugins } = await import('../../packages/server/src/modules/hermes/services/plugins/plugins')
    await expect(listHermesPlugins()).resolves.toMatchObject({ plugins: [] })

    const [command, firstArg, secondArg, resolvedRoot] = readFileSync(captureFile, 'utf8').trim().split('\n')
    expect(command).toBe(fakePython)
    expect(firstArg).toBe('-I')
    expect(secondArg).toBe('-c')
    expect(resolvedRoot).toBe(agentRoot)
  })

  it('uses package Python without isolated mode when no source root is resolved', async () => {
    const binDir = join(tempDir, 'bin')
    const captureFile = join(tempDir, 'capture-package.txt')
    let fakePython = join(binDir, 'python')
    const fakeHermes = join(binDir, 'hermes')

    mkdirSync(binDir, { recursive: true })
    writeFileSync(fakePython, [
      '#!/bin/sh',
      'printf "%s\\n%s\\n%s\\n%s\\n" "$0" "$1" "${PYTHONPATH-unset}" "${PYTHONHOME-unset}" > "$CAPTURE_FILE"',
      'printf "%s\\n" \'{"plugins":[],"warnings":[],"metadata":{"hermesAgentRoot":"","pythonExecutable":"","cwd":"","projectPluginsEnabled":false}}\'',
      '',
    ].join('\n'))
    chmodSync(fakePython, 0o755)
    fakePython = materializeFakePython(fakePython)
    writeFileSync(fakeHermes, `#!${fakePython}\n`)
    chmodSync(fakeHermes, 0o755)

    delete process.env.HERMES_AGENT_ROOT
    delete process.env.HERMES_AGENT_BRIDGE_PYTHON
    delete process.env.HERMES_AGENT_BRIDGE_UV
    delete process.env.UV
    delete process.env.HERMES_PYTHON
    process.env.HERMES_HOME = join(tempDir, 'home')
    process.env.HERMES_BIN = fakeHermes
    process.env.CAPTURE_FILE = captureFile
    process.env.PYTHONPATH = join(tempDir, 'shadow-path')
    process.env.PYTHONHOME = join(tempDir, 'shadow-home')

    const { listHermesPlugins } = await import('../../packages/server/src/modules/hermes/services/plugins/plugins')
    await expect(listHermesPlugins()).resolves.toMatchObject({ plugins: [] })

    const [command, firstArg, pythonPath, pythonHome] = readFileSync(captureFile, 'utf8').trim().split('\n')
    expect(command).toBe(fakePython)
    expect(firstArg).toBe('-c')
    expect(pythonPath).toBe('unset')
    expect(pythonHome).toBe('unset')
  })
})
