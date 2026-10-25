import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { getDb } from '../../infrastructure/database'
import { config } from '../../public/config'
import { logger as applicationLogger } from '../../public/logging'
import { findUserById, userCanAccessProfile } from '../../repositories/users-store'
import { addMessage, updateSessionStats, getSessionMetadata, createSession, updateSession } from '../../repositories/session-store'
import { OrdinaryAgentChats } from '../agents/ordinary-chats'
import { OrdinaryAgentChatStore } from '../../repositories/ordinary-agent-chat-store'
import { defaultCodingAgentWorkspace } from '../../public/workspace-manager'
import { getChatCodingAgentPluginMcpServers, getChatCodingAgentPluginLaunch } from '../../public/chat-agent-runtime'
import { hostedModelCatalog, hostedModelCallable } from '../models/hosted-provider'
import { isStudioManagedMcpServer } from '../mcp/managed-config'
import { getSystemPrompt } from '../../public/runs/prompt'
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
import { BundledAgentPlugins } from './bundled-agents'
import { businessEvents } from '../webhooks/business-events'
import { projectPluginBusinessEvent } from '../events/plugin-business-events'
import { removeStudioSession } from '../sessions/removal'
import { PluginCommandStore } from '../../repositories/plugin-command-store'
import { PluginCommands } from '../commands/plugin'
import { CommandExecutionScopes } from '../commands/scopes'
import { PluginChatRunStore } from '../../repositories/plugin-chat-run-store'
import { PluginChatRuns, authorizeOwnedChatSession } from '../chat-run/plugin'
import { getChatRunServer } from '../chat-run/server-registry'
import { PluginWorkflows } from '../workflow/plugin'
import { pluginEventExecutionScope } from '../events/plugin-event-access'
import { studioSessionAccount } from '../../contracts/runs/usage'
import { PluginHookRegistry } from '../events/plugin-hooks'
import { configureSessionRemovalHook } from '../sessions/removal-hook'
import { PluginModelCallStore } from '../../repositories/plugin-model-call-store'
import { resolveNativeModel } from '../models/hosted-provider'
import { PluginModels } from '../models/plugin'
import { listApiModels, prepareModelResponse } from '../model-api/service'
import { AgentManagementStore } from '../../repositories/agent-management-store'
import { createNativeAgentContext } from '../agents/native-context'
import { AgentChatProjection } from '../../repositories/agent-chat-projection'
import { AgentChatStore } from '../../repositories/agent-chat-store'
import { AgentChats } from '../agents/chats'
import { AgentContextRuns } from '../agents/context-runs'
import { setAgentChatService, getAgentChatService } from '../agents/chat-registry'

const logger: ScopedLogger = {
  info: (message, data) => applicationLogger.info(data || {}, message),
  warn: (message, data) => applicationLogger.warn(data || {}, message),
  error: (message, data) => applicationLogger.error(data || {}, message),
}

