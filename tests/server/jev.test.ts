import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../../packages/server/src/modules/studio/public/config'
import { evaluateJev, getJevRuntimeConfig, choice, score, noul } from '../../packages/server/src/modules/studio/public/jev'
import { getJevSettings, saveJevSettings, deleteJevSettings, readJevCredentials } from '../../packages/server/src/modules/studio/services/jev/settings'
import { getSettings, saveSettings, evaluate } from '../../packages/server/src/modules/studio/controllers/jev'

const skillsDefaults = { ekkoSkillsEnabled: false, ekkoSkillsCandidateLimit: 20, ekkoSkillsMinConfidence: 0.8, ekkoSkillsTimeoutMs: 3000 }
const directory = join(config.appHome, 'models', 'jev')
const upstream = vi.fn<typeof fetch>()
const questions = {
  route: choice('Route?', { billing: null, technical: 'Software' }),
  urgency: score('Urgency?', ['Routine', 'Urgent']),
  actionable: noul('Is action needed?'),
}
const response = {
  model: 'jev-test', usage: { input_tokens: 10, output_tokens: 5 },
  answers: {
    route: { type: 'choice', choice: 'billing', confidence: 0.9, probabilities: { billing: 0.9, technical: 0.1 } },
    urgency: { type: 'score', score: 0.7, confidence: 0.8, legend: { '0': 'Routine', '1': 'Urgent' }, probabilities: { '0': 0.3, '1': 0.7 } },
    actionable: { type: 'noul', noul: 0.9 },
  },
}

beforeEach(async () => {
  await rm(directory, { recursive: true, force: true })
  upstream.mockReset().mockImplementation(async () => Response.json(response))
  vi.stubGlobal('fetch', upstream)
})
afterEach(() => vi.unstubAllGlobals())

