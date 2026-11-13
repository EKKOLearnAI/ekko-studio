/** Split one provider stream into two independently consumed async iterables. */
export function teeAsyncIterable<T>(source: AsyncIterable<T>): [AsyncIterable<T>, AsyncIterable<T>] {
  const iterator = source[Symbol.asyncIterator]()
  const buffers: [T[], T[]] = [[], []]
  const waiters: Array<(() => void)[]> = [[], []]
  let pulling: Promise<void> | null = null
  let done = false
  let error: unknown

  async function pull() {
    if (pulling) return pulling
    pulling = (async () => {
      try {
        const next = await iterator.next()
        if (next.done) {
          done = true
        } else {
          buffers[0].push(next.value)
          buffers[1].push(next.value)
        }
      } catch (err) {
        error = err
        done = true
      } finally {
        pulling = null
        for (const queue of waiters) {
          for (const resolve of queue.splice(0)) resolve()
        }
      }
    })()
    return pulling
  }

  function branch(index: 0 | 1): AsyncIterable<T> {
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (buffers[index].length > 0) {
            yield buffers[index].shift() as T
            continue
          }
          if (error) throw error
          if (done) return
          const waiting = new Promise<void>(resolve => waiters[index].push(resolve))
          void pull()
          await waiting
        }
      },
    }
  }

  return [branch(0), branch(1)]
}
