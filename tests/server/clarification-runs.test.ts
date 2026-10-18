import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClarificationRuns, CLARIFICATION_TIMEOUT_MS } from '../../packages/server/src/modules/studio/services/clarification-runs'

function harness() {
  const publish = vi.fn()
  const state = { isWorking: true, isAborting: false, activeRunMarker: 'turn-1' }
  const runs = new ClarificationRuns(publish)
  runs.begin('context-1', 'session-1', 'research', () => state)
  const request = (input = { question: 'Which folder?', choices: ['client', 'server'] }, signal?: AbortSignal) => runs.request('context-1', 'research', input, signal)
  const id = () => publish.mock.calls.filter(call => call[1] === 'clarify.requested').at(-1)![2].clarify_id as string
  return { runs, publish, state, request, id }
}

afterEach(() => vi.useRealTimers())
describe('MCP clarification turns', () => {
  it.each(['client', 'a custom folder', ''])('waits for a choice, free text, or dismissal: %s', async response => {
    const { request, publish, runs, id } = harness()
    const result = request()
    expect(publish).toHaveBeenCalledWith('session-1', 'clarify.requested', expect.objectContaining({
      run_id: 'turn-1', question: 'Which folder?', choices: ['client', 'server'], timeout_ms: 300_000,
    }))
    expect(runs.respond('session-1', id(), response)).toEqual({ handled: true, resolved: true })
    await expect(result).resolves.toEqual({ clarify_id: id(), response, reason: response ? 'response' : 'dismissed' })
    expect(runs.respond('session-1', id(), 'duplicate').handled).toBe(false)
  })

  it('rejects another profile/session, unknown context, and a second pending request', async () => {
    const { request, runs, id } = harness()
    expect(() => runs.request('context-1', 'other', { question: 'Q' })).toThrow('expired')
    expect(() => runs.request('old-context', 'research', { question: 'Q' })).toThrow('expired')
    const result = request()
    expect(runs.respond('other-session', id(), 'wrong')).toEqual({ handled: true, resolved: false })
    expect(() => request()).toThrow('already pending')
    runs.respond('session-1', id(), 'correct')
    await expect(result).resolves.toMatchObject({ response: 'correct' })
  })

  it.each([{ question: '' }, { question: 'x'.repeat(4001) }, { question: 'Q', choices: [123] },
    { question: 'Q', choices: [' '] }, { question: 'Q', choices: ['x'.repeat(501)] },
    { question: 'Q', choices: Array(21).fill('a') }])('validates input before displaying a prompt: %j', input => {
    const { runs, publish } = harness()
    expect(() => runs.request('context-1', 'research', input)).toThrow()
    expect(publish).not.toHaveBeenCalled()
  })

  it('times out without manufacturing an answer and allows a later question', async () => {
    vi.useFakeTimers()
    const { request, runs, id } = harness()
    const result = request()
    await vi.advanceTimersByTimeAsync(CLARIFICATION_TIMEOUT_MS)
    await expect(result).resolves.toMatchObject({ response: '', reason: 'timeout' })
    expect(runs.respond('session-1', id(), 'late').handled).toBe(false)
    const next = request()
    runs.finishSession('session-1')
    await expect(next).resolves.toMatchObject({ reason: 'cancelled' })
  })

  it('cancels old turns, preserving a new turn against a late finish callback', async () => {
    const { runs, request, state } = harness()
    const result = request()
    state.activeRunMarker = 'turn-2'
    runs.begin('context-2', 'session-1', 'research', () => state)
    await expect(result).resolves.toMatchObject({ reason: 'cancelled' })
    expect(() => request()).toThrow('expired')
    const next = runs.request('context-2', 'research', { question: 'New question' })
    runs.finishSession('session-1', 'context-1')
    runs.finishSession('session-1', 'context-2')
    await expect(next).resolves.toMatchObject({ reason: 'cancelled' })
  })

  it('cancels on transport disconnect and rejects answers after abort or run replacement', async () => {
    const { request, runs, state, id } = harness()
    const abort = new AbortController()
    const result = request(undefined, abort.signal)
    abort.abort()
    await expect(result).resolves.toMatchObject({ reason: 'cancelled' })
    const next = request()
    state.isAborting = true
    expect(() => request()).toThrow('active turn')
    expect(runs.respond('session-1', id(), 'late')).toEqual({ handled: true, resolved: false })
    await expect(next).resolves.toMatchObject({ reason: 'cancelled', response: '' })
    state.isAborting = false
    state.activeRunMarker = 'changed'
    expect(() => request()).toThrow('active turn')
  })
})
