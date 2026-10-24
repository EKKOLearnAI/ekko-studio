import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { getDb } from '../../infrastructure/database'
import { config } from '../../public/config'
import { logger as applicationLogger } from '../../public/logging'
import { findUserById, userCanAccessProfile } from '../../repositories/users-store'
import { getSessionMetadata } from '../../repositories/session-store'
import { PluginStore } from '../../repositories/plugin-store'
import { PluginEventStore } from '../../repositories/plugin-event-store'
import { PluginConsumerStore } from '../../repositories/plugin-consumer-store'
import { ReliablePluginConsumers } from '../events/reliable-consumers'
import { AgentExecutionStore } from '../../repositories/agent-execution-store'
import { StudioError, type ExecutionScope, type ExecutionContext, type EventEnvelope, type ScopedLogger } from '../../contracts/plugins'
import { AgentRegistry } from '../agents/registry'
import { AgentCoordinator } from '../agents/coordinator'
import { AgentArtifacts } from '../agents/artifacts'
import { AgentRunAdmission } from '../agents/admission'
import { createExecutionContext, type ContextOperation } from '../context/execution'
import { PluginEventBus } from '../events/plugin-events'
import { PluginHost } from './host'
import { businessEvents } from '../webhooks/business-events'
import { projectPluginBusinessEvent } from '../events/plugin-business-events'
import { removeStudioSession } from '../sessions/removal'
import { PluginChatRunStore } from '../../repositories/plugin-chat-run-store'
import { PluginChatRuns, authorizeOwnedChatSession } from '../chat-run/plugin'
import { getChatRunServer } from '../chat-run/server-registry'
import { PluginWorkflows } from '../workflow/plugin'
import { authorizePluginEvent } from '../events/plugin-event-access'
import { studioSessionAccount } from '../../contracts/runs/usage'
import { PluginHookRegistry } from '../events/plugin-hooks'
import { configureSessionRemovalHook } from '../sessions/removal-hook'
import { PluginModelCallStore } from '../../repositories/plugin-model-call-store'
import { resolveNativeModel } from '../models/hosted-provider'
import { PluginModels } from '../models/plugin'
import { listApiModels, prepareModelResponse } from '../model-api/service'

const logger: ScopedLogger = {
  info: (message, data) => applicationLogger.info(data || {}, message),
  warn: (message, data) => applicationLogger.warn(data || {}, message),
  error: (message, data) => applicationLogger.error(data || {}, message),
}

export function authorizePluginScope(scope: ExecutionScope, operation?: ContextOperation, resourceId?: string): void {
  if (scope.principal.kind !== 'user') throw new StudioError('FORBIDDEN', 'Plugin execution requires a user principal')
  const user = findUserById(scope.principal.id)
  if (!user || user.status !== 'active') throw new StudioError('FORBIDDEN', 'Execution principal is unavailable')
  if (user.role !== 'super_admin' && !userCanAccessProfile(user.id, scope.profileId)) throw new StudioError('FORBIDDEN', 'Profile access denied')
  const sessionId = operation === 'sessions.read' || operation === 'sessions.remove' ? resourceId : undefined
  if (sessionId) {
    if (scope.sessionId && scope.sessionId !== sessionId) throw new StudioError('FORBIDDEN', 'Session is outside the execution scope')
    const session = getSessionMetadata(sessionId)
    if (session && ((session.profile || 'default') !== scope.profileId || (scope.sessionId && scope.sessionId !== session.id))) {
      throw new StudioError('FORBIDDEN', 'Session is outside the execution scope')
    }
  }
}

