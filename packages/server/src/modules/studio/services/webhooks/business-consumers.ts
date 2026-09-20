import { configureLiveActivityCatchup } from '../notifications/live-activity-catchup'
import { businessEvents } from './business-events'
import { getChatWebhookDispatcher } from './dispatcher'
import { notifySessionPush } from '../../public/social-messages'
import { createRunPushConsumer } from '../notifications/run-push'
import { createLiveActivityConsumer } from '../notifications/live-activity'

const SOCIAL_EVENTS = new Set(['chat.run.completed', 'chat.approval.requested', 'chat.clarification.requested'])
let initialized = false
export function ensureBusinessConsumers(): void {
  if (initialized) return
  initialized = true
  businessEvents.subscribe('run-push', createRunPushConsumer())
  const liveConsumer = createLiveActivityConsumer()
  businessEvents.subscribe('live-activity', liveConsumer)
  configureLiveActivityCatchup((event, connectionId) => liveConsumer(event, false, connectionId))
  businessEvents.subscribe('http-webhook', event => event.chat ? getChatWebhookDispatcher().enqueue(event.chat) : false)
  businessEvents.subscribe('social-messages', event => {
    if (!event.chat || !SOCIAL_EVENTS.has(event.type)) return
    const original = event.type === 'chat.clarification.requested' ? 'clarify.requested' : event.type.slice(5)
    return notifySessionPush(event.subject.session_id!, original, event.payload, event.chat.agent)
  })
}
