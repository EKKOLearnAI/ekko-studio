import { afterEach, expect, it, vi } from 'vitest'
import { PLUGIN_SUBMISSION_URL, submitPlugin, validSubmissionField } from '../../packages/client/src/api/studio/plugin-submissions'

const input = { repository: ' https://github.com/example/plugin ', name: ' Notes ', description: ' Plugin description ' }
const receipt = { submissionId: 'd27d341b-edee-4089-9fb9-e3d5ce07c9e3', pluginId: 'a'.repeat(64), status: 'pending', createTime: 1794400000 }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('sends only the three trimmed fields to the public cloud API without local credentials', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true, data: receipt }, { status: 201 }))
  vi.stubGlobal('fetch', fetch)
  expect(await submitPlugin({ ...input, token: 'must not be sent', status: 'approved' } as typeof input)).toEqual(receipt)
  const [url, options] = fetch.mock.calls[0]!
  expect(url).toBe(PLUGIN_SUBMISSION_URL)
  expect(options).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' })
  expect(options.headers).toEqual({ 'Content-Type': 'application/json', Accept: 'application/json' })
  expect(JSON.parse(options.body)).toEqual({ repository: input.repository.trim(), name: 'Notes', description: 'Plugin description' })
})

it('rejects invalid repository URLs and missing or oversized fields before sending', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  for (const repository of ['', 'ssh://github.com/a/b', 'https://user:pass@github.com/a/b', 'https://github.com/a/b?token=secret', 'https://github.com/a/b#branch', 'https://github.com/', 'https://github.com/.git', 'https://github.com/a b', 'https://github.com/a\\b']) {
    await expect(submitPlugin({ ...input, repository })).rejects.toMatchObject({ kind: 'invalidInput' })
  }
  for (const value of [{ name: ' ' }, { name: 'a'.repeat(161) }, { description: '' }, { description: 'a'.repeat(4001) }, { repository: 'https://example.com/' + 'a'.repeat(2048) }]) {
    await expect(submitPlugin({ ...input, ...value })).rejects.toMatchObject({ kind: 'invalidInput' })
  }
  expect(fetch).not.toHaveBeenCalled()
  expect(validSubmissionField('repository', 'https://gitlab.com/team/subgroup/plugin.git/')).toBe(true)
})

it('reports rate limits and failed responses without retrying', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  for (const [status, kind] of [[429, 'rateLimited'], [400, 'invalidInput'], [500, 'failed']] as const) {
    fetch.mockResolvedValueOnce(Response.json({ ok: false }, { status }))
    await expect(submitPlugin(input)).rejects.toMatchObject({ kind })
  }
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('requires a pending receipt and treats lost or malformed responses as unconfirmed', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  for (const body of [{}, { ok: true }, { ok: true, data: { ...receipt, status: 'approved' } }, { ok: true, data: { ...receipt, pluginId: 'manifest-id' } }]) {
    fetch.mockResolvedValueOnce(Response.json(body))
    await expect(submitPlugin(input)).rejects.toMatchObject({ kind: 'uncertain' })
  }
  fetch.mockRejectedValueOnce(new TypeError('network error'))
  await expect(submitPlugin(input)).rejects.toMatchObject({ kind: 'uncertain' })
  expect(fetch).toHaveBeenCalledTimes(5)
})

it('aborts a timed-out request without retrying or reporting success', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))))
  vi.stubGlobal('fetch', fetch)
  const result = expect(submitPlugin(input)).rejects.toMatchObject({ kind: 'uncertain' })
  await vi.advanceTimersByTimeAsync(30_000); await result
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true)
})
