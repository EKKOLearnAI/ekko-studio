interface ToolInterval { start?: number; end?: number }

/** Foreground tool wall time: parallel/nested calls occupy the same time only once. */
export class RunToolTiming {
  private readonly intervals = new Map<string, ToolInterval>()
  private incomplete = false
  private result?: { runDurationSeconds: number; toolDurationSeconds?: number }

  constructor(private readonly startedAt: number, private readonly wallStartedAt = Date.now()) {}

  start(id: string, at = performance.now()): void {
    if (this.result) return
    if (!id) { this.incomplete = true; return }
    if (!this.intervals.has(id)) this.intervals.set(id, { start: at })
  }

  end(id: string, at = performance.now()): void {
    if (this.result) return
    if (!id) { this.incomplete = true; return }
    const interval = this.intervals.get(id) || {}
    if (interval.end == null) interval.end = at
    this.intervals.set(id, interval)
  }

  /** OpenCode reports completed tools with their native millisecond timestamps. */
  recordWallInterval(id: string, start: unknown, end: unknown): void {
    if (this.result || this.intervals.has(id)) return
    if (!id || typeof start !== 'number' || typeof end !== 'number'
      || !Number.isFinite(start) || !Number.isFinite(end)
      || start < this.wallStartedAt || end < start || end > Date.now()) {
      this.incomplete = true
      return
    }
    this.intervals.set(id, {
      start: this.startedAt + start - this.wallStartedAt,
      end: this.startedAt + end - this.wallStartedAt,
    })
  }

  finish(endedAt = performance.now()): { runDurationSeconds: number; toolDurationSeconds?: number } {
    if (this.result) return this.result
    const runDurationSeconds = Math.max(0, endedAt - this.startedAt) / 1000
    const ranges: Array<[number, number]> = []
    for (const { start, end } of this.intervals.values()) {
      // Never count an unmatched start through completion: a lost end event
      // could otherwise subtract later model requests and inflate the speed.
      if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        this.incomplete = true
        continue
      }
      const from = Math.max(this.startedAt, start)
      const to = Math.min(endedAt, end)
      if (to > from) ranges.push([from, to])
    }
    ranges.sort((a, b) => a[0] - b[0])
    let toolMilliseconds = 0
    let coveredUntil = this.startedAt
    for (const [start, end] of ranges) {
      toolMilliseconds += Math.max(0, end - Math.max(start, coveredUntil))
      coveredUntil = Math.max(coveredUntil, end)
    }
    return this.result = {
      runDurationSeconds,
      ...(this.incomplete ? {} : { toolDurationSeconds: toolMilliseconds / 1000 }),
    }
  }
}
