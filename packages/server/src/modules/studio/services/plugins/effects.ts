import type { Dispose } from '../../contracts/plugins'
import { PluginError } from './errors'

/** One owner for every registration and async resource, including failed startup. */
export class PluginEffects {
  readonly controller = new AbortController()
  private disposers: Dispose[] = []
  private pending = new Set<Promise<unknown>>()
  private closing?: Promise<void>
  assertActive = () => { if (this.controller.signal.aborted) throw new PluginError('Plugin context has expired', 'PLUGIN_EXPIRED', 409) }
  add(dispose: Dispose): Dispose {
    this.assertActive()
    let active = true
    const once = async () => { if (!active) return; active = false; await dispose() }
    this.disposers.push(once)
    return once
  }
  async acquire(acquire: () => Dispose | Promise<Dispose>): Promise<Dispose> {
    this.assertActive()
    const promise = Promise.resolve().then(acquire).then(async dispose => {
      if (this.controller.signal.aborted) { await dispose(); this.assertActive() }
      return this.add(dispose)
    })
    this.pending.add(promise)
    try {
      return await promise
    } finally { this.pending.delete(promise) }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.controller.abort()
    return this.closing = (async () => {
      await Promise.allSettled([...this.pending])
      const errors: unknown[] = []
      for (const dispose of this.disposers.reverse()) { try { await dispose() } catch (e) { errors.push(e) } }
      this.disposers = []
      if (errors.length) throw new AggregateError(errors, 'Plugin cleanup failed')
    })()
  }
}