describe('JEV settings', () => {
  it('round-trips one skills switch and shared parameters, with isolated defaults and reset', async () => {
    const options = { ekkoSkillsEnabled: true, ekkoSkillsCandidateLimit: 7, ekkoSkillsMinConfidence: 0.95, ekkoSkillsTimeoutMs: 1200 }
    expect(await getJevSettings('work')).toMatchObject(skillsDefaults)
    await saveJevSettings('work', { ...options, apiKey: 'work-key' })
    expect(await getJevSettings('work')).toMatchObject(options)
    expect(await getJevRuntimeConfig('work')).toMatchObject({ enabled: true, skillsEnabled: true,
      skillsCandidateLimit: 7, skillsMinConfidence: 0.95, skillsTimeoutMs: 1200, memoryEnabled: false })
    await saveJevSettings('work', { ekkoSkillsEnabled: false })
    expect(await getJevRuntimeConfig('work')).toMatchObject({ enabled: true, skillsEnabled: false, skillsCandidateLimit: 7 })
    expect(await getJevSettings('default')).toMatchObject(skillsDefaults)
    expect(await deleteJevSettings('work')).toMatchObject({ ...skillsDefaults, hasApiKey: false })
  })

  it('round-trips all memory options, preserves them while disabled, and resets only the selected Profile', async () => {
    const options = { ekkoMemoryEnabled: true, ekkoMemoryKindRoutingEnabled: true, ekkoMemoryRelevanceFilterEnabled: true, ekkoMemoryRerankEnabled: true,
      ekkoMemoryWriteReviewEnabled: true, ekkoMemoryCandidateLimit: 7, ekkoMemoryRecallMinConfidence: 0.65, ekkoMemoryFilterMinConfidence: 0.9, ekkoMemoryMinConfidence: 0.95, ekkoMemoryTimeoutMs: 1200 }
    await saveJevSettings('research', { ...options, apiKey: 'research-key' })
    await saveJevSettings('research', { ekkoMemoryEnabled: false })
    expect(await getJevSettings('research')).toMatchObject({ ...options, ekkoMemoryEnabled: false })
    expect(await getJevSettings('research')).toMatchObject(skillsDefaults)
    expect(await getJevRuntimeConfig('research')).toMatchObject({ enabled: true, memoryEnabled: false,
      memoryKindRoutingEnabled: true, memoryRelevanceFilterEnabled: true, memoryRerankEnabled: true, memoryWriteReviewEnabled: true,
      memoryCandidateLimit: 7, memoryRecallMinConfidence: 0.65, memoryFilterMinConfidence: 0.9, memoryMinConfidence: 0.95, memoryTimeoutMs: 1200 })
    expect(await getJevRuntimeConfig('default')).toMatchObject({ enabled: false, memoryKindRoutingEnabled: true, memoryWriteReviewEnabled: true })
    await saveJevSettings('other', options)
    expect(await deleteJevSettings('research')).toMatchObject({ ekkoMemoryKindRoutingEnabled: true,
      ekkoMemoryRelevanceFilterEnabled: true, ekkoMemoryRerankEnabled: true, ekkoMemoryWriteReviewEnabled: true, ekkoMemoryCandidateLimit: 20,
      ekkoMemoryRecallMinConfidence: 0.5, ekkoMemoryFilterMinConfidence: 0.8, ekkoMemoryMinConfidence: 0.8, ekkoMemoryTimeoutMs: 3000 })
    expect(await getJevSettings('other')).toMatchObject(options)
  })
  it('exports complete server-only runtime values and explicitly disables an unconfigured Profile', async () => {
    await saveJevSettings('research', { apiKey: 'research-key', model: 'jev-research' })
    expect(await getJevRuntimeConfig('research')).toMatchObject({ enabled: true, apiKey: 'research-key', model: 'jev-research' })
    expect(await getJevRuntimeConfig('other')).toEqual({
      skillsEnabled: false, skillsCandidateLimit: 20, skillsMinConfidence: 0.8, skillsTimeoutMs: 3000,
      enabled: false, memoryEnabled: false, memoryKindRoutingEnabled: true, memoryRelevanceFilterEnabled: true, memoryRerankEnabled: true, memoryWriteReviewEnabled: true, memoryCandidateLimit: 20, memoryRecallMinConfidence: 0.5, memoryFilterMinConfidence: 0.8, memoryMinConfidence: 0.8, memoryTimeoutMs: 3000, apiKey: '', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', timeoutMs: 10000,
    })
    expect(JSON.stringify(await getJevSettings('research'))).not.toContain('research-key')
  })
  it('isolates profiles and returns only credential presence', async () => {
    const saved = await saveJevSettings('research', { apiKey: 'private-key', model: 'jev-research' })
    expect(saved).toEqual({ workflowQualityEnabled: false, workflowQualityMinConfidence: 0.8, workflowQualityTimeoutMs: 5000, groupSummaryReviewEnabled: false, groupSummaryReviewMinConfidence: 0.8, groupSummaryReviewTimeoutMs: 3000, ...skillsDefaults, baseUrl: 'https://api.typesafe.ai', model: 'jev-research', timeoutMs: 10000, hasApiKey: true, ekkoMemoryEnabled: false, ekkoMemoryKindRoutingEnabled: true, ekkoMemoryRelevanceFilterEnabled: true, ekkoMemoryRerankEnabled: true, ekkoMemoryWriteReviewEnabled: true, ekkoMemoryCandidateLimit: 20, ekkoMemoryRecallMinConfidence: 0.5, ekkoMemoryFilterMinConfidence: 0.8, ekkoMemoryMinConfidence: 0.8, ekkoMemoryTimeoutMs: 3000 })
    expect(JSON.stringify(await getJevSettings('research'))).not.toContain('private-key')
    expect(await getJevSettings('default')).toMatchObject({ model: 'jev-latest', hasApiKey: false })
    const [file] = await readdir(directory)
    expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
  })

  it('persists the memory switch per Profile, maps it to Ekko, and resets it on deletion', async () => {
    await saveJevSettings('research', { apiKey: 'research-key', ekkoMemoryEnabled: true })
    await saveJevSettings('research', { model: 'updated' })
    expect(await getJevSettings('research')).toMatchObject({ ekkoMemoryEnabled: true })
    expect(await getJevRuntimeConfig('research')).toMatchObject({ enabled: true, memoryEnabled: true,
      memoryKindRoutingEnabled: true, memoryRelevanceFilterEnabled: true, memoryRerankEnabled: true, memoryWriteReviewEnabled: true })
    expect(await getJevRuntimeConfig('default')).toMatchObject({ enabled: false, memoryEnabled: false })
    await saveJevSettings('research', { ekkoMemoryEnabled: false })
    expect(await getJevRuntimeConfig('research')).toMatchObject({ enabled: true, memoryEnabled: false, apiKey: 'research-key' })
    // The memory switch does not disable the shared evaluator.
    await expect(evaluateJev('research', { state: '', questions })).resolves.toEqual(response)
    await saveJevSettings('research', { ekkoMemoryEnabled: true })
    expect(await deleteJevSettings('research')).toMatchObject({ ekkoMemoryEnabled: false, hasApiKey: false })
  })

  it('defaults missing legacy Studio child switches on while keeping the master off', async () => {
    await saveJevSettings('research', { apiKey: 'legacy-key' })
    const [file] = await readdir(directory)
    await writeFile(join(directory, file), JSON.stringify({ apiKey: 'legacy-key', model: 'legacy-model', ekkoMemoryMinConfidence: 0.9 }))
    expect(await getJevRuntimeConfig('research')).toMatchObject({ enabled: true, memoryEnabled: false,
      memoryKindRoutingEnabled: true, memoryRelevanceFilterEnabled: true, memoryRerankEnabled: true, memoryWriteReviewEnabled: true,
      apiKey: 'legacy-key', model: 'legacy-model', memoryRecallMinConfidence: 0.5, memoryMinConfidence: 0.9 })
  })

  it('preserves explicit disabled switches in existing Studio settings and partial updates', async () => {
    await saveJevSettings('research', { apiKey: 'key' })
    const [file] = await readdir(directory)
    const disabled = { ekkoMemoryEnabled: true, ekkoMemoryKindRoutingEnabled: false,
      ekkoMemoryRelevanceFilterEnabled: false, ekkoMemoryRerankEnabled: false, ekkoMemoryWriteReviewEnabled: false }
    await writeFile(join(directory, file), JSON.stringify({ apiKey: 'key', ...disabled }))
    expect(await getJevSettings('research')).toMatchObject(disabled)
    await saveJevSettings('research', { model: 'edited' })
    expect(await getJevSettings('research')).toMatchObject(disabled)
    expect(await getJevRuntimeConfig('research')).toMatchObject({ enabled: true, memoryEnabled: true,
      memoryKindRoutingEnabled: false, memoryRelevanceFilterEnabled: false, memoryRerankEnabled: false, memoryWriteReviewEnabled: false })
  })

  it('preserves blank/omitted keys, replaces explicit keys and clears only the selected profile', async () => {
    await saveJevSettings('default', { apiKey: 'default-key' })
    await saveJevSettings('research', { apiKey: 'old-key' })
    await saveJevSettings('research', { apiKey: '', model: 'jev-edited' })
    expect((await readJevCredentials('research')).apiKey).toBe('old-key')
    await saveJevSettings('research', { timeoutMs: 20000 })
    expect((await readJevCredentials('research')).apiKey).toBe('old-key')
    await saveJevSettings('research', { apiKey: 'new-key' })
    expect((await readJevCredentials('research')).apiKey).toBe('new-key')
    expect(await deleteJevSettings('research')).toMatchObject({ hasApiKey: false, model: 'jev-latest' })
    expect((await readJevCredentials('default')).apiKey).toBe('default-key')
    for (const file of await readdir(directory)) {
      expect(await readFile(join(directory, file), 'utf8')).not.toMatch(/old-key|new-key/)
    }
  })

  it('serializes concurrent changes without losing the key or other settings', async () => {
    await Promise.all([
      saveJevSettings('research', { apiKey: 'key' }),
      saveJevSettings('research', { model: 'jev-new' }),
      saveJevSettings('research', { timeoutMs: 5000 }),
    ])
    expect(await readJevCredentials('research')).toMatchObject({ apiKey: 'key', model: 'jev-new', timeoutMs: 5000 })
  })

  it.each([
    { baseUrl: 'file:///tmp/key' }, { baseUrl: 'https://user:pass@example.test' },
    { baseUrl: 'https://example.test?token=key' }, { model: '' },
    { timeoutMs: 0 }, { timeoutMs: '10000' }, { apiKey: 123 }, { unknown: true },
    { ekkoMemoryKindRoutingEnabled: 'true' }, { ekkoMemoryRerankEnabled: 1 }, { ekkoMemoryWriteReviewEnabled: null },
    { ekkoMemoryCandidateLimit: 0 }, { ekkoMemoryCandidateLimit: 51 }, { ekkoMemoryMinConfidence: 0.2 },
    { ekkoMemoryRecallMinConfidence: 0.2 }, { ekkoMemoryRecallMinConfidence: 1.1 }, { ekkoMemoryRecallMinConfidence: '0.5' },
    { ekkoMemoryRelevanceFilterEnabled: 'true' }, { ekkoMemoryFilterMinConfidence: 0.4 }, { ekkoMemoryFilterMinConfidence: 1.1 }, { ekkoMemoryFilterMinConfidence: '0.8' },
    { ekkoMemoryMinConfidence: '0.9' }, { ekkoMemoryTimeoutMs: 99 }, { ekkoMemoryTimeoutMs: 30001 },
    { ekkoSkillsEnabled: 'false' }, { ekkoSkillsEnabled: null }, { ekkoSkillsCandidateLimit: 0 }, { ekkoSkillsCandidateLimit: 51 },
    { ekkoSkillsMinConfidence: 0.4 }, { ekkoSkillsMinConfidence: 1.1 }, { ekkoSkillsMinConfidence: '0.8' },
    { ekkoSkillsTimeoutMs: 99 }, { ekkoSkillsTimeoutMs: 30001 },
    { ekkoMemoryEnabled: 'false' }, { ekkoMemoryEnabled: 1 }, { ekkoMemoryEnabled: null },
  ])('rejects invalid settings without changing saved data: %j', async input => {
    await saveJevSettings('research', { apiKey: 'key' })
    await expect(saveJevSettings('research', input)).rejects.toMatchObject({ status: 400 })
    expect((await readJevCredentials('research')).apiKey).toBe('key')
  })
})

