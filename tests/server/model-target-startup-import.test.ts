import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const fixture = vi.hoisted(() => ({ home: '', migrate: vi.fn(), codex: vi.fn(), pi: vi.fn(), account: 0 }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { get appHome() { return fixture.home } } }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info() {}, warn() {} } }))
vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({ getHermesBaseDir: () => join(fixture.home, 'hermes') }))
vi.mock('../../packages/server/src/modules/hermes/services/profiles/apikey-domain-replacement', () => ({ replaceHermesApiKeyDomains: async () => ({ failedProfiles: [] }) }))
vi.mock('../../packages/server/src/bootstrap/coding-agents', () => ({ migratePersistedPiRuntimeMcpConfigs: fixture.migrate, restorePersistedCodexProxyTargets: fixture.codex, restorePersistedPiProxyTargets: fixture.pi }))
vi.mock('../../packages/server/src/modules/studio/public/users', () => ({ listUsers: () => [
  { id: 1, status: 'active', profiles: ['default', 'shared', 'disabled-shared'] }, { id: 2, status: 'active', profiles: ['other', 'shared'] }, { id: 3, status: 'disabled', profiles: ['disabled-shared'] },
] }))
vi.mock('../../packages/server/src/modules/studio/public/provider-account', () => ({ withProviderAccount: async (id: number, fn: () => Promise<void>) => { fixture.account = id; return fn() } }))
import { runRegisteredStartupTasks } from '../../packages/server/src/bootstrap/startup-tasks'

beforeEach(async () => {
  fixture.home = await mkdtemp(join(tmpdir(), 'target-import-once-'))
  fixture.migrate.mockReset().mockResolvedValue(0)
  fixture.codex.mockReset().mockImplementation(async ({ acceptProfile, persistOnly }) => {
    expect(persistOnly).toBe(true)
    expect(acceptProfile('shared')).toBe(false)
    expect(acceptProfile('disabled-shared')).toBe(false)
    expect(acceptProfile(fixture.account === 1 ? 'default' : 'other')).toBe(true)
    expect(acceptProfile(fixture.account === 1 ? 'other' : 'default')).toBe(false)
    return 1
  })
  fixture.pi.mockReset().mockResolvedValue(0)
})
afterEach(async () => { await rm(fixture.home, { recursive: true, force: true }) })
it('imports legacy configuration only once and skips its directory scans after a later launch', async () => {
  await runRegisteredStartupTasks()
  expect(fixture.migrate).toHaveBeenCalledOnce()
  expect(fixture.codex).toHaveBeenCalledTimes(2)
  await runRegisteredStartupTasks()
  expect(fixture.migrate).toHaveBeenCalledOnce()
  expect(fixture.codex).toHaveBeenCalledTimes(2)
  const state = JSON.parse(await readFile(join(fixture.home, 'startup-tasks.json'), 'utf8'))
  expect(state.tasks.find((task: any) => task.id === '2026-11-17-legacy-model-target-index-v1').status).toBe('completed')
})
it('retries an interrupted import on the next launch instead of marking it complete', async () => {
  fixture.codex.mockRejectedValueOnce(new Error('storage unavailable'))
  expect((await runRegisteredStartupTasks()).failed).toContain('2026-11-17-legacy-model-target-index-v1')
  expect((await runRegisteredStartupTasks()).completed).toContain('2026-11-17-legacy-model-target-index-v1')
})
