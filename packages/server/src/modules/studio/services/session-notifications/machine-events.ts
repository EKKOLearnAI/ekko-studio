import type { QueuedRun } from '../../contracts/runs/session'
import { transitionSessionNotification } from '../../repositories/session-notification-store'

interface MachineEventBridge {
  processNotification?: (action: 'complete', ref: { session_id: string; profile: string; producer_key: string; claim_id: string }) => Promise<unknown>
}

/** Settle terminal completions removed from a queue: record cancellation, complete the bridge claim. */
export function settleQueuedMachineEvents(items: QueuedRun[], bridge: MachineEventBridge | undefined, onError?: (err: unknown) => void): void {
  for (const item of items) {
    const event = item.machineEvent
    if (!event) continue
    transitionSessionNotification(event.notificationId, 'admitting', 'cancelled')
    try {
      void Promise.resolve(bridge?.processNotification?.('complete', {
        session_id: event.sessionId, profile: event.profile, producer_key: event.producerKey, claim_id: event.claimId,
      })).catch(err => onError?.(err))
    } catch (err) {
      onError?.(err)
    }
  }
}