describe('shared JEV client', () => {
  it('batches all three primitives with selected profile credentials and preserves results', async () => {
    await saveJevSettings('default', { apiKey: 'default-key' })
    await saveJevSettings('research', { apiKey: 'research-key', model: 'jev-research', baseUrl: 'https://jev.example.test/' })
    const result = await evaluateJev('research', { state: { message: 'billing issue' }, questions })
    expect(result).toEqual(response)
    expect(upstream).toHaveBeenCalledTimes(1)
    const [url, init] = upstream.mock.calls[0]
    expect(url).toBe('https://jev.example.test/v1/systemone')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer research-key')
    expect(init?.redirect).toBe('error')
    expect(JSON.parse(init!.body as string)).toEqual({ state: { message: 'billing issue' }, questions, model: 'jev-research' })
  })

  it('does not fall back to another profile or the process environment', async () => {
    await saveJevSettings('default', { apiKey: 'default-key' })
    vi.stubEnv('TYPESAFE_API_KEY', 'environment-key')
    try { await expect(evaluateJev('research', { state: null, questions })).rejects.toMatchObject({ status: 409, code: 'jev_not_configured' }) }
    finally { vi.unstubAllEnvs() }
    expect(upstream).not.toHaveBeenCalled()
  })

  it('picks up edited settings on the next call and respects a model override', async () => {
    await saveJevSettings('research', { apiKey: 'old-key' })
    await evaluateJev('research', { state: '', questions })
    await saveJevSettings('research', { apiKey: 'new-key' })
    await evaluateJev('research', { state: '', questions, model: 'jev-override' })
    const [, init] = upstream.mock.calls[1]
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer new-key')
    expect(JSON.parse(init!.body as string).model).toBe('jev-override')
  })

  it.each([401, 403, 429, 500])('sanitizes provider HTTP %i errors without retries', async status => {
    await saveJevSettings('research', { apiKey: 'private-key' })
    upstream.mockResolvedValue(Response.json({ error: 'private-key and private-state' }, { status }))
    const code = [401, 403].includes(status) ? 'jev_auth_failed' : status === 429 ? 'jev_rate_limited' : 'jev_provider_error'
    await expect(evaluateJev('research', { state: 'private-state', questions })).rejects.toMatchObject({ status: 502, code, message: `JEV provider returned HTTP ${status}` })
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('honors cancellation', async () => {
    await saveJevSettings('research', { apiKey: 'key' })
    const controller = new AbortController()
    controller.abort()
    await expect(evaluateJev('research', { state: null, questions }, { signal: controller.signal })).rejects.toMatchObject({ status: 499, code: 'jev_cancelled' })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('aborts an upstream request at the configured timeout', async () => {
    await saveJevSettings('research', { apiKey: 'key', timeoutMs: 1000 })
    upstream.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    await expect(evaluateJev('research', { state: null, questions })).rejects.toMatchObject({ status: 504, code: 'jev_timeout' })
  })

  it.each([{}, { state: '', questions: {} }, { state: true, questions },
    { state: '', questions: { bad: { type: 'unknown' } } },
    { state: '', questions: { bad: { type: 'choice', criteria: [] } } },
    { state: '', questions: { bad: { type: 'score', criteria: ['only one'] } } },
  ])('rejects invalid evaluations before contacting the provider: %j', async input => {
    await expect(evaluateJev('research', input as any)).rejects.toMatchObject({ status: 400 })
    expect(upstream).not.toHaveBeenCalled()
  })
})

describe('JEV controllers', () => {
  it('uses the authorized middleware profile rather than an untrusted body profile', async () => {
    const ctx = { state: { profile: { name: 'research' } }, request: { body: { apiKey: 'key' } } } as any
    await saveSettings(ctx)
    expect(ctx.body.hasApiKey).toBe(true)
    expect((await getJevSettings('default')).hasApiKey).toBe(false)
    ctx.request.body = { state: 'hello', questions, profile: 'default' }
    await evaluate(ctx)
    expect(ctx.body).toEqual(response)
    expect(new Headers(upstream.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer key')
  })

  it('requires the middleware profile and never defaults to global/default', async () => {
    const ctx = { state: {}, request: { body: {} } } as any
    await getSettings(ctx)
    expect(ctx.status).toBe(400)
    expect(ctx.body.code).toBe('jev_invalid_request')
    expect(upstream).not.toHaveBeenCalled()
  })

  it('returns stable error codes for client-side translation', async () => {
    const ctx = { state: { profile: { name: 'research' } }, request: { body: { state: null, questions } } } as any
    await evaluate(ctx)
    expect(ctx.body.code).toBe('jev_not_configured')
    await saveJevSettings('research', { apiKey: 'key' })
    upstream.mockResolvedValue(Response.json({ error: 'private provider detail' }, { status: 401 }))
    await evaluate(ctx)
    expect(ctx.status).toBe(502)
    expect(ctx.body).toEqual({ code: 'jev_auth_failed', error: 'JEV provider returned HTTP 401' })
    ctx.request.body = { timeoutMs: 0 }
    await saveSettings(ctx)
    expect(ctx.status).toBe(400)
    expect(ctx.body.code).toBe('jev_invalid_request')
  })
})
