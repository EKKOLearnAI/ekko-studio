import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({
  invalidateProviderRuntime: vi.fn(),
}))

let home = ''
beforeEach(async () => {
  vi.resetModules()
  home = mkdtempSync(join(tmpdir(), 'claude-clear-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('HERMES_HOME', home)
  vi.stubEnv('HERMES_WEB_UI_HOME', join(home, 'studio'))
  vi.stubEnv('HERMES_WEBUI_STATE_DIR', join(home, 'studio'))
  writeFileSync(join(home, 'config.yaml'), 'model: {}\n')
  writeFileSync(join(home, '.env'), 'ANTHROPIC_API_KEY=keep-api-key\nOTHER_KEY=keep-other\n')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No external requests in this test')))
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

async function save(profile = 'default') {
  const { saveAnthropicOAuthTokensForProfile } = await import('../../packages/server/src/modules/hermes/controllers/anthropic-auth')
  await saveAnthropicOAuthTokensForProfile(profile, {
    access_token: 'fixture-claude-access', refresh_token: 'fixture-claude-refresh', expires_in: 3600,
  })
}
async function clear(profile = 'default') {
  const { remove } = await import('../../packages/server/src/modules/hermes/controllers/providers')
  const ctx = { params: { poolKey: 'claude-oauth' }, query: {}, state: { profile: { name: profile } }, status: 200, body: undefined as any }
  await remove(ctx)
  return ctx
}
const readAuth = (dir = home) => JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))

describe('Claude OAuth credential clearing', () => {
  it('clears every store produced by the real login writer and removes OAuth catalog admission', async () => {
    await save()
    const { getAvailableModelGroupsForProfile } = await import('../../packages/server/src/modules/hermes/controllers/models')
    expect((await getAvailableModelGroupsForProfile('default')).some(g => g.provider === 'claude-oauth')).toBe(true)
    expect((await clear()).body).toEqual({ success: true })
    const auth = readAuth()
    for (const key of ['claude-oauth', 'anthropic']) {
      expect(auth.providers).not.toHaveProperty(key)
      expect(auth.credential_pool).not.toHaveProperty(key)
    }
    expect(existsSync(join(home, '.anthropic_oauth.json'))).toBe(false)
    const env = readFileSync(join(home, '.env'), 'utf8')
    expect(env).not.toContain('fixture-claude-access')
    expect(env).toContain('ANTHROPIC_API_KEY=keep-api-key')
    expect(env).toContain('OTHER_KEY=keep-other')
    expect((await getAvailableModelGroupsForProfile('default')).some(g => g.provider === 'claude-oauth')).toBe(false)
    expect((await clear()).body).toEqual({ success: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves API-key Anthropic records, other providers and external CLI files', async () => {
    await save()
    const auth = readAuth()
    auth.providers.anthropic = { auth_type: 'api_key', api_key: 'keep-native-api-key' }
    auth.credential_pool.anthropic.push({ auth_type: 'api_key', api_key: 'keep-pool-key' })
    auth.providers['openai-codex'] = { access_token: 'keep-codex' }
    writeFileSync(join(home, 'auth.json'), JSON.stringify(auth))
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', '.credentials.json'), 'external-cli-state')
    expect((await clear()).status).toBe(200)
    const after = readAuth()
    expect(after.providers.anthropic).toEqual(auth.providers.anthropic)
    expect(after.credential_pool.anthropic).toEqual([{ auth_type: 'api_key', api_key: 'keep-pool-key' }])
    expect(after.providers['openai-codex']).toEqual(auth.providers['openai-codex'])
    expect(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')).toBe('external-cli-state')
  })

  it('cleans the sidecar and environment when auth.json is already absent', async () => {
    await save()
    rmSync(join(home, 'auth.json'))
    expect((await clear()).status).toBe(200)
    expect(existsSync(join(home, '.anthropic_oauth.json'))).toBe(false)
    expect(readFileSync(join(home, '.env'), 'utf8')).not.toContain('fixture-claude-access')
  })

  it('limits cleanup to the selected profile', async () => {
    await save()
    const rootBefore = ['auth.json', '.env', '.anthropic_oauth.json'].map(file => readFileSync(join(home, file), 'utf8'))
    const profile = join(home, 'profiles', 'research')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'config.yaml'), 'model: {}\n')
    await save('research')
    expect((await clear('research')).status).toBe(200)
    expect(existsSync(join(profile, '.anthropic_oauth.json'))).toBe(false)
    expect(readAuth(profile).providers).not.toHaveProperty('anthropic')
    expect(['auth.json', '.env', '.anthropic_oauth.json'].map(file => readFileSync(join(home, file), 'utf8'))).toEqual(rootBefore)
  })

  it('fails without leaking credentials if the auth store cannot be parsed', async () => {
    await save()
    writeFileSync(join(home, 'auth.json'), '{"secret":"fixture-private-token", broken')
    const result = await clear()
    expect(result.status).toBe(500)
    expect(JSON.stringify(result.body)).not.toContain('fixture-private-token')
    expect(existsSync(join(home, '.anthropic_oauth.json'))).toBe(true)
  })
})
