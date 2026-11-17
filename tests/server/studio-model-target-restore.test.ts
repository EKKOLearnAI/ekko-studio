import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const fixture = vi.hoisted(() => ({ home: '', account: 7, scope: undefined as any,
  calls: [] as any[], registered: [] as any[], groups: vi.fn(), users: [] as any[] }))
vi.mock('../../packages/server/src/modules/studio/public/provider-account', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  fixture.scope = new AsyncLocalStorage<number>()
  return {
    providerAccountHome: (id = fixture.scope.getStore() || fixture.account) => join(fixture.home, String(id)),
    providerAccountId: () => fixture.scope.getStore() || fixture.account,
    importAccountProviders: async () => {},
    withProviderAccount: (id: number, task: () => unknown) => fixture.scope.run(id, task),
  }
})
vi.mock('../../packages/server/src/modules/studio/services/providers/account-store', () => ({
  providerAccountHome: () => join(fixture.home, String(fixture.scope.getStore() || fixture.account)),
}))
vi.mock('../../packages/server/src/modules/studio/public/users', () => ({
  listUsers: () => fixture.users,
  userCanAccessProfile: (_id: number, profile: string) => profile !== 'revoked',
}))
vi.mock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({ getSessionAvailableModelGroups: fixture.groups }))
vi.mock('../../packages/server/src/modules/studio/public/provider-upstream', () => ({ resolveProviderUpstream: async (input: any) => {
  const account = fixture.scope.getStore() || fixture.account
  fixture.calls.push({ ...input, account })
  if (input.model === 'offline') throw new Error('Expired upstream login')
  return { provider: input.provider, baseUrl: 'https://upstream.invalid/v1', apiKey: `current-fixture-${account}`, apiMode: 'chat_completions' }
} }))

import { saveModelTarget, restoreStudioModelTarget } from '../../packages/server/src/modules/studio/public/model-target-store'
import { configureModelGatewayAdapters } from '../../packages/server/src/modules/studio/public/model-gateway-adapters'
import { safeFileStore } from '../../packages/server/src/modules/studio/public/safe-file-store'

let sequence = 0
let tokens: Map<string, any>
beforeEach(async () => {
  fixture.home = await mkdtemp(join(tmpdir(), 'studio-restore-targets-'))
  fixture.account = 7; fixture.calls = []; fixture.registered = []
  fixture.users = [{ id: 7, role: 'user', status: 'active' }, { id: 8, role: 'user', status: 'active' }, { id: 9, role: 'user', status: 'disabled' }]
  fixture.groups.mockReset().mockResolvedValue([{ provider: 'deepseek', models: ['family/model', 'offline'] }])
  for (const id of [7, 8, 9]) {
    const home = join(fixture.home, String(id)); await mkdir(home)
    await writeFile(join(home, 'pool.json'), JSON.stringify({ version: 3, aliases: { 'deepseek@legacy': 'deepseek' } }))
    await writeFile(join(home, 'config.yaml'), 'providers:\n  deepseek: {}\n')
  }
  const registry = tokens = new Map()
  configureModelGatewayAdapters({ authenticate: token => registry.get(token) || null, handle: async () => {}, register: (protocol, target, persisted) => {
    fixture.registered.push({ protocol, ...target, token: persisted?.token })
    registry.set(persisted!.token, target)
    return { routeKey: persisted!.token, dispose() { registry.delete(persisted!.token) } }
  } })
})
afterEach(async () => { vi.restoreAllMocks(); await rm(fixture.home, { recursive: true, force: true }) })

async function save(id = 7, profile = 'work', model = 'family/model') {
  fixture.account = id
  const token = `hwui_fixture_${++sequence}`
  await saveModelTarget(id === 8 ? 'anthropic_messages' : 'codex_responses', {
    profile, provider: 'deepseek@legacy', model, agentId: 'fixture-agent',
    agentSessionId: `native-${id}`, chatSessionId: `session-${id}`,
  }, token)
  return token
}

it('restores only the requested identity with current owner credentials, then reuses it', async () => {
  const first = await save(7), second = await save(8)
  const directory = join(fixture.home, '7', 'model-targets')
  expect(await readFile(join(directory, (await readdir(directory))[0]), 'utf8')).not.toContain('apiKey')
  const reads = vi.spyOn(safeFileStore, 'readText')
  expect(await restoreStudioModelTarget(second)).toMatchObject({ userId: 8, provider: 'deepseek', model: 'family/model' })
  expect(fixture.registered).toEqual([expect.objectContaining({ protocol: 'anthropic_messages', userId: 8,
    token: second, profile: 'work', apiKey: 'current-fixture-8', sessionId: 'session-8', runId: 'native-8' })])
  expect(reads.mock.calls.map(call => call[0])).not.toContain(join(directory, createHash('sha256').update(first).digest('hex') + '.json'))
  reads.mockClear()
  await restoreStudioModelTarget(second)
  expect(reads).not.toHaveBeenCalled()
  expect(fixture.groups).toHaveBeenCalledOnce()
})

it('coalesces concurrent cold requests for the same token and preserves account scopes', async () => {
  const first = await save(7), second = await save(8)
  const result = await Promise.all([restoreStudioModelTarget(first), restoreStudioModelTarget(first), restoreStudioModelTarget(second)])
  expect(result.map(value => value?.userId)).toEqual([7, 7, 8])
  expect(fixture.registered).toHaveLength(2)
  expect(fixture.calls.map(call => call.account).sort()).toEqual([7, 8])
})

it('rejects disabled owners, revoked Profiles, unavailable models, expired credentials and damaged records', async () => {
  const disabled = await save(9), revoked = await save(7, 'revoked'), removed = await save(7, 'work', 'removed'), expired = await save(7, 'work', 'offline')
  const damaged = await save(7)
  await writeFile(join(fixture.home, '7', 'model-targets', createHash('sha256').update(damaged).digest('hex') + '.json'), 'null')
  for (const token of [disabled, revoked, removed, expired, damaged, 'hwui_missing', '../escape']) expect(await restoreStudioModelTarget(token)).toBeNull()
  expect(fixture.registered).toHaveLength(0)
})

it('rejects foreign ownership and a token stored under another credential digest', async () => {
  const token = await save(7)
  const path = join(fixture.home, '7', 'model-targets', createHash('sha256').update(token).digest('hex') + '.json')
  const original = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...original, ownerUserId: 8 }))
  expect(await restoreStudioModelTarget(token)).toBeNull()
  await writeFile(path, JSON.stringify({ ...original, token: 'hwui_someone_else' }))
  expect(await restoreStudioModelTarget(token)).toBeNull()
  expect(fixture.registered).toHaveLength(0)
})

it('bounds restored credentials, retains recently used ones, and reloads an evicted record', async () => {
  const saved: string[] = []
  for (let i = 0; i < 130; i++) saved.push(await save())
  for (const token of saved.slice(0, 128)) expect(await restoreStudioModelTarget(token)).not.toBeNull()
  await restoreStudioModelTarget(saved[0])
  await restoreStudioModelTarget(saved[128])
  expect(tokens.size).toBe(128)
  expect(tokens.has(saved[0])).toBe(true)
  expect(tokens.has(saved[1])).toBe(false)
  expect(await restoreStudioModelTarget(saved[1])).not.toBeNull()
  expect(tokens.size).toBe(128)
})
