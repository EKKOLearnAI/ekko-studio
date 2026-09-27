import { EventEmitter } from 'node:events'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../../packages/server/src/modules/studio/public/config'
import { saveJevSettings } from '../../packages/server/src/modules/studio/services/jev/settings'
import { matchBrowserElement, verifyBrowserOutcome } from '../../packages/server/src/modules/studio/services/browser/jev'
import { matchBrowser, verifyBrowser } from '../../packages/server/src/modules/studio/controllers/jev'

const snapshot = { tabId: 'tab', snapshotId: 'snapshot', title: 'Checkout', url: 'https://example.com/?token=secret',
  text: 'raw secret', nodes: [
    { ref: '@e1', role: 'RootWebArea', name: 'Checkout' },
    { ref: '@e2', role: 'button', name: 'Buy', disabled: true },
    { ref: '@e3', role: 'button', name: 'Continue', value: 'input-secret', description: 'secret-description' },
    { ref: '@e4', role: 'button', name: 'Cancel' },
  ] }
const input = { snapshot, target: 'Continue', expectation: 'Checkout confirmed' }
const upstream = vi.fn<typeof fetch>()
const reply = (choice: string, confidence = 0.95) => Response.json({ model: 'jev-test', usage: {},
  answers: { decision: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } } } })

beforeEach(async () => {
  await rm(join(config.appHome, 'models', 'jev'), { recursive: true, force: true })
  upstream.mockReset().mockImplementation(async () => reply('candidate_0'))
  vi.stubGlobal('fetch', upstream)
})
afterEach(() => vi.unstubAllGlobals())

