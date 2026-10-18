import { describe, expect, it, vi } from 'vitest'
import { JevSidecarBudget, JevSidecarDeadlineError } from '../../packages/server/src/modules/studio/services/jev/sidecar-budget'

class FakeClock { value = 0; now = () => this.value }

describe('JEV sidecar budget', () => {
  it('tightens from the original acceptance time instead of resetting elapsed time', () => {
    const clock = new FakeClock()
    const budget = new JevSidecarBudget(1000, new AbortController().signal, clock, 0)
    clock.value = 400
    budget.tighten(500)
    expect(budget.remaining()).toBe(100)
    clock.value = 501
    expect(() => budget.check()).toThrowError(expect.objectContaining({ reason: 'deadline_exceeded' }))
  })

  it('propagates caller cancellation before deadline expiry', () => {
    const controller = new AbortController()
    const budget = new JevSidecarBudget(1000, controller.signal)
    controller.abort()
    expect(() => budget.check()).toThrowError(expect.objectContaining({ reason: 'caller_cancelled' }))
  })

  it('returns logically at deadline while retaining a physical cleanup promise', async () => {
    vi.useFakeTimers()
    try {
      const budget = new JevSidecarBudget(100, new AbortController().signal)
      let settle!: () => void
      const physicalOperation = new Promise<void>(resolve => { settle = resolve })
      const raced = await budget.race(async () => physicalOperation)
      const logicalResult = raced.logical.catch(error => error)
      await vi.advanceTimersByTimeAsync(101)
      expect(await logicalResult).toBeInstanceOf(JevSidecarDeadlineError)
      let physicalDone = false
      void raced.physical.then(() => { physicalDone = true })
      await Promise.resolve()
      expect(physicalDone).toBe(false)
      settle(); await raced.physical
      expect(physicalDone).toBe(true)
    } finally { vi.useRealTimers() }
  })
})
