import type { JevSidecarReason } from './sidecar-contract'

export interface MonotonicClock { now(): number }
export const systemMonotonicClock: MonotonicClock = { now: () => performance.now() }

export class JevSidecarDeadlineError extends Error {
  constructor(readonly reason: Extract<JevSidecarReason, 'deadline_exceeded' | 'caller_cancelled'>) {
    super(reason)
    this.name = 'JevSidecarDeadlineError'
  }
}

export class JevSidecarBudget {
  readonly acceptedAt: number
  private deadline: number
  constructor(
    budgetMs: number,
    private readonly signal: AbortSignal,
    private readonly clock: MonotonicClock = systemMonotonicClock,
    acceptedAt?: number,
  ) {
    this.acceptedAt = acceptedAt ?? clock.now()
    this.deadline = this.acceptedAt + Math.max(0, budgetMs)
  }
  tighten(budgetMs: number): void { this.deadline = Math.min(this.deadline, this.acceptedAt + Math.max(0, budgetMs)) }
  remaining(): number { return Math.max(0, this.deadline - this.clock.now()) }
  check(): void {
    if (this.signal.aborted) throw new JevSidecarDeadlineError('caller_cancelled')
    if (this.remaining() <= 0) throw new JevSidecarDeadlineError('deadline_exceeded')
  }
  async race<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<{ logical: Promise<T>; physical: Promise<void>; controller: AbortController }> {
    this.check()
    const controller = new AbortController()
    const combined = AbortSignal.any([this.signal, controller.signal])
    const physicalResult = Promise.resolve().then(() => operation(combined))
    const physical = physicalResult.then(() => undefined, () => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    const logical = Promise.race([
      physicalResult,
      new Promise<never>((_, reject) => {
        const fail = (reason: 'caller_cancelled' | 'deadline_exceeded') => {
          controller.abort()
          reject(new JevSidecarDeadlineError(reason))
        }
        abortListener = () => fail('caller_cancelled')
        this.signal.addEventListener('abort', abortListener, { once: true })
        timer = setTimeout(() => fail('deadline_exceeded'), Math.max(1, this.remaining()))
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
      if (abortListener) this.signal.removeEventListener('abort', abortListener)
    })
    return { logical, physical, controller }
  }
}
