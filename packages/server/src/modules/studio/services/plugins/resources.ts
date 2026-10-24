import type { Disposer } from '../../contracts/plugins'
import { StudioError } from '../../contracts/plugins'

export class ResourceScope {
  private entries: Disposer[] = []
  private closing?: Promise<void>
  private closed = false
  private readonly controller = new AbortController()
  readonly signal = this.controller.signal

  constructor(private readonly onError: (error: unknown) => void = () => {}) {}

  add(dispose: Disposer): Disposer {
    if (this.closed) throw new StudioError('PLUGIN_UNAVAILABLE', 'Resource scope is closed')
    let result: Promise<void> | undefined
    const once = (): Promise<void> => {
      if (!result) {
        this.entries = this.entries.filter(entry => entry !== once)
        result = Promise.resolve().then(dispose)
      }
      return result
    }
    this.entries.push(once)
    return once
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.controller.abort()
    const entries = this.entries.splice(0).reverse()
    this.closing = (async () => {
      for (const dispose of entries) {
        try { await dispose() } catch (error) { this.onError(error) }
      }
    })()
    return this.closing
  }
}
