import type { CloudModelUsage } from '../model-api/cloud-usage'

export type CloudModelUsageReport = CloudModelUsage & { id: string }
type Pending = { value: CloudModelUsageReport; until: number }

// Small, content-free retries survive socket reconnects. The server row already
// exists before inference; unavailable reports remain unknown rather than zero.
export class CloudModelUsageOutbox {
  private stopped = false
  private pending = new Map<string, Pending>()
  private active = new Set<string>()
  private timer?: ReturnType<typeof setInterval>
  constructor(private send: (value: CloudModelUsageReport, ack: (ok: boolean) => void) => boolean) {}
  report(value: CloudModelUsageReport): void {
    if (this.stopped) return
    if (!this.pending.has(value.id) && this.pending.size >= 256) this.pending.delete(this.pending.keys().next().value!)
    this.pending.set(value.id, { value, until: Date.now() + 3600000 })
    if (!this.timer) { this.timer = setInterval(() => this.flush(), 10000); this.timer.unref() }
    this.flush()
  }
  flush(): void {
    for (const [id, entry] of this.pending) {
      if (entry.until <= Date.now()) { this.pending.delete(id); continue }
      if (this.active.has(id) || this.active.size >= 4) continue
      this.active.add(id)
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = (ok: boolean) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        this.active.delete(id)
        if (ok && this.pending.get(id) === entry) this.pending.delete(id)
      }
      timer = setTimeout(() => done(false), 5000); timer.unref()
      try { if (!this.send(entry.value, done)) done(false) } catch { done(false) }
    }
    if (!this.pending.size && this.timer) { clearInterval(this.timer); this.timer = undefined }
  }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; this.pending.clear() }
}
