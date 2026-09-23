import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_EKKO_JEV_CONFIG, EkkoAgent, EkkoConfigError, EkkoJevClient,
  choice, noul, score, normalizeEkkoConfig, resolveEkkoJevConfig,
} from '../../packages/ekko-agent/src'

const questions = {
  relevant: noul('Does the card help answer the question?'),
  relation: choice('How are these facts related?', { duplicate: null, independent: null }),
  usefulness: score('How useful is this card?', ['Unrelated', 'Useful', 'Essential']),
}
const response = {
  model: 'jev-test', usage: { input_tokens: 10, output_tokens: 5 },
  answers: {
    relevant: { type: 'noul', noul: 0.9 },
    relation: { type: 'choice', choice: 'independent', confidence: 0.9, probabilities: { duplicate: 0.1, independent: 0.9 } },
    usefulness: { type: 'score', score: 1, confidence: 1, legend: { '0': 'Unrelated', '1': 'Useful', '2': 'Essential' }, probabilities: { '0': 0, '1': 1, '2': 0 } },
  },
}
const upstream = vi.fn<typeof fetch>()
let directory: string
const agents: EkkoAgent[] = []

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ekko-jev-'))
  upstream.mockReset().mockImplementation(async () => Response.json(response))
  vi.stubGlobal('fetch', upstream)
})
afterEach(async () => {
  for (const agent of agents.splice(0)) agent.close()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

function create(options: ConstructorParameters<typeof EkkoAgent>[0] = {}): EkkoAgent {
  const agent = new EkkoAgent({ baseDirectory: directory, env: { NODE_ENV: 'test' }, ...options })
  agents.push(agent)
  return agent
}

function requestKey(index = 0): string | null {
  return new Headers(upstream.mock.calls[index]?.[1]?.headers).get('authorization')
}

describe('Ekko JEV configuration', () => {
  it('migrates existing JEV settings without automatically activating memory enhancements', () => {
    const config = normalizeEkkoConfig({ schemaVersion: 10, jev: { enabled: true, memoryEnabled: true, apiKey: 'legacy' } })
    expect(config.jev).toEqual({ ...DEFAULT_EKKO_JEV_CONFIG, enabled: true, memoryEnabled: true, apiKey: 'legacy' })
    expect(config.schemaVersion).toBe(13)
    expect(resolveEkkoJevConfig(config.jev, { memoryWriteReviewEnabled: true }, { memoryWriteReviewEnabled: false }))
      .toMatchObject({ memoryWriteReviewEnabled: false, apiKey: 'legacy' })
  })

  it.each([
    { memoryKindRoutingEnabled: 'false' }, { memoryRerankEnabled: 1 }, { memoryWriteReviewEnabled: null },
    { memoryCandidateLimit: 0 }, { memoryCandidateLimit: 51 }, { memoryCandidateLimit: 1.5 },
    { memoryMinConfidence: 0.1 }, { memoryMinConfidence: Number.NaN }, { memoryMinConfidence: 2 },
    { memoryRecallMinConfidence: 0.4 }, { memoryRecallMinConfidence: Number.NaN }, { memoryRecallMinConfidence: 1.1 },
    { memoryRelevanceFilterEnabled: 'true' }, { memoryFilterMinConfidence: 0.4 }, { memoryFilterMinConfidence: Number.NaN }, { memoryFilterMinConfidence: 1.1 },
    { memoryTimeoutMs: 99 }, { memoryTimeoutMs: 30_001 },
  ])('rejects invalid memory settings: %j', input => {
    expect(() => normalizeEkkoConfig({ jev: input } as any)).toThrow(EkkoConfigError)
  })
  it('adds disabled defaults to older configs while retaining their settings', () => {
    const config = normalizeEkkoConfig({ schemaVersion: 9, runtime: { maxSteps: 17 } })
    expect(config.jev).toEqual(DEFAULT_EKKO_JEV_CONFIG)
    expect(config.runtime.maxSteps).toBe(17)
    expect(config.schemaVersion).toBe(13)
  })

  it('uses local settings when no override is supplied, including after restarting', async () => {
    const original = create({ config: { jev: { enabled: true, apiKey: 'local-key', model: 'jev-local' } } })
    original.close()
    const restarted = create()
    await expect(restarted.jev.evaluate({ state: null, questions })).resolves.toEqual(response)
    expect(requestKey()).toBe('Bearer local-key')
    expect(JSON.parse(upstream.mock.calls[0][1]!.body as string).model).toBe('jev-local')
  })

  it('prefers constructor and runtime overrides without persisting either', async () => {
    const agent = create({
      config: { jev: { enabled: true, apiKey: 'local-key', model: 'jev-local', timeoutMs: 5000 } },
      jev: { apiKey: 'constructor-key' },
    })
    const before = await readFile(agent.layout.configPath, 'utf8')
    await agent.jev.evaluate({ state: null, questions })
    const runtime = agent.default.runtime.create({ jev: { apiKey: 'runtime-key', model: 'jev-runtime' } })
    await runtime.jev.evaluate({ state: null, questions })
    expect(requestKey(0)).toBe('Bearer constructor-key')
    expect(requestKey(1)).toBe('Bearer runtime-key')
    expect(runtime.jev.settings).toMatchObject({ model: 'jev-runtime', timeoutMs: 5000 })
    expect(await readFile(agent.layout.configPath, 'utf8')).toBe(before)
    expect(before).not.toMatch(/constructor-key|runtime-key/)
    expect(agent.config.read().jev).toMatchObject({ apiKey: 'local-key', model: 'jev-local' })
  })

  it('keeps overrides when persisted settings are updated and does not mutate caller objects', async () => {
    const overrides = { apiKey: 'initial-override' }
    const agent = create({ config: { jev: { enabled: true, apiKey: 'local-key' } }, jev: overrides })
    overrides.apiKey = 'changed-by-caller'
    agent.config.update({ jev: { apiKey: 'new-local-key', model: 'jev-updated' } })
    await agent.jev.evaluate({ state: null, questions })
    expect(requestKey()).toBe('Bearer initial-override')
    expect(agent.jev.settings.model).toBe('jev-updated')
    expect(agent.config.read().jev.apiKey).toBe('new-local-key')
    // Newly created runtimes also read direct edits to the persisted file.
    const config = agent.config.read()
    config.jev.model = 'jev-edited-file'
    await writeFile(agent.layout.configPath, JSON.stringify(config))
    expect(agent.default.runtime.create().jev.settings.model).toBe('jev-edited-file')
  })

  it('persists the memory switch and applies explicit runtime overrides without writing them back', async () => {
    const local = create({ config: { jev: { enabled: true, memoryEnabled: true, apiKey: 'local-key' } } })
    local.close()
    const agent = create({ jev: { memoryEnabled: false } })
    expect(agent.readConfig().jev.memoryEnabled).toBe(true)
    expect(agent.jev.settings.memoryEnabled).toBe(false)
    expect(agent.default.runtime.create().jev.settings.memoryEnabled).toBe(false)
    const runtime = agent.default.runtime.create({ jev: { memoryEnabled: true } })
    expect(runtime.jev.settings.memoryEnabled).toBe(true)
    agent.updateConfig({ jev: { model: 'updated' } })
    expect(agent.jev.settings.memoryEnabled).toBe(false)
    expect(agent.readConfig().jev.memoryEnabled).toBe(true)
    runtime.jev.configure({ enabled: true, apiKey: 'host-key', memoryEnabled: false })
    expect(runtime.jev.settings.memoryEnabled).toBe(false)
    expect(runtime.jev.available).toBe(true)
    // Other JEV consumers remain available when memory opts out.
    await expect(runtime.jev.evaluate({ state: null, questions })).resolves.toEqual(response)
  })

  it('honors explicit disabling and empty keys without inheriting credentials from the environment', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'environment-key')
    const agent = create({ config: { jev: { enabled: true, apiKey: 'local-key' } } })
    for (const jev of [false, { enabled: false }, { apiKey: '' }] as const) {
      const runtime = agent.default.runtime.create({ jev })
      expect(runtime.jev.available).toBe(false)
      expect(await runtime.jev.evaluate({ state: null, questions })).toBeUndefined()
    }
    expect(await new EkkoJevClient().evaluate({ state: null, questions })).toBeUndefined()
    expect(upstream).not.toHaveBeenCalled()
    expect(agent.config.read().jev.apiKey).toBe('local-key')
  })

  it('ignores undefined override fields but retains explicit false and empty values', () => {
    expect(resolveEkkoJevConfig({ enabled: true, apiKey: 'local' }, { model: undefined, apiKey: '', enabled: false }))
      .toMatchObject({ enabled: false, apiKey: '', model: 'jev-latest' })
  })

  it.each([
    { enabled: 'yes' }, { memoryEnabled: 'false' }, { memoryEnabled: 1 }, { memoryEnabled: null },
    { apiKey: 'secret\nkey' }, { model: '' }, { timeoutMs: 0 },
    { timeoutMs: '10000' }, { baseUrl: 'file:///tmp/key' }, { baseUrl: 'https://user:secret@example.test' },
  ])('validates both stored settings and runtime overrides: %j', settings => {
    expect(() => normalizeEkkoConfig({ jev: settings })).toThrow(EkkoConfigError)
    expect(() => resolveEkkoJevConfig(settings as any)).toThrow()
  })
})

