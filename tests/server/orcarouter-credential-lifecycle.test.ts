import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const OLD_KEY = 'sk-orca-old-generation-000000000000'
const NEW_KEY = 'sk-orca-new-generation-000000000000'

let hermesHome = ''
const originalHermesHome = process.env.HERMES_HOME

function authPath(profile = 'default'): string {
  const dir = profile === 'default' ? hermesHome : join(hermesHome, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'auth.json')
}

function writeDurableKey(key: string): void {
  writeFileSync(authPath(), JSON.stringify({
    version: 1,
    providers: {
      'orcarouter-oauth': {
        api_key: key,
        auth_mode: 'oauth_pkce',
        scope: 'api',
        obtained_at: new Date(0).toISOString(),
        last_refresh: new Date(0).toISOString(),
      },
    },
    credential_pool: {
      'orcarouter-oauth': [{
        id: 'orcarouter-oauth-1',
        auth_type: 'oauth',
        source: 'loopback_pkce',
        priority: 0,
        api_key: key,
      }],
    },
  }, null, 2))
}

async function loadResolver() {
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  return import('../../packages/server/src/modules/hermes/services/providers/authorized-provider-credentials')
}

beforeEach(() => {
  hermesHome = mkdtempSync(join(tmpdir(), 'orcarouter-lifecycle-'))
  process.env.HERMES_HOME = hermesHome
  delete process.env.ORCAROUTER_API_KEY
  mkdirSync(hermesHome, { recursive: true })
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  rmSync(hermesHome, { recursive: true, force: true })
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
})

describe('OrcaRouter durable credential lifecycle', () => {
  it('reuses the stored key across restarts without any refresh call', async () => {
    writeDurableKey(OLD_KEY)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { resolveAuthorizedProviderRuntimeCredentials } = await loadResolver()

    for (let restart = 0; restart < 3; restart += 1) {
      vi.resetModules()
      const { resolveAuthorizedProviderRuntimeCredentials: again } = await loadResolver()
      const credentials = await again({ profile: 'default', provider: 'orcarouter-oauth' })
      expect(credentials.apiKey).toBe(OLD_KEY)
      expect(credentials.baseUrl).toBe('https://api.orcarouter.ai/v1')
      expect(credentials.apiMode).toBe('chat_completions')
    }
    // A durable API key has no refresh grant: nothing may be posted anywhere.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not fabricate a refresh token for the durable key', async () => {
    writeDurableKey(OLD_KEY)
    writeFileSync(authPath(), JSON.stringify({
      providers: {
        'orcarouter-oauth': {
          api_key: OLD_KEY,
          // A hostile/stale record trying to look like a refreshable session.
          tokens: { refresh_token: 'pretend-refresh', expires_in: 1 },
          last_refresh: new Date(0).toISOString(),
        },
      },
      credential_pool: {
        'orcarouter-oauth': [{ api_key: OLD_KEY, refresh_token: 'pretend-refresh', auth_type: 'oauth' }],
      },
    }, null, 2))
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { resolveAuthorizedProviderRuntimeCredentials } = await loadResolver()
    const credentials = await resolveAuthorizedProviderRuntimeCredentials({
      profile: 'default',
      provider: 'orcarouter-oauth',
    })
    expect(credentials.apiKey).toBe(OLD_KEY)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('classifies a rejected key as terminal reauthentication, never a refresh loop', async () => {
    writeDurableKey(OLD_KEY)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { resolveAuthorizedProviderRuntimeCredentials } = await loadResolver()

    let caught: any
    try {
      await resolveAuthorizedProviderRuntimeCredentials({
        profile: 'default',
        provider: 'orcarouter-oauth',
        forceRefresh: true,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toMatchObject({ code: 'ORCAROUTER_KEY_REJECTED', reloginRequired: true })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(String(caught.message)).not.toContain(OLD_KEY)
  })

  it('reports a missing credential as a reauthentication requirement', async () => {
    const { resolveAuthorizedProviderRuntimeCredentials } = await loadResolver()
    await expect(resolveAuthorizedProviderRuntimeCredentials({
      profile: 'default',
      provider: 'orcarouter-oauth',
    })).rejects.toMatchObject({ code: 'AUTHORIZED_PROVIDER_AUTH_MISSING', reloginRequired: true })
  })

  it('keeps a rejected old generation from overwriting a freshly issued key', async () => {
    writeDurableKey(OLD_KEY)
    const { resolveAuthorizedProviderRuntimeCredentials } = await loadResolver()

    // A request that started before the reconnect is rejected...
    const staleFailure = resolveAuthorizedProviderRuntimeCredentials({
      profile: 'default',
      provider: 'orcarouter-oauth',
      forceRefresh: true,
    }).catch(err => err)

    // ...while the user reconnects and a new key is written.
    writeDurableKey(NEW_KEY)
    const failure = await staleFailure
    expect(failure).toMatchObject({ code: 'ORCAROUTER_KEY_REJECTED' })

    // The failure must not have deleted or rewritten the store.
    const onDisk = JSON.parse(readFileSync(authPath(), 'utf8'))
    expect(onDisk.providers['orcarouter-oauth'].api_key).toBe(NEW_KEY)

    vi.resetModules()
    const { resolveAuthorizedProviderRuntimeCredentials: after } = await loadResolver()
    const credentials = await after({ profile: 'default', provider: 'orcarouter-oauth' })
    expect(credentials.apiKey).toBe(NEW_KEY)
  })

  it('keeps the old secret on disk until a new login succeeds', async () => {
    writeDurableKey(OLD_KEY)
    const { resolveAuthorizedProviderRuntimeCredentials } = await loadResolver()
    await resolveAuthorizedProviderRuntimeCredentials({
      profile: 'default',
      provider: 'orcarouter-oauth',
      forceRefresh: true,
    }).catch(() => undefined)
    const onDisk = JSON.parse(readFileSync(authPath(), 'utf8'))
    expect(onDisk.providers['orcarouter-oauth'].api_key).toBe(OLD_KEY)
  })
})
