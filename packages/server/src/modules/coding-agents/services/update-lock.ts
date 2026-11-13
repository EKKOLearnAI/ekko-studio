const locks = new Set<string>()
export function agentUpdateLocked(id: string): boolean { return locks.has(id) }
export function lockAgentUpdate(id: string): () => void {
  if(agentPreparing(id))throw new Error('Agent is preparing a task; update postponed')
  if(locks.has(id))throw new Error('Agent update is already running')
  locks.add(id)
  return ()=>locks.delete(id)
}

const preparations = new Map<string, number>()
const activity = new Map<string, number>()
export function noteAgentActivity(id: string): void { activity.set(id, (activity.get(id) || 0) + 1) }
export function agentActivityRevision(id: string): number { return activity.get(id) || 0 }
export function agentPreparing(id: string): boolean { return (preparations.get(id) || 0) > 0 }
export function beginAgentPreparation(id: string): () => void {
  if (agentUpdateLocked(id)) throw new Error('Agent is updating; retry after completion')
  noteAgentActivity(id)
  preparations.set(id, (preparations.get(id) || 0) + 1)
  let released = false
  return () => { if (released) return; released = true; preparations.set(id, Math.max(0, (preparations.get(id) || 0) - 1)); noteAgentActivity(id) }
}
