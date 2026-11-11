import { join } from 'node:path'
import type { ApiRequest, Json, PluginIdentity } from '../../contracts/plugins'
import { config } from '../../public/config'
import { issueModelRunJwt } from '../../public/auth'
import { logger } from '../../public/logging'
import { findUserById, getDefaultProfileForUser, listUsers, userCanAccessProfile } from '../../repositories/users-store'
import { getSession } from '../../repositories/session-store'
import { isPrivatePersonSession, ownsPersonSession } from '../../contracts/person-session'
import { businessEvents } from '../webhooks/business-events'
import { canReceivePluginEvent, pluginEventData } from './events'
import { PluginManager } from './manager'
import { PluginError } from './errors'
import { json } from './schema'
import { pluginApiPath } from './policy'

let baseUrl = ''
let instance: PluginManager | undefined
let unsubscribe: (() => void) | undefined
export function resolvePluginIdentity(identity: PluginIdentity): PluginIdentity {
  const session = identity.sessionId ? getSession(identity.sessionId) : undefined
  const result = { ...identity, workspace: session?.workspace || undefined }
  authorizePluginIdentity(result)
  return result
}
export function pluginAdministrationIdentity(userId: number): PluginIdentity {
  return resolvePluginIdentity({ userId, profile: getDefaultProfileForUser(userId), surface: 'ui' })
}
export function authorizePluginIdentity(identity: PluginIdentity): void {
  const user = findUserById(identity.userId)
  if (!user || user.status !== 'active' || user.role !== 'super_admin' && !userCanAccessProfile(user.id, identity.profile)) throw new PluginError('Plugin user no longer has access to this profile', 'PLUGIN_FORBIDDEN', 403)
  if (identity.sessionId) {
    const session = getSession(identity.sessionId)
    if (!session || (session.profile || 'default') !== identity.profile || isPrivatePersonSession(identity.sessionId) && !ownsPersonSession(user.id, session)) throw new PluginError('Session is unavailable in this plugin context', 'PLUGIN_SCOPE', 403)
  }
}
async function api(identity: PluginIdentity, path: string, options: ApiRequest, signal: AbortSignal): Promise<Json> {
  authorizePluginIdentity(identity)
  if (!baseUrl) throw new PluginError('Plugin API transport is not ready', 'PLUGIN_UNAVAILABLE', 503)
  const url = pluginApiPath(path, identity, options)
  const user = findUserById(identity.userId)!
  const token = await issueModelRunJwt(user)
  const response = await fetch(`${baseUrl}${url.pathname}${url.search}`, {
    method: options.method || 'GET', signal, redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Hermes-Profile': identity.profile },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  const text = await response.text()
  if (!response.ok) throw new PluginError(text.slice(0, 2000) || `Studio API returned ${response.status}`, 'PLUGIN_API', response.status)
  if (!text) return null
  try { return json(JSON.parse(text)) } catch { return json(text) }
}
export function getPluginManager(): PluginManager {
  return instance ||= new PluginManager(join(config.appHome, 'plugins'), {
    api, authorize: authorizePluginIdentity, emit: () => {},
    log: (pluginId, identity, level, text) => logger.info({ pluginId, profile: identity.profile, level }, text),
  })
}
export async function startPluginHost(loopbackBaseUrl: string): Promise<void> {
  baseUrl = loopbackBaseUrl
  const manager = getPluginManager()
  await manager.restore()
  unsubscribe = businessEvents.subscribe('studio-plugins', async event => {
    const envelope = pluginEventData(event)
    if (!envelope) return
    for (const user of listUsers()) {
      if (user.status !== 'active' || !canReceivePluginEvent(user, event)) continue
      // Room membership is independent of the room's summary model Profile.
      // Publish into the recipient's authorized contexts so room members can
      // observe their rooms without gaining access to that model Profile.
      const profiles = event.source === 'group_chat'
        ? [...new Set([...user.profiles, ...(user.role === 'super_admin' ? [event.profile] : [])])]
        : [event.profile]
      for (const profile of profiles) {
        const identity = { userId: user.id, profile }
        try { authorizePluginIdentity(identity) } catch { continue }
        // Removed sessions no longer authorize a session-scoped context; retain
        // their id in the subject. Group runtime sessions may use another Profile.
        const sessionId = event.type === 'chat.session.removed' || event.source === 'group_chat' ? undefined : event.subject.session_id
        try {
          await manager.dispatch({ id: event.id, type: event.type, timestamp: Date.parse(event.occurred_at),
            identity: { ...identity, sessionId, runId: event.subject.run_id, surface: event.source }, data: envelope })
        } catch { logger.warn({ type: event.type, userId: user.id }, 'Plugin event delivery failed') }
      }
    }
  })
}
export async function stopPluginHost(): Promise<void> { unsubscribe?.(); unsubscribe = undefined; await instance?.close(); instance = undefined; baseUrl = '' }
