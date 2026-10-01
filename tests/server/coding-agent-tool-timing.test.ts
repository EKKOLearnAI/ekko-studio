import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunToolTiming } from '../../packages/server/src/modules/coding-agents/services/runtime/tool-timing'

afterEach(() => vi.restoreAllMocks())

describe('Coding Agent tool time', () => {
  it('subtracts the union of parallel and nested tools, including duplicate events', () => {
    const timing = new RunToolTiming(1000)
    timing.start('a', 3000)
    timing.start('b', 4000)
    timing.start('nested', 4500)
    timing.end('nested', 5000)
    timing.start('a', 5000) // repeated start must not reset the original start
    timing.end('a', 6000)
    timing.end('a', 9000) // repeated completion must not extend the interval
    timing.end('b', 8000)
    timing.start('later', 9000)
    timing.end('later', 10000)
    expect(timing.finish(11000)).toEqual({ runDurationSeconds: 10, toolDurationSeconds: 6 })
    timing.start('too-late', 12000)
    timing.end('too-late', 13000)
    expect(timing.finish(14000)).toEqual({ runDurationSeconds: 10, toolDurationSeconds: 6 })
  })

  it('keeps unknown tool boundaries unknown instead of subtracting model time', () => {
    const startOnly = new RunToolTiming(0)
    startOnly.start('lost-end', 1000)
    expect(startOnly.finish(10000)).toEqual({ runDurationSeconds: 10 })
    const endOnly = new RunToolTiming(0)
    endOnly.end('lost-start', 5000)
    expect(endOnly.finish(10000)).toEqual({ runDurationSeconds: 10 })
  })

  it('keeps a partial set of timings unknown, and resets for a new turn', () => {
    const timing = new RunToolTiming(0)
    timing.start('complete', 1000)
    timing.end('complete', 3000)
    timing.end('unknown', 4000)
    expect(timing.finish(5000)).toEqual({ runDurationSeconds: 5 })
    const next = new RunToolTiming(6000)
    next.start('complete', 7000)
    next.end('complete', 8000)
    expect(next.finish(10000)).toEqual({ runDurationSeconds: 4, toolDurationSeconds: 1 })
  })

  it('uses native wall timestamps even when completions arrive together', () => {
    vi.spyOn(Date, 'now').mockReturnValue(110000)
    const timing = new RunToolTiming(1000, 100000)
    timing.recordWallInterval('a', 102000, 105000)
    timing.recordWallInterval('b', 103000, 107000)
    timing.recordWallInterval('a', 102000, 109000)
    expect(timing.finish(11000)).toEqual({ runDurationSeconds: 10, toolDurationSeconds: 5 })
  })

  it.each([[undefined, undefined], [99000, 101000], [102000, 101000], [102000, 120000], [NaN, 103000]])(
    'rejects absent, stale and invalid native times (%s, %s)', (start, end) => {
      vi.spyOn(Date, 'now').mockReturnValue(110000)
      const timing = new RunToolTiming(1000, 100000)
      timing.recordWallInterval('tool', start, end)
      expect(timing.finish(11000)).toEqual({ runDurationSeconds: 10 })
    },
  )

  it('distinguishes no tools from missing tool data and bounds intervals to the run', () => {
    expect(new RunToolTiming(1000).finish(2000)).toEqual({ runDurationSeconds: 1, toolDurationSeconds: 0 })
    const timing = new RunToolTiming(1000)
    timing.start('tool', 0)
    timing.end('tool', 10000)
    expect(timing.finish(5000)).toEqual({ runDurationSeconds: 4, toolDurationSeconds: 4 })
  })
})
