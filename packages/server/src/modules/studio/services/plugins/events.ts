import type { AuthenticatedUser } from '../../public/auth'
import { isPrivatePersonSession } from '../../contracts/person-session'
import { getSession } from '../../repositories/session-store'
import { getGroupChatRuntimeServer } from '../group-chat/runtime'
import { canReadGroupChatRoom } from '../group-chat/access'
import { appEventEnvelope, canReceiveAppEvent } from '../webhooks/app-events'
import type { BusinessEvent } from '../webhooks/business-events'
import { PLUGIN_EVENT_TYPES } from '../../../../../../plugin-sdk/src'
import { json } from './schema'

export function canReceivePluginEvent(user: AuthenticatedUser, event: BusinessEvent): boolean {
  if (isPrivatePersonSession(event.subject.session_id) || event.source === 'person') return canReceiveAppEvent(user, event)
  if (event.source === 'group_chat') {
    // Interaction decisions retain the stricter ownership rules of the App.
    if (/^group\.(approval|clarification)\./.test(event.type)) return canReceiveAppEvent(user, event)
    const storage = getGroupChatRuntimeServer()?.getStorage()
    return !!storage && !!event.subject.room_id && canReadGroupChatRoom(storage, event.subject.room_id, user)
  }
  if (event.type === 'chat.session.removed') return event.payload.owner_user_id === user.id
  if (event.source === 'workflow') return canReceiveAppEvent(user, event)
  const session = event.subject.session_id ? getSession(event.subject.session_id) : null
  return !!session && (session.profile || 'default') === event.profile
}

/** Keep the normalized content/subject, rather than filtering through notification
 * eligibility. Raw internal payloads (credentials, provider config) never escape. */
export function pluginEventData(event: BusinessEvent) {
  if (!(PLUGIN_EVENT_TYPES as readonly string[]).includes(event.type)) return null
  const envelope = appEventEnvelope(event)
  const fields = Object.fromEntries(['state', 'delta', 'message_id', 'agent_id', 'agent_name', 'status', 'session']
    .filter(key => event.payload[key] !== undefined).map(key => [key, event.payload[key]]))
  return json({ ...envelope, ...event.chat, ...fields,
    schema_version: 1, id: event.id, type: event.type, occurred_at: event.occurred_at,
    timestamp: Date.parse(event.occurred_at), profile: event.profile, source: event.source, subject: event.subject })
}
