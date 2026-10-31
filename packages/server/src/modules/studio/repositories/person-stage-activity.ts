import type { PersonStageContext } from '../contracts/person-stage'
import { personUpdated } from './person-updates'

// A delivery is queued until its final reply is committed. It cannot describe
// whether a live turn is currently executing. Keep that separate and ephemeral:
// a restart has no live turn, and a stopped generation must never appear running.
const turns = new Map<string, Set<AbortSignal>>()
const key = (userId: number, context: PersonStageContext) =>
  `${userId}:${context.flowId}:${context.stageId}:${context.generation}`

export function personStageRunning(userId: number, context: PersonStageContext) {
  return (turns.get(key(userId, context))?.size || 0) > 0
}

export function trackPersonStageTurn(userId: number, context: PersonStageContext, signal: AbortSignal) {
  const id = key(userId, context)
  const current = turns.get(id) || new Set<AbortSignal>()
  let released = false
  const release = () => {
    if (released) return
    released = true
    signal.removeEventListener('abort', release)
    current.delete(signal)
    if (!current.size && turns.get(id) === current) turns.delete(id)
    personUpdated(userId)
  }
  if (!signal.aborted) {
    current.add(signal)
    turns.set(id, current)
    signal.addEventListener('abort', release, { once: true })
    personUpdated(userId)
  }
  return release
}
