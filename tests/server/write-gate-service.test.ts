import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { materializeShellExecutable } from './helpers/windows-shell-executable'

const originalHermesHome = process.env.HERMES_HOME
const originalHermesAgentRoot = process.env.HERMES_AGENT_ROOT
const originalHermesBin = process.env.HERMES_BIN
const originalHermesAgentCliPython = process.env.HERMES_AGENT_CLI_PYTHON
let hermesHome = ''

async function loadService() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  return import('../../packages/server/src/modules/hermes/services/write-gate/write-gate')
}

async function configureFakeApprovalRuntime(lines: string[]) {
  const agentRoot = join(hermesHome, 'agent')
  await mkdir(join(agentRoot, 'tools'), { recursive: true })
  await mkdir(join(agentRoot, 'hermes_cli'), { recursive: true })
  await writeFile(join(agentRoot, 'tools', 'write_approval.py'), '', 'utf-8')
  await writeFile(join(agentRoot, 'hermes_cli', 'write_approval_commands.py'), '', 'utf-8')

  const fakePython = join(hermesHome, 'fake-python')
  await writeFile(fakePython, [...lines, ''].join('\n'), 'utf-8')
  await chmod(fakePython, 0o755)
  process.env.HERMES_AGENT_ROOT = agentRoot
  process.env.HERMES_AGENT_CLI_PYTHON = materializeShellExecutable(fakePython)
}

beforeEach(async () => {
  hermesHome = await mkdtemp(join(tmpdir(), 'hermes-write-gate-'))
})

afterEach(async () => {
  vi.resetModules()
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  if (originalHermesAgentRoot === undefined) delete process.env.HERMES_AGENT_ROOT
  else process.env.HERMES_AGENT_ROOT = originalHermesAgentRoot
  if (originalHermesBin === undefined) delete process.env.HERMES_BIN
  else process.env.HERMES_BIN = originalHermesBin
  if (originalHermesAgentCliPython === undefined) delete process.env.HERMES_AGENT_CLI_PYTHON
  else process.env.HERMES_AGENT_CLI_PYTHON = originalHermesAgentCliPython
  await rm(hermesHome, { recursive: true, force: true })
  hermesHome = ''
})

