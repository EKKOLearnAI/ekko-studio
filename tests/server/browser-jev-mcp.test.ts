import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error MCP transport helpers are plain Node modules.
import { browserIntent, matchBrowserSnapshot, verifyBrowserResult } from '../../bin/browser/jev.mjs'

const snapshot = { tabId: 'tab', snapshotId: 'snapshot', title: 'Done', text: 'private', url: 'https://example.com/?token=secret',
  nodes: [{ ref: '@e1', role: 'button', name: 'Next', value: 'secret', description: 'private' }] }
const envelope = { operation_id: 'op', result: snapshot }
const enabled = { browserMatchEnabled: true, browserVerifyEnabled: true, hasApiKey: true, browserMatchTimeoutMs: 100, browserVerifyTimeoutMs: 100 }

describe('browser MCP JEV orchestration', () => {
  it.each([[401, 'auth_required'], [403, 'access_denied'], [429, 'rate_limited']])('diagnoses HTTP %s without exposing the response body', async (status, reason) => {
    const request = vi.fn().mockRejectedValue(Object.assign(new Error('private credential/body'), { status }))
    const result = await matchBrowserSnapshot(request, envelope, 'Next')
    expect(result.result.elementMatch).toEqual({ status: 'unavailable', reason, stage: 'settings', httpStatus: status })
    expect(JSON.stringify(result)).not.toContain('private credential')
  })
  it('leaves legacy calls unchanged without settings requests or extra snapshots', async () => {
    const request = vi.fn(), read = vi.fn()
    expect(await matchBrowserSnapshot(request, envelope)).toBe(envelope)
    expect(await verifyBrowserResult(request, envelope, undefined, read)).toBe(envelope)
    expect(request).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it.each([{ ...enabled, browserMatchEnabled: false, browserVerifyEnabled: false }, { ...enabled, hasApiKey: false }])('skips disabled/unconfigured assessments without extra snapshots', async config => {
    const request = vi.fn().mockResolvedValue(config), read = vi.fn()
    expect((await matchBrowserSnapshot(request, envelope, 'next')).result.elementMatch.status).toBe('skipped')
    expect((await verifyBrowserResult(request, envelope, 'done', read)).result.verification.status).toBe('skipped')
    expect(request.mock.calls.every(([path]) => path === '/api/studio/jev/settings')).toBe(true)
    expect(read).not.toHaveBeenCalled()
  })

  it('sends only visible labels under the configured transport Profile and keeps original refs', async () => {
    const request = vi.fn().mockResolvedValueOnce(enabled).mockResolvedValueOnce({ tabId: 'tab', snapshotId: 'snapshot', status: 'matched', ref: '@e1' })
    const result = await matchBrowserSnapshot(request, envelope, 'next')
    expect(result.result).toMatchObject({ ...snapshot, elementMatch: { ref: '@e1', status: 'matched' } })
    const [path, options] = request.mock.calls[1]
    expect(path).toBe('/api/studio/jev/browser/match')
    expect(options).not.toHaveProperty('profile')
    expect(options).not.toHaveProperty('token')
    expect(JSON.stringify(options.body)).not.toMatch(/secret|private|https:/)
  })

  it.each([{ tabId: 'other', snapshotId: 'snapshot', status: 'matched', ref: '@e1' },
    { tabId: 'tab', snapshotId: 'old', status: 'matched', ref: '@e1' },
    { tabId: 'tab', snapshotId: 'snapshot', status: 'matched', ref: '@e999' }])('declines mismatched or fabricated assessments', async assessment => {
    const request = vi.fn().mockResolvedValueOnce(enabled).mockResolvedValueOnce(assessment)
    expect((await matchBrowserSnapshot(request, envelope, 'next')).result.elementMatch).toMatchObject({ status: 'unavailable', reason: 'invalid_result', stage: 'assessment' })
  })

  it('reuses the completed batch snapshot and never changes completion or retries on a negative judgment', async () => {
    const read = vi.fn()
    const executed = { operation_id: 'op', result: { total: 2, completed: 2, results: ['completed', 'completed'], snapshot } }
    const request = vi.fn().mockResolvedValueOnce(enabled).mockResolvedValueOnce({ tabId: 'tab', snapshotId: 'snapshot', status: 'not_met' })
    expect(await verifyBrowserResult(request, executed, 'done', read)).toEqual({ ...executed, result: { ...executed.result,
      verification: { tabId: 'tab', snapshotId: 'snapshot', status: 'not_met' } } })
    expect(read).not.toHaveBeenCalled()
  })

  it('returns the new snapshot alongside single-action verification', async () => {
    const read = vi.fn().mockResolvedValue(envelope)
    const request = vi.fn().mockResolvedValueOnce(enabled).mockResolvedValueOnce({ tabId: 'tab', snapshotId: 'snapshot', status: 'met' })
    const result = await verifyBrowserResult(request, { result: { id: 'tab' } }, 'done', read)
    expect(result.result).toMatchObject({ id: 'tab', snapshot, verification: { status: 'met' } })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it.each([{ total: 2, completed: 1, snapshot }, { total: 2, completed: 2, snapshotError: 'takeover' }])('does not reacquire or assess a failed batch', async result => {
    const request = vi.fn().mockResolvedValue(enabled), read = vi.fn()
    const output = await verifyBrowserResult(request, { result }, 'done', read)
    expect(output.result).toMatchObject(result)
    expect(output.result.verification.status).not.toBe('met')
    expect(request).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()
  })

  it('preserves completed execution when settings, snapshot or provider requests fail', async () => {
    for (const stage of ['settings', 'snapshot', 'provider']) {
      const request = vi.fn().mockRejectedValue(new Error('private'))
      if (stage !== 'settings') request.mockResolvedValueOnce(enabled)
      const read = stage === 'snapshot' ? vi.fn().mockRejectedValue(new Error('private')) : vi.fn().mockResolvedValue(envelope)
      const result = await verifyBrowserResult(request, { result: { id: 'tab', completed: 1 } }, 'done', read)
      expect(result.result).toMatchObject({ id: 'tab', completed: 1, verification: { status: 'unavailable' } })
      expect(JSON.stringify(result)).not.toContain('Error')
    }
  })

  it('propagates cancellation rather than disguising it as a fallback', async () => {
    const abort = new AbortController()
    const request = vi.fn().mockImplementation(async () => { abort.abort(); throw new Error('aborted') })
    await expect(matchBrowserSnapshot(request, envelope, 'next', abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const read = vi.fn()
    await expect(verifyBrowserResult(request, envelope, 'done', read, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).not.toHaveBeenCalled()
  })

  it('validates intent before callers dispatch an action', () => {
    for (const input of ['', ' ', 42, 'a'.repeat(2001)]) expect(() => browserIntent(input, 'expectation')).toThrow()
    expect(browserIntent(' done ', 'expectation')).toBe('done')
    expect(browserIntent(undefined, 'expectation')).toBeUndefined()
  })
})
