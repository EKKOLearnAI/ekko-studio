import { meetingASRService } from './meeting-asr'

interface Backend {
  readonly status: { isRunning: boolean; startupPhase?: string }
  start(): Promise<void>
}

/** Share a lazy startup after Node restarts; do not spawn one child per device. */
export function createRealtimeBackendReady(backend: Backend) {
  let starting: Promise<void> | undefined
  return async function ensureReady(): Promise<void> {
    if (backend.status.isRunning) return
    if (!starting) {
      starting = (async () => {
        // A browser/API caller may already be starting the same service.
        const deadline = Date.now() + 60_000
        while (['venv', 'pip_install', 'starting'].includes(backend.status.startupPhase || '')) {
          if (Date.now() >= deadline) throw new Error('Realtime backend startup timed out')
          await new Promise(resolve => setTimeout(resolve, 100))
          if (backend.status.isRunning) return
        }
        await backend.start()
        if (!backend.status.isRunning) throw new Error('Realtime backend is not ready')
      })().finally(() => { starting = undefined })
    }
    await starting
  }
}

export const ensureRealtimeBackendReady = createRealtimeBackendReady(meetingASRService)
