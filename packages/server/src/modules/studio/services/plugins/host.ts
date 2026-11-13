import { getPluginAgentUpdates } from '../agents/plugin-update-policy'
import { join } from 'node:path'
import type { ApiRequest, Json, PluginIdentity } from '../../contracts/plugins'
import { config } from '../../public/config'
import { issueModelRunJwt } from '../../public/auth'
import { logger } from '../../public/logging'
import { findUserById, getDefaultProfileForUser, listUsers, userCanAccessProfile } from '../../repositories/users-store'
import { getSession } from '../../repositories/session-store'
import { isPersonSession, isPrivatePersonSession, ownsPersonSession } from '../../contracts/person-session'
import { ownedPersonTaskSession } from '../person/task-chat'
import { businessEvents } from '../webhooks/business-events'
import { canReceivePluginEvent, pluginEventData } from './events'
import { desktopBrowserRelays } from '../browser/desktop-relay'
import { PluginManager } from './manager'
import { PluginDevelopment } from './development'
import { PluginError } from './errors'
import { json } from './schema'
import { pluginApiPath } from './policy'
import { configurePluginAgents } from '../agents/registry'
import { reconcileBuiltinPlugins } from './builtin'
import { synchronizePluginMcpServers } from './mcp'
import { connectPluginSession } from './session-transport'

let baseUrl = ''
let instance: PluginManager | undefined
let development: PluginDevelopment | undefined
let unsubscribe: (() => void) | undefined
let builtinInitialization: Promise<void> | undefined
// A new installation creates its first administrator at login, after host startup.
export async function ensureBuiltinPlugins(): Promise<void> {
  if (builtinInitialization) return builtinInitialization
  const administrator = listUsers().find(user => user.role === 'super_admin' && user.status === 'active')
  if (!administrator) return
  builtinInitialization = (async () => {
    await reconcileBuiltinPlugins(getPluginManager(), pluginAdministrationIdentity(administrator.id))
    await synchronizePluginMcpServers()
  })().catch(error => { builtinInitialization = undefined; throw error })
  return builtinInitialization
}
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
    if (!session || (session.profile || 'default') !== identity.profile) throw new PluginError('Session is unavailable in this plugin context', 'PLUGIN_SCOPE', 403)
    if (isPrivatePersonSession(identity.sessionId) && !ownsPersonSession(user.id, session)) {
      try { ownedPersonTaskSession(user.id, identity.sessionId) }
      catch { throw new PluginError('Session is unavailable in this plugin context', 'PLUGIN_SCOPE', 403) }
    }
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
  if (instance) return instance
  instance = new PluginManager(join(config.appHome, 'plugins'), {
    sessions: async (identity, sessionId, listener, signal, kind) => {
      const who = resolvePluginIdentity({ ...identity, sessionId })
      if (kind === 'bot' && !isPersonSession(sessionId)) throw new PluginError('Select an existing BOT conversation', 'PLUGIN_SCOPE', 403)
      if (!baseUrl) throw new PluginError('Session transport is not ready', 'PLUGIN_UNAVAILABLE', 503)
      return connectPluginSession({ baseUrl, sessionId, profile: who.profile, signal, listener,
        token: async () => { authorizePluginIdentity(who); return issueModelRunJwt(findUserById(who.userId)!) },
      })
    },
    browser: async (identity, method, params, binding, signal) => {
      authorizePluginIdentity(identity); signal.throwIfAborted()
      if (!['tabs.list', 'tabs.create', 'tabs.close', 'cdp.attach', 'cdp.send', 'cdp.events', 'lease.release'].includes(method)) throw new PluginError('Unsupported plugin browser method')
      const key = JSON.stringify([binding, identity.userId, identity.profile])
      const envelope = await desktopBrowserRelays.request(identity.userId, identity.profile, { method, params }, key) as { result?: unknown }
      signal.throwIfAborted()
      return json(envelope.result ?? null)
    },
    api, authorize: authorizePluginIdentity, emit: () => {},
    log: (pluginId, identity, level, text) => logger.info({ pluginId, profile: identity.profile, level }, text),
  })
  configurePluginAgents(() => instance?.registeredAgents() || [])
  return instance
}
export function getPluginDevelopment(): PluginDevelopment {
  return development ||= new PluginDevelopment(getPluginManager(), identity => {
    authorizePluginIdentity(identity)
    if (findUserById(identity.userId)?.role !== 'super_admin') throw new PluginError('Plugin development requires an active super administrator', 'PLUGIN_FORBIDDEN', 403)
  }, synchronizePluginMcpServers)
}
export async function startPluginHost(loopbackBaseUrl: string): Promise<void> {
  baseUrl = loopbackBaseUrl
  const manager = getPluginManager()
  await manager.restore()
  getPluginDevelopment().watch()
  try { await ensureBuiltinPlugins() }
  catch (error) { logger.warn({ error }, 'Unable to reconcile bundled Studio plugins') }
  getPluginAgentUpdates().start()
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
export async function stopPluginHost(): Promise<void> { getPluginAgentUpdates().stop(); await development?.close(); development = undefined; unsubscribe?.(); unsubscribe = undefined; await instance?.close(); instance = undefined; baseUrl = ''; builtinInitialization = undefined }
