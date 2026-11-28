type InteractionKind = 'approval' | 'clarify'

// Firmware stops a pending turn after 180 seconds without an event. Keep an
// interactive desktop request alive without answering it or extending the
// transport's existing total run deadline.
const HEARTBEAT_MS = 30_000
const MAX_WAIT_MS = 300_000

export function createMcuHumanInteractionWait(isActive: () => boolean, heartbeat: () => void, timeout: () => void) {
  const pending = new Set<string>()
  let timer: ReturnType<typeof setInterval> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  const key = (kind: InteractionKind, id: unknown) => (
    typeof id === 'string' && id.trim() && id.length <= 512 ? `${kind}:${id}` : null
  )
  const clear = () => {
    if (timer) clearInterval(timer)
    if (deadline) clearTimeout(deadline)
    timer = undefined
    deadline = undefined
    pending.clear()
  }
  const tick = () => {
    if (!pending.size || !isActive()) { clear(); return }
    heartbeat()
  }
  return {
    active: isActive,
    request(kind: InteractionKind, id: unknown): boolean {
      const value = key(kind, id)
      if (!value || !isActive()) return false
      if (pending.has(value)) return true
      pending.add(value)
      if (!timer) {
        // Background listeners outlive the primary turn timer. Their human
        // waits still need a finite deadline, without renewing it per request.
        deadline = setTimeout(() => {
          const active = isActive()
          clear()
          if (active) timeout()
        }, MAX_WAIT_MS)
        timer = setInterval(tick, HEARTBEAT_MS)
        deadline.unref?.()
        timer.unref?.()
      }
      tick()
      return true
    },
    resolve(kind: InteractionKind, id: unknown): boolean {
      const value = key(kind, id)
      if (!value || !pending.delete(value)) return false
      if (!pending.size) clear()
      return true
    },
    clear,
  }
}
