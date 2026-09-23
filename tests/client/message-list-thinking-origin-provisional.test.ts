import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * MessageList is not mounted here (it drags in the whole chat surface), so this
 * file does two things:
 *
 *  1. a behavioural model of the timer watcher, mirroring the shipped logic;
 *  2. source assertions that the model still matches the component.
 *
 * (2) is what keeps (1) honest: if the component changes shape, the assertions
 * fail and the model gets updated instead of silently drifting.
 */
const source = readFileSync('packages/client/src/components/hermes/chat/MessageList.vue', 'utf8')

function timerWatchBody(): string {
  const start = source.indexOf('// Switching between two sessions that are both already working')
  const end = source.indexOf('{ immediate: true },', start)
  if (start < 0 || end < 0) throw new Error('timer watcher not found in MessageList.vue')
  return source.slice(start, end)
}

/** Behavioural model of the shipped watcher callback. */
function createTimerModel() {
  const provisionalThinkingOrigins = new Map<string, number>()
  let thinkingStartedAt = 0
  let thinkingElapsedMs = 0

  function run(
    visible: boolean,
    store: { activeSessionId: string | null; runStartedAt: Map<string, number> },
    now: number,
  ) {
    if (!visible) {
      thinkingStartedAt = 0
      thinkingElapsedMs = 0
      return { origin: 0, elapsed: 0 }
    }
    const sid = store.activeSessionId
    const reportedStart = sid ? store.runStartedAt.get(sid) || 0 : 0
    if (reportedStart > 0) {
      if (sid) provisionalThinkingOrigins.delete(sid)
      thinkingStartedAt = reportedStart
    } else if (sid && provisionalThinkingOrigins.has(sid)) {
      thinkingStartedAt = provisionalThinkingOrigins.get(sid)!
    } else {
      thinkingStartedAt = now
      if (sid) provisionalThinkingOrigins.set(sid, thinkingStartedAt)
    }
    thinkingElapsedMs = Math.max(0, now - thinkingStartedAt)
    return { origin: thinkingStartedAt, elapsed: thinkingElapsedMs }
  }

  return { run, provisionalThinkingOrigins }
}

const RUN_START = 1_787_000_000_000

describe('thinking timer survives a switch into a working session', () => {
  it('reuses the provisional origin while the resume payload is still in flight', () => {
    const timer = createTimerModel()
    const store = { activeSessionId: 'a', runStartedAt: new Map<string, number>() }

    const first = timer.run(true, store, RUN_START)
    expect(first.origin).toBe(RUN_START)

    // Payload still not landed: the origin must stay put, not restart at now.
    const second = timer.run(true, store, RUN_START + 5_000)
    expect(second.origin).toBe(RUN_START)
    expect(second.elapsed).toBe(5_000)
  })

  it('prefers the server-reported start once it arrives and forgets the provisional value', () => {
    const timer = createTimerModel()
    const store = {
      activeSessionId: 'a',
      runStartedAt: new Map<string, number>([['a', RUN_START]]),
    }
    timer.provisionalThinkingOrigins.set('a', RUN_START + 1_000)

    const run = timer.run(true, store, RUN_START + 9_000)
    expect(run.origin).toBe(RUN_START)
    expect(run.elapsed).toBe(9_000)
    expect(timer.provisionalThinkingOrigins.has('a')).toBe(false)
  })

  it('clears the elapsed time when the run indicator goes away', () => {
    const timer = createTimerModel()
    const store = { activeSessionId: 'a', runStartedAt: new Map<string, number>() }
    const run = timer.run(false, store, RUN_START)
    expect(run.origin).toBe(0)
    expect(run.elapsed).toBe(0)
  })
})

describe('the model still matches MessageList.vue', () => {
  it('keeps a per-session provisional origin map', () => {
    expect(source).toContain('const provisionalThinkingOrigins = new Map<string, number>()')
  })

  it('prefers the reported start, reuses the provisional one, records it otherwise', () => {
    const body = timerWatchBody()
    expect(body).toContain('const reportedStart = sid ? chatStore.runStartedAt.get(sid) || 0 : 0')
    expect(body).toContain('if (reportedStart > 0) {')
    expect(body).toContain('provisionalThinkingOrigins.delete(sid)')
    expect(body).toContain('thinkingStartedAt = reportedStart')
    expect(body).toContain('else if (sid && provisionalThinkingOrigins.has(sid)) {')
    expect(body).toContain('thinkingStartedAt = provisionalThinkingOrigins.get(sid)!')
    expect(body).toContain('provisionalThinkingOrigins.set(sid, thinkingStartedAt)')
  })

  it('still clears the display when the run indicator goes away', () => {
    const body = timerWatchBody()
    expect(body).toContain('if (!visible) {')
    expect(body).toContain('thinkingStartedAt = 0')
    expect(body).toContain('thinkingElapsedMs.value = 0')
  })
})
