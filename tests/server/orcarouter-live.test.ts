import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Live acceptance through the provider code path this integration adds.
 *
 * Requires `ORCAROUTER_API_KEY`. Without it the suite is skipped rather than
 * mocked: a mocked catalog would prove nothing about the real gateway.
 */
const API_KEY = String(process.env.ORCAROUTER_API_KEY || '').trim()
const LIVE = API_KEY.length > 0

let hermesHome = ''
const originalHermesHome = process.env.HERMES_HOME

async function loadModules() {
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  const credentials = await import(
    '../../packages/server/src/modules/hermes/services/providers/orcarouter-credential'
  )
  const capabilities = await import(
    '../../packages/server/src/modules/hermes/services/providers/orcarouter-capabilities'
  )
  return { credentials, capabilities }
}

beforeEach(() => {
  hermesHome = mkdtempSync(join(tmpdir(), 'orcarouter-live-'))
  process.env.HERMES_HOME = hermesHome
  delete process.env.ORCAROUTER_BASE_URL
  delete process.env.ORCA_BASE_URL
  delete process.env.ORCA_API_BASE_URL
  mkdirSync(hermesHome, { recursive: true })
  writeFileSync(join(hermesHome, 'config.yaml'), 'model:\n  provider: orcarouter\n  default: openai/gpt-5.5\n')
  // The key is placed in the profile's own secret store, exactly as the API-key
  // adapter would, so the live read goes through the implemented seam.
  writeFileSync(join(hermesHome, '.env'), `ORCAROUTER_API_KEY=${API_KEY}\n`)
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  rmSync(hermesHome, { recursive: true, force: true })
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
})

describe.skipIf(!LIVE)('OrcaRouter live gateway (provider code path)', () => {
  it('resolves the stored key through the credential seam', async () => {
    const { credentials } = await loadModules()
    const resolved = await credentials.resolveOrcaRouterCredential('default', 'orcarouter')
    expect(resolved?.apiKey).toBe(API_KEY)
    expect(resolved?.baseUrl).toBe('https://api.orcarouter.ai/v1')
  })

  it('reads the live model catalog and only offers models the client can speak', async () => {
    const { capabilities } = await loadModules()
    const catalog = await capabilities.resolveOrcaRouterCapabilityCatalog('default', 'orcarouter')

    expect(catalog.source).toBe('live')
    expect(catalog.degraded).toBe(false)
    expect(catalog.models.chat.length).toBeGreaterThan(0)
    // Vendor/model namespaces are preserved verbatim.
    for (const model of catalog.models.chat) expect(model).toMatch(/^[a-z0-9.-]+\/[a-z0-9._-]+$/)
    // Non-text families never reach the text selector.
    expect(catalog.models.chat).not.toContain('acme/image-maker')
    // Every multimodal entry is a strict subset of chat.
    for (const model of catalog.models['chat-image']) expect(catalog.models.chat).toContain(model)
  })

  it('serves an identical catalog through the Auth entry point', async () => {
    const { capabilities } = await loadModules()
    const viaApiKey = await capabilities.resolveOrcaRouterCapabilityCatalog('default', 'orcarouter')
    writeFileSync(join(hermesHome, '.env'), '')
    writeFileSync(join(hermesHome, 'auth.json'), JSON.stringify({
      providers: { 'orcarouter-oauth': { api_key: API_KEY, auth_mode: 'oauth_pkce', scope: 'api' } },
      credential_pool: { 'orcarouter-oauth': [{ api_key: API_KEY, auth_type: 'oauth', source: 'loopback_pkce' }] },
    }))
    capabilities.resetOrcaRouterCapabilityCache()
    const viaPkce = await capabilities.resolveOrcaRouterCapabilityCatalog('default', 'orcarouter-oauth')
    expect(viaPkce.source).toBe('live')
    // The gateway does not promise a stable ordering between reads, so compare
    // the sets: both entries must see exactly the same routes.
    expect([...viaPkce.models.chat].sort()).toEqual([...viaApiKey.models.chat].sort())
  })

  it('completes a real chat completion through the resolved credential', async () => {
    const { credentials } = await loadModules()
    const resolved = await credentials.resolveOrcaRouterCredential('default', 'orcarouter')
    expect(resolved).toBeTruthy()

    const response = await fetch(`${resolved!.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved!.apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-pro',
        messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
        max_tokens: 16,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as any
    expect(Array.isArray(payload.choices)).toBe(true)
    expect(payload.choices.length).toBeGreaterThan(0)
    expect(String(payload.choices[0]?.message?.content || '').trim().length).toBeGreaterThan(0)
  }, 90_000)
})