describe('optional browser JEV assessments', () => {
  it.each([
    ['match', matchBrowserElement, 'browserMatchEnabled', 'candidate_0', 'matched'],
    ['verify', verifyBrowserOutcome, 'browserVerifyEnabled', 'met', 'met'],
  ] as const)('%s uses its own saved switch, Profile and off/on/off boundary', async (_, assess, enabledKey, decision, status) => {
    await saveJevSettings('work', { apiKey: 'work-key', ekkoMemoryEnabled: true, ekkoSkillsEnabled: true })
    expect(await assess('work', input)).toMatchObject({ status: 'skipped', reason: 'disabled' })
    expect(upstream).not.toHaveBeenCalled()
    await saveJevSettings('work', { [enabledKey]: true })
    upstream.mockImplementation(async () => reply(decision))
    expect(await assess('work', input)).toMatchObject({ status, tabId: 'tab', snapshotId: 'snapshot' })
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(await assess('other', input)).toMatchObject({ status: 'skipped', reason: 'disabled' })
    await saveJevSettings('work', { [enabledKey]: false })
    expect(await assess('work', input)).toMatchObject({ status: 'skipped', reason: 'disabled' })
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it.each([matchBrowserElement, verifyBrowserOutcome])('never calls upstream without credentials', async assess => {
    await saveJevSettings('work', { browserMatchEnabled: true, browserVerifyEnabled: true })
    expect(await assess('work', input)).toMatchObject({ status: 'skipped', reason: 'not_configured' })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('limits eligible candidates, binds real refs and strips input values and unrelated data', async () => {
    await saveJevSettings('work', { apiKey: 'key', browserMatchEnabled: true, browserMatchCandidateLimit: 1 })
    expect(await matchBrowserElement('work', input)).toMatchObject({ status: 'matched', ref: '@e3', considered: 1 })
    const body = JSON.parse(String(upstream.mock.calls[0][1]?.body))
    expect(body.state.nodes).toEqual([{ ref: '@e3', role: 'button', name: 'Continue' }])
    expect(Object.keys(body.questions.decision.criteria)).toEqual(['none', 'candidate_0'])
    expect(JSON.stringify(body)).not.toMatch(/secret|https:|@e2|@e4/)
    expect(await verifyBrowserOutcome('work', input)).toMatchObject({ reason: 'disabled' })
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('declines absent or uncertain targets and accepts a newly saved confidence threshold', async () => {
    await saveJevSettings('work', { apiKey: 'key', browserMatchEnabled: true, browserMatchMinConfidence: 0.95 })
    upstream.mockImplementation(async () => reply('candidate_0', 0.9))
    expect(await matchBrowserElement('work', input)).toMatchObject({ status: 'unavailable', reason: 'low_confidence' })
    await saveJevSettings('work', { browserMatchMinConfidence: 0.85 })
    expect(await matchBrowserElement('work', input)).toMatchObject({ status: 'matched' })
    upstream.mockImplementation(async () => reply('none'))
    expect(await matchBrowserElement('work', input)).toMatchObject({ status: 'no_match' })
    upstream.mockClear()
    expect(await matchBrowserElement('work', { ...input, snapshot: { ...snapshot, nodes: [] } })).toMatchObject({ status: 'no_match' })
    expect(upstream).not.toHaveBeenCalled()
  })

  it.each(['met', 'not_met', 'unknown'])('reports outcome %s without inventing execution status', async decision => {
    await saveJevSettings('work', { apiKey: 'key', browserVerifyEnabled: true })
    upstream.mockImplementation(async () => reply(decision))
    expect(await verifyBrowserOutcome('work', input)).toMatchObject({ status: decision, confidence: 0.95 })
    expect(JSON.stringify(upstream.mock.calls[0][1]?.body)).not.toMatch(/input-secret|secret-description|raw secret|https:/)
  })

  it.each([matchBrowserElement, verifyBrowserOutcome])('falls back on provider, malformed and low-confidence responses', async assess => {
    await saveJevSettings('work', { apiKey: 'key', browserMatchEnabled: true, browserVerifyEnabled: true })
    upstream.mockRejectedValueOnce(new Error('private provider body'))
    expect(await assess('work', input)).toMatchObject({ status: 'unavailable', reason: 'provider_unavailable' })
    upstream.mockResolvedValueOnce(reply('invented_ref'))
    expect(await assess('work', input)).toMatchObject({ status: 'unavailable' })
    upstream.mockResolvedValueOnce(reply(assess === matchBrowserElement ? 'candidate_0' : 'met', 0.6))
    expect(await assess('work', input)).toMatchObject({ status: 'unavailable', reason: 'low_confidence' })
    upstream.mockResolvedValueOnce(Response.json({ answers: {} }))
    expect(await assess('work', input)).toMatchObject({ status: 'unavailable' })
  })

  it.each([matchBrowserElement, verifyBrowserOutcome])('bounds non-cooperative upstream calls and propagates cancellation', async assess => {
    await saveJevSettings('work', { apiKey: 'key', browserMatchEnabled: true, browserVerifyEnabled: true,
      browserMatchTimeoutMs: 100, browserVerifyTimeoutMs: 100 })
    upstream.mockImplementation(() => new Promise(() => {}))
    expect(await assess('work', input)).toMatchObject({ status: 'unavailable', reason: 'timeout' })
    expect(upstream.mock.calls[0][1]?.signal?.aborted).toBe(true)
    const abort = new AbortController()
    const pending = assess('work', input, abort.signal)
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(2))
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: 'jev_cancelled' })
  })

  it('rejects invalid snapshots and intent before evaluation', async () => {
    for (const invalid of [{ ...input, target: '' }, { ...input, snapshot: { ...snapshot, nodes: [{ ref: '@e1' }] } },
      { ...input, snapshot: { ...snapshot, nodes: [snapshot.nodes[0], snapshot.nodes[0]] } }]) {
      await expect(matchBrowserElement('work', invalid)).rejects.toMatchObject({ code: 'jev_invalid_request' })
    }
    expect(upstream).not.toHaveBeenCalled()
  })

  it.each([matchBrowser, verifyBrowser])('uses only the controller-authorized Profile and cancels on disconnect', async controller => {
    await saveJevSettings('work', { apiKey: 'key', browserMatchEnabled: true, browserVerifyEnabled: true })
    const res = Object.assign(new EventEmitter(), { writableEnded: false })
    const ctx = { state: { profile: { name: 'other' } }, request: { body: { ...input, profile: 'work' } }, res } as any
    await controller(ctx)
    expect(ctx.body).toMatchObject({ reason: 'disabled' })
    expect(upstream).not.toHaveBeenCalled()
    upstream.mockImplementation(() => new Promise(() => {}))
    ctx.state.profile.name = 'work'
    const pending = controller(ctx)
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1))
    res.emit('close')
    await pending
    expect(ctx.status).toBe(499)
    expect(ctx.body.code).toBe('jev_cancelled')
    expect(res.listenerCount('close')).toBe(0)
  })
})
