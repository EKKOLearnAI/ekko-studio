import { openPersonContextStore } from '../../repositories/person-context-store'

const pending = new Map<string, ReturnType<typeof openPersonContextStore>>()
let timer: ReturnType<typeof setTimeout> | undefined

/** Backfill existing months of history in bounded transactions, yielding between batches. */
export function queuePersonContextIndex(userId: number, sessionId: string) {
  pending.set(sessionId, openPersonContextStore(userId, sessionId))
  if (timer) return
  const tick = () => {
    timer = undefined
    const next = pending.entries().next().value
    if (!next) return
    const [id, store] = next
    pending.delete(id)
    try {
      const progress = store.sync()
      if (!progress.complete && !progress.blocked) pending.set(id, store)
    }
    catch { /* Session deletion/revision change cancels this snapshot; the next read can restart. */ }
    if (pending.size) { timer = setTimeout(tick, 25); timer.unref() }
  }
  timer = setTimeout(tick, 25)
  timer.unref()
}
