import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let home = ''
const providers = ['nous', 'openai-codex', 'xai-oauth', 'claude-oauth']

function writeAuth(profile: string, auth: object) {
  const dir = profile === 'default' ? home : join(home, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'auth.json'), JSON.stringify(auth))
}

beforeEach(() => {
  vi.resetModules()
  home = mkdtempSync(join(tmpdir(), 'model-picker-inherited-oauth-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('HERMES_HOME', home)
  vi.stubEnv('HERMES_WEB_UI_HOME', join(home, 'studio'))
  vi.stubEnv('HERMES_WEBUI_STATE_DIR', join(home, 'studio'))
  mkdirSync(join(home, 'profiles', 'research'), { recursive: true })
  for (const dir of [home, join(home, 'profiles', 'research')]) {
    writeFileSync(join(dir, 'config.yaml'), '{}\n')
    writeFileSync(join(dir, '.env'), '')
  }
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('External requests are forbidden in this fixture')))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

async function models(profile = 'research') {
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  const controller = await import('../../packages/server/src/modules/hermes/controllers/models')
  return controller.getAvailableModelGroupsForProfile(profile)
}

describe('model picker inherited OAuth', () => {
  it.each(providers)('includes root %s authorization for a named profile without copying tokens', async provider => {
    const key = provider === 'claude-oauth' ? 'anthropic' : provider
    writeAuth('default', { providers: { [key]: { access_token: 'synthetic-root-token', refresh_token: 'synthetic-refresh-token' } } })
    writeAuth('research', {})
    const rootBefore = readFileSync(join(home, 'auth.json'), 'utf8')
    const profileBefore = readFileSync(join(home, 'profiles', 'research', 'auth.json'), 'utf8')
    const groups = await models()
    expect(groups).toEqual(expect.arrayContaining([expect.objectContaining({ provider })]))
    expect(JSON.stringify(groups)).not.toContain('synthetic-root-token')
    expect(JSON.stringify(groups)).not.toContain('synthetic-refresh-token')
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe(rootBefore)
    expect(readFileSync(join(home, 'profiles', 'research', 'auth.json'), 'utf8')).toBe(profileBefore)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses the named profile credential and endpoint before the root credential', async () => {
    writeAuth('default', { providers: { nous: { agent_key: 'synthetic-root-token', inference_base_url: 'https://root.example/v1' } } })
    writeAuth('research', { credential_pool: { nous: [{ agent_key: 'synthetic-profile-token', inference_base_url: 'https://profile.example/v1' }] } })
    const groups = await models()
    expect(groups.find(group => group.provider === 'nous')?.base_url).toBe('https://profile.example/v1')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('inherits a root credential pool entry and its regional endpoint', async () => {
    writeAuth('default', { credential_pool: { 'minimax-oauth': [{ access_token: 'synthetic-root-token', inference_base_url: 'https://api.minimaxi.com/anthropic' }] } })
    const groups = await models()
    expect(groups).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'minimax-oauth', base_url: 'https://api.minimaxi.com/anthropic' })]))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps a profile-local refresh credential from falling through to a different root grant', async () => {
    writeAuth('default', { providers: { nous: { agent_key: 'synthetic-root-token' } } })
    writeAuth('research', { providers: { nous: { refresh_token: 'synthetic-profile-refresh' } } })
    const groups = await models()
    expect(groups.some(group => group.provider === 'nous')).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('includes inherited credentials in explicit and aggregate responses', async () => {
    writeAuth('default', { providers: { nous: { agent_key: 'synthetic-root-token' } } })
    await import('../../packages/server/src/bootstrap/agent-profile-adapter')
    const { getAvailable } = await import('../../packages/server/src/modules/hermes/controllers/models')
    const explicit = { query: { profile: 'research' }, body: undefined as any }
    await getAvailable(explicit)
    expect(explicit.body.groups).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'nous' })]))
    // Aggregation also retains the provider in the named profile group.
    const aggregate = { query: {}, body: undefined as any }
    await getAvailable(aggregate)
    expect(aggregate.body.profiles.find((profile: any) => profile.profile === 'research').groups)
      .toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'nous' })]))
    expect(JSON.stringify([explicit.body, aggregate.body])).not.toContain('synthetic-root-token')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not fall back to root when the named auth store is malformed', async () => {
    writeAuth('default', { providers: { nous: { agent_key: 'synthetic-root-token' } } })
    writeFileSync(join(home, 'profiles', 'research', 'auth.json'), 'invalid-json')
    expect((await models()).some(group => group.provider === 'nous')).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves local-only picker admission for the separately managed Qwen OAuth store', async () => {
    writeAuth('default', { providers: { 'qwen-oauth': { access_token: 'synthetic-root-token' } } })
    expect((await models()).some(group => group.provider === 'qwen-oauth')).toBe(false)
    writeAuth('research', { providers: { 'qwen-oauth': { access_token: 'synthetic-profile-token' } } })
    expect((await models()).some(group => group.provider === 'qwen-oauth')).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps unauthenticated providers absent and does not inherit root API keys', async () => {
    writeAuth('default', {})
    writeFileSync(join(home, '.env'), 'DEEPSEEK_API_KEY=synthetic-root-api-key\n')
    const groups = await models()
    expect(groups.some(group => providers.includes(group.provider) || group.provider === 'deepseek')).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
})
