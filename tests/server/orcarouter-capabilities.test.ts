import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const FAKE_KEY = 'sk-orca-capability-fixture-0000000000'

/**
 * Catalog fixtures. Each entry declares its routes explicitly; nothing here is
 * inferred from a model name, and the multimodal entries are the only ones that
 * declare a non-text input modality.
 */
const CATALOG: Record<string, unknown[]> = {
  chat: [
    {
      id: 'openai/gpt-5.5',
      supported_endpoint_types: ['openai', 'openai-response'],
      context_length: 400000,
      architecture: { input_modalities: ['text'] },
      reasoning: { supported_efforts: ['low', 'medium', 'high', 'xhigh'] },
    },
    {
      id: 'deepseek/deepseek-v4-flash-vision-exp',
      supported_endpoint_types: ['openai'],
      context_length: 131072,
      architecture: { input_modalities: ['text', 'image'] },
    },
    {
      id: 'acme/audio-understanding',
      supported_endpoint_types: ['openai'],
      architecture: { input_modalities: ['text', 'audio'] },
    },
    // Non-text families the chat filter must exclude.
    { id: 'acme/image-maker', supported_endpoint_types: ['image-generation'], architecture: { input_modalities: ['text'] } },
    { id: 'acme/video-maker', supported_endpoint_types: ['openai-video'], architecture: { input_modalities: ['text'] } },
    { id: 'acme/reranker', supported_endpoint_types: ['jina-rerank'], architecture: { input_modalities: ['text'] } },
    // Undeclared routes fail closed.
    { id: 'acme/mystery-model', architecture: { input_modalities: ['text', 'image'] } },
  ],
  embedding: [{ id: 'acme/embed-1', supported_endpoint_types: ['embedding'] }],
  image: [{ id: 'acme/image-maker', supported_endpoint_types: ['image-generation'] }],
  video: [{ id: 'acme/video-maker', supported_endpoint_types: ['openai-video'] }],
  rerank: [{ id: 'acme/reranker', supported_endpoint_types: ['jina-rerank'] }],
}

let hermesHome = ''
let requestedUrls: string[] = []
const originalHermesHome = process.env.HERMES_HOME

async function loadCapabilities() {
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  return import('../../packages/server/src/modules/hermes/services/providers/orcarouter-capabilities')
}