export function authorizePluginScope(scope: ExecutionScope, operation?: ContextOperation, resourceId?: string): void {
  if (scope.principal.kind === 'service' && scope.surface === 'event' && !scope.profileId && operation === 'agents.read') return
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
    const chats = getAgentChatService()
    if (chats?.isBound(sessionId)) {
      if (operation === 'sessions.remove') chats.authorizeRemoval(scope, sessionId)
      else chats.ownedBinding(scope, sessionId)
    }
    else if (session?.agent_instance_id) throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent chat service is unavailable')
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
  const chat = new PluginChatRuns({ store: chatStore, server: getChatRunServer, authorize: authorizeOwnedChatSession,
    canonical: (scope, sessionId, runId) => agentChats.text(scope, sessionId, runId) })
  const workflows = new PluginWorkflows(authorizePluginScope)
  const modelStore = new PluginModelCallStore(db)
  const commandScopes = new CommandExecutionScopes()
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
      start: (current, input, signal) => contextRuns.start(current, input, signal),
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
  const chatProjection = new AgentChatProjection(db)
  const ordinaryStore = new OrdinaryAgentChatStore(db)
  const executionStore = new AgentExecutionStore(db, chatProjection)
  const managementStore = new AgentManagementStore(db)
  managementStore.recoverInterrupted()
  const artifacts = new AgentArtifacts(db, executionStore, authorizePluginScope)
  executionStore.recover()
  modelStore.recover(record => executionStore.state.recordHostModelUsage(record))
  const models = new PluginModels({ store: modelStore, state: executionStore.state, list: listApiModels, prepare: prepareModelResponse,
    native: (profileId, modelId, protocol, authorize, scope) => {
      if (!modelId.startsWith('studio-chat:')) return resolveNativeModel(profileId, modelId, protocol, authorize)
      authorize()
      const sessionId = modelId.slice('studio-chat:'.length)
      if (!scope?.sessionId || scope.sessionId !== sessionId) throw new StudioError('FORBIDDEN', 'Chat model belongs to another execution scope')
      agentChats.ownedBinding(scope, sessionId)
      const selection = ordinaryStore.selection(sessionId)
      if (!selection?.baseUrl || typeof selection.model !== 'string' || typeof selection.provider !== 'string') throw new StudioError('NOT_FOUND', 'Chat model connection is unavailable')
      return resolveNativeModel(profileId, modelId, protocol, authorize, { profile: profileId, model: selection.model,
        group: { provider: selection.provider, models: [selection.model], api_mode: String(selection.apiMode || '') },
        runtime: { baseUrl: String(selection.baseUrl), apiKey: String(selection.apiKey || ''), ...(selection.apiMode ? { apiMode: String(selection.apiMode) } : {}) } })
    },
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
    authorizeChat: (scope, instance, sessionId) => agentChats.authorizeRunTarget(scope, instance, sessionId),
    nativeContext: (instance, scope, provider, signal) => createNativeAgentContext(instance, scope, signal, runId => {
      authorizePluginScope(scope)
      host.authorizeNativeMcp(provider, scope.profileId)
      const run = executionStore.get(runId)
      if (!run || run.instanceId !== instance.id || run.ownerId !== scope.principal.id || run.profileId !== scope.profileId || run.sessionId !== scope.sessionId || run.surface !== scope.surface
        || !['starting', 'running', 'waiting_input'].includes(run.status)) throw new StudioError('RUN_FINALIZING', 'Native MCP turn is unavailable')
      if (scope.sessionId) agentChats.authorizeRunTarget(scope, instance, scope.sessionId)
    }, { bindTurn: (runId, signal) => agentChats.beginNativeTurn(scope, instance, runId, signal) }),
    managementStore, authorizeManagement: scope => {
      authorizePluginScope(scope)
      if (findUserById(scope.principal.id)?.role !== 'super_admin') throw new StudioError('FORBIDDEN', 'Native terminal requires a super administrator')
    }, leaseManagement: (provider, profileId, cancel, completed) => host.leaseManagement(provider, profileId, cancel, completed),
    stateRoot: resolve(config.appHome, 'plugins', 'state'), validateInput: (scope, input) => artifacts.validate(scope, input), authorize: authorizePluginScope, context, settleRun: id => models.settleRun(id) })
  const admission = new AgentRunAdmission(coordinator, hooks, context)
  const agentChats = new AgentChats({ store: new AgentChatStore(db), projection: chatProjection, executions: executionStore, coordinator, admission, registry,
    authorize: authorizePluginScope, createSession: input => { createSession(input) },
    prepareRuntime: async (scope, instance) => {
      if (bundledAgents.list().some(plugin => plugin.id === instance.agentTypeId)) {
        await bundledAgents.ensure(instance.agentTypeId, () => authorizePluginScope(scope))
      }
    },
    interactions: { begin: (...args) => {
      const server = getChatRunServer()
      if (typeof server?.beginAgentTaskPlanRun !== 'function') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Chat interactions are unavailable')
      return server.beginAgentTaskPlanRun(...args)
    } }, interactionError: runId => logger.warn('Agent chat interaction cleanup failed', { runId }) })
  const contextRuns = new AgentContextRuns({ admission, chats: agentChats, commands: commandScopes, executions: executionStore, coordinator,
    follow: (scope, id, run, key) => { getChatRunServer()?.followManagedAgentRun?.(scope, id, run, key) } })
  const removeHook = configureSessionRemovalHook(async ({ scope, profileId, sessionId, signal }) => {
    const managed = agentChats.isBound(sessionId)
    if (!managed && !hooks.has(profileId, 'sessions.remove')) return
    if (!scope || scope.profileId !== profileId || (scope.sessionId && scope.sessionId !== sessionId)) throw new StudioError('FORBIDDEN', 'Session hook requires the authorized caller scope')
    const lease = managed ? await agentChats.prepareRemoval(scope, sessionId) : undefined
    try {
      if (managed) await getChatRunServer()?.settleManagedAgentChat?.(sessionId)
      if (hooks.has(profileId, 'sessions.remove')) await hooks.run('sessions.remove', { sessionId }, context({ ...scope, sessionId }, signal))
      return lease ? { ownsNative: true as const, removed: () => { lease.reset(); ordinaryStore.retire(sessionId) }, release: () => lease.release() } : undefined
    } catch (error) { lease?.release(); throw error }
  })
  const host = new PluginHost({ store, registry, events, consumers, hooks, runnerPath, artifactsRoot: resolve(config.appHome, 'plugins', 'artifacts'), logger, context,
    eventContext: async (_state, event, signal) => {
      const run = event.subject.runId ? executionStore.get(event.subject.runId) : null
      const session = event.subject.sessionId ? getSessionMetadata(event.subject.sessionId) : null
      const scope = pluginEventExecutionScope(event, { recordedOwner: eventStore.owner(event.id), run, session })
      if (scope.principal.kind === 'user') authorizePluginScope(scope, 'sessions.read', event.subject.sessionId)
      return context(scope, signal)
    },
    acceptEvents: async (batch: EventEnvelope[]) => { for (const event of eventStore.append(batch)) events.publish(event) },
  })
  const commandStore = new PluginCommandStore(db)
  commandStore.recover()
  const commands = new PluginCommands({ registry: host.commands, store: commandStore,
    context: (scope, signal, call, target) => {
      if (call) commandScopes.bind(scope, call, signal, target?.instanceId ? { instanceId: target.instanceId, instanceRevision: target.instanceRevision! } : undefined)
      return context(scope, signal)
    },
    cancelRuns: (scope, callId) => contextRuns.cancelCommand(scope, callId),
    authorize: (scope, id) => {
      const { session } = authorizeOwnedChatSession(scope, id)
      const server = getChatRunServer()
      if (!server?.pluginCommandSessionState) throw new StudioError('RUNTIME_UNAVAILABLE', 'Chat command transport is unavailable')
      return { agentTypeId: session.agent || 'hermes', isWorking: server.pluginCommandSessionState(id).isWorking,
        ...(session.agent_instance_id ? { instanceId: session.agent_instance_id, instanceRevision: session.agent_instance_revision } : {}),
        fingerprint: JSON.stringify([session.agent, session.agent_mode, session.workspace, session.model, session.provider, session.api_mode, session.agent_instance_id, session.agent_instance_revision]) }
    },
    persist: (id, text) => {
      const messageId = addMessage({ session_id: id, role: 'command', content: text })
      updateSessionStats(id)
      return messageId
    },
    committed: (id, text, messageId) => { getChatRunServer()?.cachePluginCommandMessage(id, text, messageId) },
    publish: event => { getChatRunServer()?.publishPluginCommandResult(event) },
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
  const bundledAgents = new BundledAgentPlugins(host, store, runnerPath, (ownerId) => {
    const user = findUserById(ownerId)
    if (!user || user.status !== 'active' || user.role !== 'super_admin') throw new StudioError('FORBIDDEN', 'Plugin installation requires a super administrator')
  })
  const ordinaryChats = new OrdinaryAgentChats({ store: ordinaryStore, registry, coordinator, chats: agentChats,
    authorize: authorizePluginScope, defaultWorkspace: defaultCodingAgentWorkspace, updateSession: (id, { push_enabled, ...settings }) => {
      updateSession(id, { ...settings, ...(push_enabled === undefined ? {} : { push_enabled: push_enabled ? 1 : 0 }) })
    },
    ensure: (scope, id) => bundledAgents.ensure(id, () => authorizePluginScope(scope)),
    prepare: async (scope, selection) => {
      const launch = await getChatCodingAgentPluginLaunch(selection.agentTypeId)
      const servers = getChatCodingAgentPluginMcpServers(selection.agentTypeId, scope.profileId)
      const managed = Object.entries(servers).filter(([name, value]) => isStudioManagedMcpServer(name, value))
      const config: import('../../contracts/plugins').JsonObject = { ...launch, systemPrompt: getSystemPrompt(),
        mcpServers: Object.fromEntries(Object.entries(servers).filter(([name, value]) => !isStudioManagedMcpServer(name, value)
          && (value as { enabled?: boolean; disabled?: boolean }).enabled !== false && (value as { disabled?: boolean }).disabled !== true)) as import('../../contracts/plugins').JsonObject,
        studioMcp: { enabled: managed.length > 0, ...Object.fromEntries(['api', 'browser', 'devices', 'use', 'interaction'].map(toolset => [toolset, managed.some(([name]) => name === `ekko-studio-${toolset}`)])) } }
      if (selection.mode === 'global') { if (selection.model) config.model = selection.model }
      else {
        const entry = [...await hostedModelCatalog([scope.profileId])].find(([, value]) => value.model === selection.model && value.group.provider === selection.provider && hostedModelCallable(value))
        if (selection.baseUrl) config.model = `studio-chat:${selection.sessionId}`
        else {
          if (!entry || selection.apiKey) throw new StudioError('NOT_FOUND', 'Selected chat model is unavailable')
          config.model = entry[0]
        }
      }
      return config
    } })
  return { host, bundledAgents, ordinaryChats, commands, store, eventStore, executionStore, artifacts, coordinator, registry, events, consumers, hooks, models, context, agentChats,
    async close() { unsubscribe(); await removeHook(); chat.close(); await bundledAgents.close(); await commands.close(); await coordinator.close(); agentChats.close(); if (getAgentChatService() === agentChats) setAgentChatService(undefined); await host.close(); await models.close(); await consumers.close(); events.close() } }
}

export type StudioPluginRuntime = ReturnType<typeof createStudioPluginRuntime>
let runtime: StudioPluginRuntime | undefined

export function configureStudioPluginRuntime(value: StudioPluginRuntime): void {
  if (runtime && runtime !== value) throw new StudioError('REVISION_CONFLICT', 'Plugin runtime is already configured')
  runtime = value
  setAgentChatService(value.agentChats)
}
export function getStudioPluginRuntime(): StudioPluginRuntime {
  if (!runtime) throw new StudioError('PLUGIN_UNAVAILABLE', 'Plugin runtime is not initialized')
  return runtime
}
