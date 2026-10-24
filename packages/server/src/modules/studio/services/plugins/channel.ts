import { StudioError } from '../../contracts/plugins'

export class AsyncChannel<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly readers: Array<{ resolve(result: IteratorResult<T>): void; reject(error: unknown): void }> = []
  private readonly writers: Array<{ value: T; resolve(): void; reject(error: unknown): void }> = []
  private ended = false
  private error?: unknown
  constructor(private readonly capacity = 128, private readonly onReturn: () => void = () => {}) {}

  push(value: T): Promise<void> {
    if (this.ended) return Promise.reject(this.error || new StudioError('CANCELLED', 'Stream closed'))
    const reader = this.readers.shift()
    if (reader) { reader.resolve({ done: false, value }); return Promise.resolve() }
    if (this.values.length < this.capacity) { this.values.push(value); return Promise.resolve() }
    return new Promise((resolve, reject) => this.writers.push({ value, resolve, reject }))
  }

  finish(error?: unknown): void {
    if (this.ended) return
    this.ended = true
    this.error = error
    if (error) this.values.length = 0
    for (const reader of this.readers.splice(0)) error ? reader.reject(error) : reader.resolve({ done: true, value: undefined })
    for (const writer of this.writers.splice(0)) writer.reject(error || new StudioError('CANCELLED', 'Stream closed'))
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length) {
          const value = this.values.shift()!
          const writer = this.writers.shift()
          if (writer) { this.values.push(writer.value); writer.resolve() }
          return Promise.resolve({ done: false, value })
        }
        if (this.error) return Promise.reject(this.error)
        if (this.ended) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve, reject) => this.readers.push({ resolve, reject }))
      },
      return: async () => { this.onReturn(); this.finish(); return { done: true, value: undefined } },
    }
  }
}