function stubCatalog(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = new URL(String(input))
    requestedUrls.push(url.toString())
    expect(url.origin).toBe('https://api.orcarouter.ai')
    expect(url.pathname).toBe('/v1/models')
    const capability = url.searchParams.get('capability') || 'chat'
    return new Response(JSON.stringify({ data: CATALOG[capability] ?? [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }))
}

function writeEnv(key = FAKE_KEY, extra = ''): void {
  writeFileSync(join(hermesHome, '.env'), `ORCAROUTER_API_KEY=${key}\n${extra}`)
}

beforeEach(() => {
  hermesHome = mkdtempSync(join(tmpdir(), 'orcarouter-capabilities-'))
  process.env.HERMES_HOME = hermesHome
  delete process.env.ORCAROUTER_API_KEY
  delete process.env.ORCAROUTER_BASE_URL
  delete process.env.ORCA_BASE_URL
  delete process.env.ORCA_API_BASE_URL
  mkdirSync(hermesHome, { recursive: true })
  writeFileSync(join(hermesHome, 'config.yaml'), 'model:\n  provider: orcarouter\n  default: openai/gpt-5.5\n')
  requestedUrls = []
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  rmSync(hermesHome, { recursive: true, force: true })
  delete process.env.ORCAROUTER_API_KEY
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
})

describe('OrcaRouter capability catalog', () => {
  it('reads every capability from the live catalog with the stored key', async () => {
    writeEnv()
    stubCatalog()
    const { resolveOrcaRouterCapabilityCatalog } = await loadCapabilities()
    const catalog = await resolveOrcaRouterCapabilityCatalog('default', 'orcarouter')

    expect(catalog.source).toBe('live')
    expect(catalog.degraded).toBe(false)
    const capabilities = requestedUrls.map(url => new URL(url).searchParams.get('capability')).sort()
    expect(capabilities).toEqual(['chat', 'embedding', 'image', 'rerank', 'video'])
    for (const call of (fetch as any).mock.calls) {
      expect(String(call[1]?.headers?.Authorization)).toBe(`Bearer ${FAKE_KEY}`)
    }
  })

  it('keeps vendor/model namespaces verbatim', async () => {
    writeEnv()
    stubCatalog()
    const { resolveOrcaRouterCapabilityCatalog } = await loadCapabilities()
    const catalog = await resolveOrcaRouterCapabilityCatalog('default', 'orcarouter')
    expect(catalog.models.chat).toContain('openai/gpt-5.5')
    expect(catalog.models.chat).toContain('deepseek/deepseek-v4-flash-vision-exp')
  })

  it('filters each entry point separately: text, embedding, image, video, rerank', async () => {
    writeEnv()
    stubCatalog()
    const { resolveOrcaRouterCapabilityCatalog } = await loadCapabilities()
    const { models } = await resolveOrcaRouterCapabilityCatalog('default', 'orcarouter')

    expect(models.chat).toEqual(['openai/gpt-5.5', 'deepseek/deepseek-v4-flash-vision-exp', 'acme/audio-understanding'])
    expect(models.embedding).toEqual(['acme/embed-1'])
    expect(models.image).toEqual(['acme/image-maker'])
    expect(models.video).toEqual(['acme/video-maker'])
    expect(models.rerank).toEqual(['acme/reranker'])
  })

  it('fails closed on multimodal: only models declaring the modality appear', async () => {
    writeEnv()
    stubCatalog()
    const { resolveOrcaRouterCapabilityCatalog } = await loadCapabilities()
    const { models } = await resolveOrcaRouterCapabilityCatalog('default', 'orcarouter')

    expect(models['chat-image']).toEqual(['deepseek/deepseek-v4-flash-vision-exp'])
    expect(models['chat-audio']).toEqual(['acme/audio-understanding'])
    expect(models['chat-video']).toEqual([])
    // The undeclared-route model never reaches any selector.
    for (const bucket of Object.values(models)) expect(bucket).not.toContain('acme/mystery-model')
  })

  it('serves the identical result through the API-key and PKCE entry points', async () => {
    writeEnv()
    stubCatalog()
    const { resolveOrcaRouterCapabilityCatalog } = await loadCapabilities()
    const viaApiKey = await resolveOrcaRouterCapabilityCatalog('default', 'orcarouter')

    writeFileSync(join(hermesHome, 'auth.json'), JSON.stringify({
      providers: { 'orcarouter-oauth': { api_key: FAKE_KEY, auth_mode: 'oauth_pkce', scope: 'api' } },
      credential_pool: { 'orcarouter-oauth': [{ api_key: FAKE_KEY, auth_type: 'oauth', source: 'loopback_pkce' }] },
    }))
    writeFileSync(join(hermesHome, '.env'), '')
    const { resetOrcaRouterCapabilityCache } = await loadCapabilities()
    resetOrcaRouterCapabilityCache()
    const viaPkce = await resolveOrcaRouterCapabilityCatalog('default', 'orcarouter-oauth')

    expect(viaPkce.models).toEqual(viaApiKey.models)
    expect(viaPkce.source).toBe('live')
  })

  it('falls back to the labelled verified seed when the catalog cannot be read', async () => {
    writeEnv()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND') }))
    const { resolveOrcaRouterCapabilityCatalog } = await loadCapabilities()
    const catalog = await resolveOrcaRouterCapabilityCatalog('default', 'orcarouter')

    expect(catalog.source).toBe('seed')
    expect(catalog.degraded).toBe(true)
    expect(catalog.reason).toBeTruthy()
    expect(catalog.models.chat).toContain('openai/gpt-5.5')
    // A degraded catalog never invents multimodal, embedding or rerank routes.
    expect(catalog.models['chat-image']).toEqual([])
    expect(catalog.models.embedding).toEqual([])
    expect(catalog.models.image).toEqual([])
    expect(catalog.models.video).toEqual([])
    expect(catalog.models.rerank).toEqual([])
  })

  it('treats an empty live chat catalog as degraded rather than authoritative', async () => {
    writeEnv()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })))
    const { resolveOrcaRouterCapabilityCatalog } = await loadCapabilities()
    const catalog = await resolveOrcaRouterCapabilityCatalog('default', 'orcarouter')
    expect(catalog.source).toBe('seed')
    expect(catalog.degraded).toBe(true)
  })

  it('treats an auth failure as degraded rather than falling back to free text', async () => {
    writeEnv()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })))
    const { resolveOrcaRouterCapabilityCatalog } = await loadCapabilities()
    const catalog = await resolveOrcaRouterCapabilityCatalog('default', 'orcarouter')
    expect(catalog.source).toBe('seed')
    expect(catalog.models.chat.length).toBeGreaterThan(0)
  })

  it('uses the seed when no credential is configured at all', async () => {
    writeFileSync(join(hermesHome, '.env'), '')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { resolveOrcaRouterCapabilityCatalog } = await loadCapabilities()
    const catalog = await resolveOrcaRouterCapabilityCatalog('default', 'orcarouter')
    expect(catalog.source).toBe('seed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reads the catalog from an explicit self-hosted API override', async () => {
    writeEnv(FAKE_KEY, 'ORCAROUTER_BASE_URL=https://gateway.example.com\n')
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      requestedUrls.push(String(input))
      return new Response(JSON.stringify({ data: CATALOG.chat }), { status: 200 })
    }))
    const { resolveOrcaRouterCapabilityCatalog } = await loadCapabilities()
    await resolveOrcaRouterCapabilityCatalog('default', 'orcarouter')
    expect(requestedUrls[0].startsWith('https://gateway.example.com/v1/models?')).toBe(true)
  })

  it('caches the resolved catalog for repeated reads', async () => {
    writeEnv()
    stubCatalog()
    const { resolveOrcaRouterCapabilityCatalog } = await loadCapabilities()
    await resolveOrcaRouterCapabilityCatalog('default', 'orcarouter')
    const callsAfterFirst = requestedUrls.length
    await resolveOrcaRouterCapabilityCatalog('default', 'orcarouter')
    expect(requestedUrls.length).toBe(callsAfterFirst)
  })
})
