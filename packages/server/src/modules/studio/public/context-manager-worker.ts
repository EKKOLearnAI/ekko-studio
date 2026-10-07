export interface ContextManagerWorkerState {
  status: 'running' | 'stopped' | 'unknown'
  profile: string
  pids: number[]
  activeSessions: number | null
  runningSessions: number | null
  error?: { code: string; message: string }
}

export interface ContextManagerWorkerPort {
  getState(profile: string): Promise<ContextManagerWorkerState>
  restart(profile: string): Promise<ContextManagerWorkerState>
}

let port: ContextManagerWorkerPort | null = null
export function configureContextManagerWorker(next: ContextManagerWorkerPort): void { port = next }
export async function getContextManagerWorkerState(profile: string): Promise<ContextManagerWorkerState> {
  if (!port) return { profile, status: 'unknown', pids: [], activeSessions: null, runningSessions: null,
    error: { code: 'context_manager_worker_unavailable', message: 'Cannot observe the Hermes worker for this profile' } }
  try { return await port.getState(profile) } catch {
    return { profile, status: 'unknown', pids: [], activeSessions: null, runningSessions: null,
      error: { code: 'context_manager_worker_unavailable', message: 'Cannot observe the Hermes worker for this profile' } }
  }
}
export async function restartHermesContextManagerWorker(profile: string): Promise<ContextManagerWorkerState> {
  if (!port) throw new Error('Hermes worker operations are unavailable')
  return port.restart(profile)
}