import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const fixture = vi.hoisted(() => ({ home: '', account: 7, calls: [] as any[], registered: [] as any[] }))
vi.mock('../../packages/server/src/modules/studio/public/provider-account', () => ({
  providerAccountHome: () => join(fixture.home, String(fixture.account)), providerAccountId: () => fixture.account,
  importAccountProviders: async () => {},
  withProviderAccount: async (id: number, task: () => Promise<unknown>) => {
    const previous = fixture.account; fixture.account = id
    try { return await task() } finally { fixture.account = previous }
  },
}))
vi.mock('../../packages/server/src/modules/studio/services/providers/account-store', () => ({ providerAccountHome: () => join(fixture.home, String(fixture.account)) }))
vi.mock('../../packages/server/src/modules/studio/public/users', () => ({
  listUsers: () => [{ id: 7, role: 'user', status: 'active' }, { id: 8, role: 'user', status: 'active' }, { id: 9, role: 'user', status: 'disabled' }],
  userCanAccessProfile: (_id: number, profile: string) => profile !== 'revoked',
}))
vi.mock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({ getSessionAvailableModelGroups: async () => [{ provider: 'deepseek', models: ['family/model', 'offline'] }] }))
vi.mock('../../packages/server/src/modules/studio/public/provider-upstream', () => ({ resolveProviderUpstream: async (input: any) => {
  fixture.calls.push({ ...input, account: fixture.account })
  if (input.model === 'offline') throw new Error('Expired upstream login')
  return { provider: input.provider, baseUrl: 'https://upstream.invalid/v1', apiKey: `current-fixture-${fixture.account}`, apiMode: 'chat_completions' }
} }))

import { saveModelTarget, restoreStudioModelTargets } from '../../packages/server/src/modules/studio/public/model-target-store'
import { configureModelGatewayAdapters } from '../../packages/server/src/modules/studio/public/model-gateway-adapters'

beforeEach(async () => {
  fixture.home = await mkdtemp(join(tmpdir(), 'studio-restore-targets-'))
  fixture.account = 7; fixture.calls = []; fixture.registered = []
  for (const id of [7, 8, 9]) {
    const home = join(fixture.home, String(id)); await mkdir(home)
    await writeFile(join(home, 'pool.json'), JSON.stringify({ version: 3, aliases: { 'deepseek@legacy': 'deepseek' } }))
    await writeFile(join(home, 'config.yaml'), 'providers:\n  deepseek: {}\n')
  }
  configureModelGatewayAdapters({ authenticate: () => null, handle: async () => {}, register: (protocol, target, persisted) => {
    fixture.registered.push({ protocol, ...target, token: persisted?.token })
    return { routeKey: 'fixture', dispose() {} }
  } })
})
afterEach(async () => { await rm(fixture.home, { recursive: true, force: true }) })

it('restores persisted identities with current account credentials and canonical provider names', async () => {
  for (const id of [7, 8]) {
    fixture.account = id
    await saveModelTarget(id === 7 ? 'codex_responses' : 'anthropic_messages', {
      profile: 'work', provider: 'deepseek@legacy', model: 'family/model', agentId: 'fixture-agent',
      agentSessionId: `native-${id}`, chatSessionId: `session-${id}`,
    }, `hwui_saved_${id}`)
  }
  const directory = join(fixture.home, '7', 'model-targets')
  const saved = await readFile(join(directory, (await readdir(directory))[0]), 'utf8')
  expect(saved).not.toContain('apiKey')
  expect(await restoreStudioModelTargets()).toBe(2)
  expect(fixture.registered).toEqual([7, 8].map(id => expect.objectContaining({
    protocol: id === 7 ? 'codex_responses' : 'anthropic_messages', userId: id, token: `hwui_saved_${id}`,
    profile: 'work', provider: 'deepseek', model: 'family/model', sessionId: `session-${id}`, runId: `native-${id}`,
    apiKey: `current-fixture-${id}`, baseUrl: 'https://upstream.invalid/v1', apiMode: 'chat_completions',
  })))
  expect(fixture.calls.map(call => call.account)).toEqual([7, 8])
})

it('skips revoked access, disabled owners, unavailable models and damaged records without blocking valid bindings', async () => {
  for (const [id, profile, model] of [[7, 'revoked', 'family/model'], [7, 'work', 'removed'], [7, 'work', 'offline'], [9, 'work', 'family/model'], [8, 'work', 'family/model']] as const) {
    fixture.account = id
    await saveModelTarget('codex_responses', { profile, provider: 'deepseek', model }, `hwui_${id}_${profile}_${model}`)
  }
  await writeFile(join(fixture.home, '7', 'model-targets', `${'a'.repeat(64)}.json`), 'invalid JSON')
  // A record copied from another account must not transfer ownership.
  await writeFile(join(fixture.home, '7', 'model-targets', `${'b'.repeat(64)}.json`), JSON.stringify({ ownerUserId: 8, token: 'hwui_foreign', profile: 'work', provider: 'deepseek', model: 'family/model', protocol: 'codex_responses' }))
  expect(await restoreStudioModelTargets()).toBe(1)
  expect(fixture.registered).toHaveLength(1)
  expect(fixture.registered[0]).toMatchObject({ userId: 8, profile: 'work', model: 'family/model' })
  expect(fixture.calls).toHaveLength(2)
})