export function createStudioPluginRuntime(runnerPath: string) {
  const db = getDb()
  if (!db) throw new StudioError('RUNTIME_UNAVAILABLE', 'Plugins require SQLite')
  const store = new PluginStore(db)
  const eventStore = new PluginEventStore(db)
  const consumers = new ReliablePluginConsumers(new PluginConsumerStore(db), { onError: () => logger.warn('Plugin consumer delivery failed') })
  const hooks = new PluginHookRegistry()
  const registry = new AgentRegistry()
  const events = new PluginEventBus({ onError: () => logger.warn('Plugin event callback failed') })
  const chatStore = new PluginChatRunStore(db)
  chatStore.recover()
  const chat = new PluginChatRuns({ store: chatStore, server: getChatRunServer, authorize: authorizeOwnedChatSession })
  const workflows = new PluginWorkflows(authorizePluginScope)
  const modelStore = new PluginModelCallStore(db)
  const context = (scope: ExecutionScope, signal: AbortSignal): ExecutionContext => createExecutionContext(scope, signal, logger, {
    authorize: async (current, operation, resourceId) => authorizePluginScope(current, operation, resourceId),
    artifacts: { read: async (current, id, offset) => artifacts.read(current, id, offset) },
    agents: { list: async profileId => registry.list(profileId) },
    models: {
      gateway: (current, input, signal) => models.gateway(current, input, signal),
      list: current => models.list(current),
      get: async (current, id) => models.get(current, id),
      stream: (current, input, signal) => models.stream(current, input, signal),
    },
    workflows: {
      run: (current, input, signal) => workflows.run(current, input, signal),
      get: async (current, id) => workflows.get(current, id),
      cancel: (current, id) => workflows.cancel(current, id),
    },
    chat: {
      start: async (current, input, signal) => chat.start(current, input, signal),
      get: async (current, id) => chat.get(current, id),
      cancel: (current, id) => chat.cancel(current, id),
    },
    runs: {
      start: (current, input, signal) => admission.start(current, input, signal),
      get: async (current, id) => coordinator.get(current, id),
      output: async (current, id, after) => coordinator.output(current, id, after),
      cancel: (current, id) => coordinator.cancel(current, id),
      interactions: async (current, id) => coordinator.interactions(current, id),
      respond: (current, id, input) => coordinator.respond(current, id, input),
      usage: async (current, id) => coordinator.usage(current, id),
    },
    sessions: { remove: (current, id, signal) => removeStudioSession({ id, profileId: current.profileId }, {
      signal, sessionId: current.sessionId,
      scope: () => current,
      authorize: () => authorizePluginScope(current, 'sessions.remove', id),
    }), get: async id => {
      const session = getSessionMetadata(id)
      return session ? { id, profileId: session.profile || 'default', title: session.title,
        agentTypeId: session.agent, archived: !!session.is_archived } : null
    } },
  })
  const executionStore = new AgentExecutionStore(db)
  const artifacts = new AgentArtifacts(db, executionStore, authorizePluginScope)
  executionStore.recover()
  modelStore.recover(record => executionStore.state.recordHostModelUsage(record))
  const models = new PluginModels({ store: modelStore, state: executionStore.state, list: listApiModels, prepare: prepareModelResponse, native: resolveNativeModel,
    authorizeStart: current => {
      if (current.runId && !['running', 'waiting_input'].includes(executionStore.get(current.runId)?.status || '')) throw new StudioError('RUN_FINALIZING', 'Parent run no longer accepts model work')
    },
    authorize: current => {
      authorizePluginScope(current)
      if (current.sessionId) authorizeOwnedChatSession(current, current.sessionId)
      if (current.runId) {
        const run = executionStore.get(current.runId)
        if (!run || run.ownerId !== current.principal.id || run.profileId !== current.profileId) throw new StudioError('FORBIDDEN', 'Model parent run is unavailable')
      }
    },
  })
  const coordinator: AgentCoordinator = new AgentCoordinator({ store: executionStore, registry, events, logger,
    stateRoot: resolve(config.appHome, 'plugins', 'state'), validateInput: (scope, input) => artifacts.validate(scope, input), authorize: authorizePluginScope, context, settleRun: id => models.settleRun(id) })
  const admission = new AgentRunAdmission(coordinator, hooks, context)
  const removeHook = configureSessionRemovalHook(async ({ scope, profileId, sessionId, signal }) => {
    if (!hooks.has(profileId, 'sessions.remove')) return
    if (!scope || scope.profileId !== profileId || (scope.sessionId && scope.sessionId !== sessionId)) throw new StudioError('FORBIDDEN', 'Session hook requires the authorized caller scope')
    await hooks.run('sessions.remove', { sessionId }, context({ ...scope, sessionId }, signal))
  })
  const host = new PluginHost({ store, registry, events, consumers, hooks, runnerPath, artifactsRoot: resolve(config.appHome, 'plugins', 'artifacts'), logger, context,
    eventContext: async (state, event, signal) => {
      const run = event.subject.runId ? executionStore.get(event.subject.runId) : null
      const session = event.subject.sessionId ? getSessionMetadata(event.subject.sessionId) : null
      authorizePluginEvent(state, event, { recordedOwner: eventStore.owner(event.id), run, session })
      const scope: ExecutionScope = {
        scopeId: randomUUID(), principal: { kind: 'user', id: state.ownerId }, profileId: state.profileId,
        ...(event.subject.sessionId ? { sessionId: event.subject.sessionId } : {}),
        ...(event.subject.runId ? { runId: event.subject.runId } : {}), surface: 'event', traceId: event.correlationId,
      }
      authorizePluginScope(scope, 'sessions.read', event.subject.sessionId)
      return context(scope, signal)
    },
    acceptEvents: async (batch: EventEnvelope[]) => { for (const event of eventStore.append(batch)) events.publish(event) },
  })
  let notificationSequence = 0
  const unsubscribe = businessEvents.subscribe('studio-plugin-notifications', event => {
    const projected = projectPluginBusinessEvent(event, ++notificationSequence)
    if (projected) {
      const session = event.subject.session_id ? getSessionMetadata(event.subject.session_id) : null
      const historicalOwner = typeof event.payload.studio_owner_id === 'string' && /^[1-9]\d*$/.test(event.payload.studio_owner_id) ? event.payload.studio_owner_id : undefined
      eventStore.append([projected], session ? studioSessionAccount(session) : event.type === 'chat.session.removed' ? historicalOwner : undefined)
      const notification = eventStore.claimNotification(projected.id)
      if (notification) events.publish(notification)
    }
  })
  return { host, store, eventStore, executionStore, artifacts, coordinator, registry, events, consumers, hooks, models, context,
    async close() { unsubscribe(); await removeHook(); chat.close(); await coordinator.close(); await host.close(); await models.close(); await consumers.close(); events.close() } }
}

export type StudioPluginRuntime = ReturnType<typeof createStudioPluginRuntime>
let runtime: StudioPluginRuntime | undefined

export function configureStudioPluginRuntime(value: StudioPluginRuntime): void {
  if (runtime && runtime !== value) throw new StudioError('REVISION_CONFLICT', 'Plugin runtime is already configured')
  runtime = value
}
export function getStudioPluginRuntime(): StudioPluginRuntime {
  if (!runtime) throw new StudioError('PLUGIN_UNAVAILABLE', 'Plugin runtime is not initialized')
  return runtime
}
