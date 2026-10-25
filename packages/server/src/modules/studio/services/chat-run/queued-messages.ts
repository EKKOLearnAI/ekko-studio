import { contentBlocksToString } from './content-blocks'
import type { QueuedRun } from './types'

export function serializeQueuedMessages(queue: QueuedRun[]) {
  return queue.filter(item => item.displayInput !== null).map(item => ({
    id: item.queue_id,
    role: item.displayRole || (typeof item.displayInput === 'string' && item.displayInput.trim().startsWith('/') ? 'command' : 'user'),
    content: contentBlocksToString(item.displayInput ?? item.input),
    timestamp: Math.floor(Date.now() / 1000),
    queued: true,
  }))
}
