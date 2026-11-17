import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

const state = vi.hoisted(() => {
  const fs = require('node:fs')
  const path = require('node:path')
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'coding-agent-install-'))
  vi.stubEnv('HERMES_WEB_UI_HOME', root)
  vi.stubEnv('HERMES_HOME', path.join(root, 'hermes'))
  vi.stubEnv('HERMES_CODING_AGENT_GLOBAL_HOME', root)
  vi.stubEnv('HERMES_DESKTOP', 'false')
  fs.mkdirSync(path.join(root, '.pi/agent'), { recursive: true })
  fs.writeFileSync(path.join(root, '.pi/agent/settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-adapter'] }))
  return { root, version: '1.0.0', execute: vi.fn() }
})

// Mock process execution, retaining the real installer, registry and update policy.
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile = Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: state.execute })
  return { ...actual, execFile }
})

import { getCodingAgentDefinitions, installCodingAgent } from '../../packages/server/src/modules/coding-agents/services'
import { agentUpgrade } from '../../packages/server/src/modules/studio/services/agents/registry'

beforeEach(() => {
  state.version = '1.0.0'
  state.execute.mockReset().mockImplementation(async (command: string, args: string[]) => {
    let stdout = ''
    if (args.includes('prefix')) stdout = state.root
    else if (command === 'which' || command === 'where') stdout = join(state.root, 'bin', args.at(-1)!)
    else if (args.includes('install')) {
      const spec = args[args.indexOf('-g') + 1]
      state.version = spec?.match(/@(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/)?.[1] || '1.2.3'
    } else if (args.includes('--version')) stdout = state.version
    else if (args.includes('view')) stdout = '1.2.3'
    return { stdout, stderr: '' }
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(state.root, { recursive: true, force: true })
})

const npmAgents = getCodingAgentDefinitions().filter(tool => tool.packageName && !['dsh', 'cursor', 'antigravity'].includes(tool.id))

it.each(npmAgents)('installs the selected version for $id', async tool => {
  const result = await installCodingAgent(tool.id, { version: '1.2.3' })
  expect(result).toMatchObject({ success: true, tool: { id: tool.id, version: '1.2.3' } })
  expect(state.execute).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['install', '-g', `${tool.packageName}@1.2.3`]), expect.any(Object))
})

it.each([undefined, 'latest', '1.2.3-rc.1'])('retains default, latest and prerelease installs (%s)', async version => {
  const result = await installCodingAgent('codex', { version })
  expect(result.success).toBe(true)
  const spec = version ? `@openai/codex@${version}` : '@openai/codex'
  expect(state.execute).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['install', '-g', spec, '--registry=https://registry.npmjs.org']), expect.any(Object))
})

it.each(['', '^1.2', 'file:/tmp/cli', 'git+https://example.org', '--foo', 123, null])('rejects invalid target %s before executing a command', async version => {
  await expect(installCodingAgent('codex', { version: version as string })).rejects.toMatchObject({ status: 400 })
  expect(state.execute).not.toHaveBeenCalled()
})

it.each(['cursor', 'antigravity', 'zcode'])('keeps manual installation for %s', async id => {
  await expect(installCodingAgent(id, { version: '1.2.3' })).rejects.toMatchObject({ status: 400 })
  expect(state.execute).not.toHaveBeenCalled()
})

it('keeps rollback exclusive to DSH', async () => {
  await expect(installCodingAgent('codex', { rollback: true })).rejects.toMatchObject({ status: 400, message: 'Rollback is available for DSH only' })
  expect(state.execute).not.toHaveBeenCalled()
})

it('upgrades through the unified agent adapter and rejects a stale expected version', async () => {
  await import('../../packages/server/src/bootstrap/plugin-agent-adapter')
  const identity = { userId: 1, profile: 'default' }
  await expect(agentUpgrade('codex', identity, { version: '1.2.3', expectedVersion: 'old' })).rejects.toMatchObject({ status: 409 })
  expect(state.execute.mock.calls.some(([, args]) => args.includes('install'))).toBe(false)
  await expect(agentUpgrade('codex', identity, { version: '1.2.3', expectedVersion: '1.0.0' })).resolves.toMatchObject({ installedVersion: '1.2.3' })
  expect(state.execute).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['install', '-g', '@openai/codex@1.2.3']), expect.any(Object))
})