describe('write gate service', () => {
  it('lists pending memory and skill records from the active profile', async () => {
    await mkdir(join(hermesHome, 'pending', 'memory'), { recursive: true })
    await mkdir(join(hermesHome, 'pending', 'skills'), { recursive: true })
    await writeFile(join(hermesHome, 'pending', 'memory', 'mem123.json'), JSON.stringify({
      id: 'mem123',
      subsystem: 'memory',
      action: 'add',
      summary: 'remember concise answers',
      origin: 'foreground',
      created_at: 2,
      payload: { target: 'user' },
    }), 'utf-8')
    await writeFile(join(hermesHome, 'pending', 'skills', 'skill123.json'), JSON.stringify({
      id: 'skill123',
      subsystem: 'skills',
      action: 'patch',
      summary: 'patch demo skill',
      origin: 'background_review',
      created_at: 1,
      payload: { name: 'demo' },
    }), 'utf-8')

    const { listPendingWrites } = await loadService()
    const result = await listPendingWrites('default')

    expect(result.counts).toEqual({ memory: 1, skills: 1 })
    expect(result.records.map(record => record.id)).toEqual(['skill123', 'mem123'])
    expect(result.records[0]).toMatchObject({
      subsystem: 'skills',
      summary: 'patch demo skill',
      payload: { name: 'demo' },
    })
  })

  it('rejects unsafe subsystem and pending ids before running Hermes Python', async () => {
    const { getPendingWriteDiff } = await loadService()

    await expect(getPendingWriteDiff('default', 'files', 'abc123')).rejects.toThrow('Invalid write gate subsystem')
    await expect(getPendingWriteDiff('default', 'memory', '../abc')).rejects.toThrow('Invalid pending write id')
  })

  it('detects write approval support from a uv-backed Hermes venv shebang', async () => {
    const agentRoot = join(hermesHome, 'agent')
    const venvBin = join(agentRoot, 'venv', 'bin')
    const externalPythonDir = join(hermesHome, 'uv-python', 'bin')
    await mkdir(join(agentRoot, 'tools'), { recursive: true })
    await mkdir(join(agentRoot, 'hermes_cli'), { recursive: true })
    await mkdir(venvBin, { recursive: true })
    await mkdir(externalPythonDir, { recursive: true })
    await writeFile(join(agentRoot, 'tools', 'write_approval.py'), '', 'utf-8')
    await writeFile(join(agentRoot, 'hermes_cli', 'write_approval_commands.py'), '', 'utf-8')
    await writeFile(join(externalPythonDir, 'python3'), '', 'utf-8')
    await symlink(join(externalPythonDir, 'python3'), join(venvBin, 'python3'))

    const hermesBin = join(venvBin, 'hermes')
    await writeFile(hermesBin, `#!${join(venvBin, 'python3')}\n`, 'utf-8')
    process.env.HERMES_BIN = hermesBin
    delete process.env.HERMES_AGENT_ROOT

    const { isWriteGateSupported } = await loadService()

    expect(isWriteGateSupported()).toBe(true)
  })

  it('detects write approval support from a Windows-style venv Scripts executable path', async () => {
    const agentRoot = join(hermesHome, 'agent-win')
    const scriptsDir = join(agentRoot, 'venv', 'Scripts')
    await mkdir(join(agentRoot, 'tools'), { recursive: true })
    await mkdir(join(agentRoot, 'hermes_cli'), { recursive: true })
    await mkdir(scriptsDir, { recursive: true })
    await writeFile(join(agentRoot, 'tools', 'write_approval.py'), '', 'utf-8')
    await writeFile(join(agentRoot, 'hermes_cli', 'write_approval_commands.py'), '', 'utf-8')

    const hermesBin = join(scriptsDir, 'hermes.exe')
    await writeFile(hermesBin, '', 'utf-8')
    process.env.HERMES_BIN = hermesBin
    delete process.env.HERMES_AGENT_ROOT

    const { isWriteGateSupported } = await loadService()

    expect(isWriteGateSupported()).toBe(true)
  })

  it('detects write approval support from a pip-installed runtime Python', async () => {
    const fakePython = join(hermesHome, 'python')
    await writeFile(fakePython, [
      '#!/bin/sh',
      'case "$2" in',
      '  *"tools.write_approval"*"hermes_cli.write_approval_commands"*) exit 0 ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'), 'utf-8')
    await chmod(fakePython, 0o755)
    process.env.HERMES_AGENT_CLI_PYTHON = materializeShellExecutable(fakePython)
    process.env.HERMES_BIN = join(hermesHome, 'missing-hermes')
    delete process.env.HERMES_AGENT_ROOT

    const { isWriteGateSupported } = await loadService()

    expect(isWriteGateSupported()).toBe(true)
  })

  it('uses the structured Python result and treats empty output as failure', async () => {
    await configureFakeApprovalRuntime([
      '#!/bin/sh',
      'case "$6" in',
      '  approved) printf \'%s\\n\' \'{"success":true,"output":"Approved 1 skills write(s)."}\' ;;',
      '  missing) printf \'%s\\n\' \'{"success":false,"output":"No pending skills writes."}\' ;;',
      '  empty) printf \'%s\\n\' \'{"success":true,"output":""}\' ;;',
      'esac',
    ])

    const { approvePendingWrite } = await loadService()

    await expect(approvePendingWrite('default', 'skills', 'approved')).resolves.toEqual({
      success: true,
      output: 'Approved 1 skills write(s).',
    })
    await expect(approvePendingWrite('default', 'skills', 'missing')).resolves.toEqual({
      success: false,
      output: 'No pending skills writes.',
    })
    await expect(approvePendingWrite('default', 'skills', 'empty')).resolves.toEqual({
      success: false,
      output: '',
    })
  })

  it('serializes approval actions within the same profile', async () => {
    await configureFakeApprovalRuntime([
      '#!/bin/sh',
      'guard="$HERMES_HOME/.write-gate-action-running"',
      'if ! mkdir "$guard" 2>/dev/null; then',
      '  printf \'%s\\n\' \'{"success":false,"output":"overlapping approval"}\'',
      '  exit 0',
      'fi',
      'sleep 0.05',
      'rmdir "$guard"',
      'printf \'%s\\n\' \'{"success":true,"output":"resolved"}\'',
    ])

    const { approvePendingWrite, rejectPendingWrite } = await loadService()
    const results = await Promise.all([
      approvePendingWrite('default', 'skills', 'first'),
      rejectPendingWrite('default', 'memory', 'second'),
    ])

    expect(results).toEqual([
      { success: true, output: 'resolved' },
      { success: true, output: 'resolved' },
    ])
  })
})
