import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../../packages/server/src/modules/studio/public/config'
import { evaluateJev, choice, score, noul } from '../../packages/server/src/modules/studio/public/jev'
import { getJevSettings, saveJevSettings, deleteJevSettings, readJevCredentials } from '../../packages/server/src/modules/studio/services/jev/settings'
import { getSettings, saveSettings, evaluate } from '../../packages/server/src/modules/studio/controllers/jev'

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
  it('isolates profiles and returns only credential presence', async () => {
    const saved = await saveJevSettings('research', { apiKey: 'private-key', model: 'jev-research' })
    expect(saved).toEqual({ baseUrl: 'https://api.typesafe.ai', model: 'jev-research', timeoutMs: 10000, hasApiKey: true })
    expect(JSON.stringify(await getJevSettings('research'))).not.toContain('private-key')
    expect(await getJevSettings('default')).toMatchObject({ model: 'jev-latest', hasApiKey: false })
    const [file] = await readdir(directory)
    expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
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
    try { await expect(evaluateJev('research', { state: null, questions })).rejects.toMatchObject({ status: 409 }) }
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

  it.each([401, 429, 500])('sanitizes provider HTTP %i errors without retries', async status => {
    await saveJevSettings('research', { apiKey: 'private-key' })
    upstream.mockResolvedValue(Response.json({ error: 'private-key and private-state' }, { status }))
    await expect(evaluateJev('research', { state: 'private-state', questions })).rejects.toMatchObject({ status: 502, message: `JEV provider returned HTTP ${status}` })
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('honors cancellation', async () => {
    await saveJevSettings('research', { apiKey: 'key' })
    const controller = new AbortController()
    controller.abort()
    await expect(evaluateJev('research', { state: null, questions }, { signal: controller.signal })).rejects.toMatchObject({ status: 499 })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('aborts an upstream request at the configured timeout', async () => {
    await saveJevSettings('research', { apiKey: 'key', timeoutMs: 1000 })
    upstream.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    await expect(evaluateJev('research', { state: null, questions })).rejects.toMatchObject({ status: 504 })
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
    expect(upstream).not.toHaveBeenCalled()
  })
})
