import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const API_KEY_FAKE = 'sk-orca-api-key-adapter-000000000000'
const PKCE_KEY_FAKE = 'sk-orca-pkce-adapter-0000000000000000'

let hermesHome = ''
const originalHermesHome = process.env.HERMES_HOME

function profileDir(profile: string): string {
  return profile === 'default' ? hermesHome : join(hermesHome, 'profiles', profile)
}

async function loadModule() {
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  return import('../../packages/server/src/modules/hermes/services/providers/orcarouter-credential')
}

beforeEach(() => {
  hermesHome = mkdtempSync(join(tmpdir(), 'orcarouter-credential-'))
  process.env.HERMES_HOME = hermesHome
  // The adapter falls back to the process environment, which may hold a real
  // key on a developer machine. Tests must only ever see their own fake value.
  delete process.env.ORCAROUTER_API_KEY
  delete process.env.ORCAROUTER_BASE_URL
  mkdirSync(hermesHome, { recursive: true })
  writeFileSync(join(hermesHome, 'config.yaml'), 'model:\n  provider: orcarouter\n  default: deepseek/deepseek-v4-pro\n')
  vi.resetModules()
})

afterEach(() => {
  vi.resetModules()
  rmSync(hermesHome, { recursive: true, force: true })
  delete process.env.ORCAROUTER_API_KEY
  delete process.env.ORCAROUTER_BASE_URL
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
})

describe('OrcaRouter credential seam', () => {
  it('API-key adapter saves, reads back, and clears the pasted key', async () => {
    const { orcaRouterApiKeyAdapter } = await loadModule()
    expect(await orcaRouterApiKeyAdapter.load('default')).toBeNull()

    await orcaRouterApiKeyAdapter.save('default', {
      source: 'api-key',
      apiKey: API_KEY_FAKE,
      baseUrl: 'https://api.orcarouter.ai/v1',
    })
    const stored = await orcaRouterApiKeyAdapter.load('default')
    expect(stored).toMatchObject({ source: 'api-key', apiKey: API_KEY_FAKE })
    expect(stored?.baseUrl).toBe('https://api.orcarouter.ai/v1')

    await orcaRouterApiKeyAdapter.clear('default')
    expect(await orcaRouterApiKeyAdapter.load('default')).toBeNull()
  })

  it('API-key adapter refuses a value that is not an OrcaRouter key', async () => {
    const { orcaRouterApiKeyAdapter } = await loadModule()
    await expect(orcaRouterApiKeyAdapter.save('default', {
      source: 'api-key',
      apiKey: 'sk-openai-not-orcarouter',
      baseUrl: 'https://api.orcarouter.ai/v1',
    })).rejects.toMatchObject({ code: 'ORCAROUTER_API_KEY_SHAPE' })
  })

  it('PKCE adapter persists the issued key and clears it again', async () => {
    const { orcaRouterPkceAdapter } = await loadModule()
    await orcaRouterPkceAdapter.save('default', {
      source: 'oauth-pkce',
      apiKey: PKCE_KEY_FAKE,
      baseUrl: 'https://api.orcarouter.ai/v1',
      scope: 'api',
      accountId: 'user-42',
    })
    const auth = JSON.parse(readFileSync(join(hermesHome, 'auth.json'), 'utf8'))
    expect(auth.providers['orcarouter-oauth']).toMatchObject({
      api_key: PKCE_KEY_FAKE,
      auth_mode: 'oauth_pkce',
      scope: 'api',
      account_id: 'user-42',
    })
    expect(auth.credential_pool['orcarouter-oauth'][0]).toMatchObject({
      auth_type: 'oauth',
      source: 'loopback_pkce',
      api_key: PKCE_KEY_FAKE,
    })

    const stored = await orcaRouterPkceAdapter.load('default')
    expect(stored).toMatchObject({ source: 'oauth-pkce', apiKey: PKCE_KEY_FAKE })

    await orcaRouterPkceAdapter.clear('default')
    expect(await orcaRouterPkceAdapter.load('default')).toBeNull()
  })

  it('both adapters produce one identical credential result for downstream consumers', async () => {
    const { orcaRouterApiKeyAdapter, orcaRouterPkceAdapter } = await loadModule()
    await orcaRouterApiKeyAdapter.save('default', {
      source: 'api-key', apiKey: API_KEY_FAKE, baseUrl: 'https://api.orcarouter.ai/v1',
    })
    const viaKey = await orcaRouterApiKeyAdapter.load('default')
    await orcaRouterApiKeyAdapter.clear('default')
    await orcaRouterPkceAdapter.save('default', {
      source: 'oauth-pkce', apiKey: PKCE_KEY_FAKE, baseUrl: 'https://api.orcarouter.ai/v1', scope: 'api',
    })
    const viaPkce = await orcaRouterPkceAdapter.load('default')

    expect(viaKey).not.toBeNull()
    expect(viaPkce).not.toBeNull()
    // Same seam, same result shape: only `source` and the key value differ, and
    // the downstream provider/model-discovery path never reads either. `scope`
    // is present only on a PKCE-issued credential because only that entry point
    // observes a grant to record.
    const shape = (credential: Record<string, unknown>) => Object.keys(credential).filter(key => key !== 'scope').sort()
    expect(shape(viaKey!)).toEqual(shape(viaPkce!))
    expect(viaKey!.baseUrl).toBe(viaPkce!.baseUrl)
    expect(viaKey!.source).toBe('api-key')
    expect(viaPkce!.source).toBe('oauth-pkce')
    expect(viaPkce!.scope).toBe('api')
  })

  it('resolves either entry point without the caller naming the credential origin', async () => {
    const { orcaRouterApiKeyAdapter, resolveOrcaRouterCredential } = await loadModule()
    await orcaRouterApiKeyAdapter.save('default', {
      source: 'api-key', apiKey: API_KEY_FAKE, baseUrl: 'https://api.orcarouter.ai/v1',
    })
    // The Auth entry point falls back to the pasted key, so it works with no
    // browser and no PKCE session.
    const forOauthEntry = await resolveOrcaRouterCredential('default', 'orcarouter-oauth')
    const forApiEntry = await resolveOrcaRouterCredential('default', 'orcarouter')
    expect(forOauthEntry?.apiKey).toBe(API_KEY_FAKE)
    expect(forApiEntry?.apiKey).toBe(API_KEY_FAKE)
  })

  it('redacts keys and never renders the middle of a secret', async () => {
    const { redactOrcaRouterKey, isOrcaRouterKeyShape } = await loadModule()
    const redacted = redactOrcaRouterKey(API_KEY_FAKE)
    expect(redacted).not.toBe(API_KEY_FAKE)
    expect(redacted).toMatch(/^sk-orca-[a-z]{3}…/)
    expect(redacted).not.toContain(API_KEY_FAKE.slice(11, -4))
    expect(redactOrcaRouterKey('')).toBe('')
    expect(isOrcaRouterKeyShape(API_KEY_FAKE)).toBe(true)
    expect(isOrcaRouterKeyShape('sk-orca-short')).toBe(false)
    expect(isOrcaRouterKeyShape(undefined)).toBe(false)
  })

  it('honours an explicit shared self-hosted base URL override', async () => {
    const { orcaRouterApiKeyAdapter } = await loadModule()
    writeFileSync(
      join(hermesHome, '.env'),
      `ORCAROUTER_API_KEY=${API_KEY_FAKE}\nORCAROUTER_BASE_URL=https://gateway.example.com\n`,
    )
    const stored = await orcaRouterApiKeyAdapter.load('default')
    expect(stored?.baseUrl).toBe('https://gateway.example.com/v1')
  })
})
