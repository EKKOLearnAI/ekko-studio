import { observeHermesProfileWorker, restartHermesProfileWorker, type HermesProfileWorkerObservation } from '../modules/hermes/public/context-manager'
import { configureContextManagerWorker, type ContextManagerWorkerState } from '../modules/studio/public/context-manager-worker'

function state(observation: HermesProfileWorkerObservation): ContextManagerWorkerState {
  return { profile: observation.profile, status: observation.reachable ? observation.running ? 'running' : 'stopped' : 'unknown',
    pids: observation.workers.filter(worker => worker.running && worker.pid !== null).map(worker => worker.pid!),
    activeSessions: observation.activeSessions, runningSessions: observation.runningSessions,
    ...(!observation.reachable ? { error: { code: 'context_manager_worker_unavailable', message: 'Cannot observe the Hermes worker for this profile' } } : {}) }
}
configureContextManagerWorker({
  getState: async profile => state(await observeHermesProfileWorker(profile)),
  restart: async profile => state((await restartHermesProfileWorker(profile)).after),
})