describe('Ekko internal JEV client', () => {
  it('evaluates typed questions using its own SDK client and exposes only redacted settings', async () => {
    const client = new EkkoJevClient({ enabled: true, apiKey: 'private-key', baseUrl: 'https://jev.example.test/', model: 'jev-configured' })
    expect(await client.evaluate({ state: { text: 'example' }, questions, model: 'jev-override' })).toEqual(response)
    const [url, init] = upstream.mock.calls[0]
    expect(url).toBe('https://jev.example.test/v1/systemone')
    expect(init?.redirect).toBe('error')
    expect(JSON.parse(init!.body as string)).toEqual({ state: { text: 'example' }, questions, model: 'jev-override' })
    expect(JSON.stringify(client.settings)).not.toContain('private-key')
    expect(JSON.stringify(client)).not.toContain('private-key')
  })

  it('preserves an in-flight request snapshot across configuration replacement', async () => {
    let release!: (response: Response) => void
    upstream.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const client = new EkkoJevClient({ enabled: true, apiKey: 'first-key' })
    const first = client.evaluate({ state: 'first', questions })
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1))
    client.configure({ enabled: true, apiKey: 'second-key' })
    await client.evaluate({ state: 'second', questions })
    release(Response.json(response))
    await first
    expect(requestKey(0)).toBe('Bearer first-key')
    expect(requestKey(1)).toBe('Bearer second-key')
  })

  it.each([401, 403, 429, 500])('sanitizes HTTP %i errors and supports optional fallback without retrying', async status => {
    upstream.mockResolvedValue(Response.json({ error: 'private-key private-state' }, { status }))
    const client = new EkkoJevClient({ enabled: true, apiKey: 'private-key' })
    const code = [401, 403].includes(status) ? 'jev_auth_failed' : status === 429 ? 'jev_rate_limited' : 'jev_provider_error'
    await expect(client.evaluate({ state: 'private-state', questions })).rejects.toMatchObject({ code, message: `JEV provider returned HTTP ${status}.` })
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(await client.tryEvaluate({ state: 'private-state', questions })).toBeUndefined()
    expect(upstream).toHaveBeenCalledTimes(2)
  })

  it('times out and lets optional callers fall back', async () => {
    upstream.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const client = new EkkoJevClient({ enabled: true, apiKey: 'key', timeoutMs: 1000 })
    await expect(client.evaluate({ state: null, questions })).rejects.toMatchObject({ code: 'jev_timeout' })
    expect(await client.tryEvaluate({ state: null, questions })).toBeUndefined()
  })

  it('propagates cancellation instead of interpreting it as fallback', async () => {
    const client = new EkkoJevClient({ enabled: true, apiKey: 'key' })
    const controller = new AbortController()
    controller.abort()
    await expect(client.tryEvaluate({ state: null, questions }, { signal: controller.signal })).rejects.toMatchObject({ code: 'jev_cancelled' })
    expect(upstream).not.toHaveBeenCalled()
  })

  it.each([{}, { state: true, questions }, { state: '', questions: {} },
    { state: '', questions: { bad: { type: 'score', criteria: ['only one'] } } },
  ])('rejects malformed requests locally: %j', async request => {
    const client = new EkkoJevClient({ enabled: true, apiKey: 'key' })
    await expect(client.tryEvaluate(request as any)).rejects.toMatchObject({ code: 'jev_invalid_request' })
    expect(upstream).not.toHaveBeenCalled()
  })
})
