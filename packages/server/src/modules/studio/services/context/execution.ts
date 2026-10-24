import { StudioError, type ExecutionContext, type ExecutionScope, type ScopedLogger, type StudioDomainServices } from '../../contracts/plugins'
import { jsonCopy } from '../plugins/validation'
import { parseAgentRunStart } from '../agents/start'
import { parseChatRunStart } from '../chat-run/input'
import { parseInteractionResponse } from '../agents/coordinator'
import { parseWorkflowRunStart } from '../workflow/input'

export type ContextOperation = 'artifacts.read' | 'models.read' | 'models.stream' | 'models.gateway' | 'sessions.read' | 'sessions.remove' | 'agents.read' | 'runs.read' | 'runs.start' | 'runs.cancel' | 'runs.respond' | 'chat.start' | 'chat.read' | 'chat.cancel' | 'workflows.run' | 'workflows.read' | 'workflows.cancel'

export interface ContextServices {
  authorize(scope: ExecutionScope, operation: ContextOperation, resourceId?: string): Promise<void>
  artifacts?: { read(scope: ExecutionScope, id: string, offset: number): Promise<import('../../contracts/plugins').ArtifactChunk> }
  models?: {
    gateway?(scope: ExecutionScope, input: Parameters<StudioDomainServices['models']['gateway']>[0], signal: AbortSignal): ReturnType<StudioDomainServices['models']['gateway']>
    list(scope: ExecutionScope): ReturnType<StudioDomainServices['models']['list']>
    get(scope: ExecutionScope, id: string): ReturnType<StudioDomainServices['models']['get']>
    stream(scope: ExecutionScope, input: Parameters<StudioDomainServices['models']['stream']>[0], signal: AbortSignal): ReturnType<StudioDomainServices['models']['stream']>
  }
  workflows?: {
    run(scope: ExecutionScope, input: Parameters<StudioDomainServices['workflows']['run']>[0], signal: AbortSignal): ReturnType<StudioDomainServices['workflows']['run']>
    get(scope: ExecutionScope, id: string): ReturnType<StudioDomainServices['workflows']['get']>
    cancel(scope: ExecutionScope, id: string): ReturnType<StudioDomainServices['workflows']['cancel']>
  }
  chat?: {
    start(scope: ExecutionScope, input: Parameters<StudioDomainServices['chat']['start']>[0], signal: AbortSignal): ReturnType<StudioDomainServices['chat']['start']>
    get(scope: ExecutionScope, id: string): ReturnType<StudioDomainServices['chat']['get']>
    cancel(scope: ExecutionScope, id: string): ReturnType<StudioDomainServices['chat']['cancel']>
  }
  sessions: {
    get: StudioDomainServices['sessions']['get']
    remove?(scope: ExecutionScope, id: string, signal: AbortSignal): ReturnType<StudioDomainServices['sessions']['remove']>
  }
  agents: { list(profileId: string): ReturnType<StudioDomainServices['agents']['list']> }
  runs?: {
    start?(scope: ExecutionScope, input: Parameters<StudioDomainServices['runs']['start']>[0], signal: AbortSignal): ReturnType<StudioDomainServices['runs']['start']>
    get(scope: ExecutionScope, id: string): ReturnType<StudioDomainServices['runs']['get']>
    output(scope: ExecutionScope, id: string, after: number): ReturnType<StudioDomainServices['runs']['output']>
    cancel?(scope: ExecutionScope, id: string): ReturnType<StudioDomainServices['runs']['cancel']>
    interactions?(scope: ExecutionScope, id: string): ReturnType<StudioDomainServices['runs']['interactions']>
    respond?(scope: ExecutionScope, id: string, input: Parameters<StudioDomainServices['runs']['respond']>[1]): ReturnType<StudioDomainServices['runs']['respond']>
    usage?(scope: ExecutionScope, id: string): ReturnType<StudioDomainServices['runs']['usage']>
  }
}

/** Only trusted entrypoints create scopes. Plugins receive this object or an RPC proxy. */
export function createExecutionContext(
  input: ExecutionScope, signal: AbortSignal, logger: ScopedLogger, services: ContextServices,
): ExecutionContext {
  const scope = jsonCopy(input)
  Object.freeze(scope.principal)
  Object.freeze(scope)
  const call = async <T>(operation: ContextOperation, resourceId: string | undefined, execute: () => Promise<T>, mutation = false): Promise<T> => {
    if (signal.aborted) throw new StudioError('CANCELLED', 'Execution scope has ended')
    await services.authorize(scope, operation, resourceId)
    if (signal.aborted) throw new StudioError('CANCELLED', 'Execution scope has ended')
    const result = await execute()
    if (signal.aborted && !mutation) throw new StudioError('CANCELLED', 'Execution scope has ended')
    return jsonCopy(result)
  }
  const sessionId = (id: string): void => {
    if (typeof id !== 'string' || !id.trim() || id.length > 256) throw new StudioError('INVALID_ARGUMENT', 'Invalid session id')
    if (scope.sessionId && scope.sessionId !== id) throw new StudioError('FORBIDDEN', 'Session is outside the execution scope')
  }
  const runId = (id: string): void => {
    if (typeof id !== 'string' || !id || id.length > 256) throw new StudioError('INVALID_ARGUMENT', 'Invalid run id')
    if (scope.runId && scope.runId !== id) throw new StudioError('FORBIDDEN', 'Run is outside the execution scope')
    if (!services.runs) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Run services are unavailable in this host')
  }
  return Object.freeze({
    scope, signal, logger,
    artifacts: Object.freeze({
      read: (id: string, offset = 0) => call('artifacts.read', id, async () => {
        if (!services.artifacts) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Image artifacts are unavailable')
        if (!scope.runId) throw new StudioError('FORBIDDEN', 'Artifact reads require a live Run')
        return services.artifacts.read(scope, id, offset)
      }),
    }),
    models: Object.freeze({
      gateway: async (input: Parameters<StudioDomainServices['models']['gateway']>[0]) => {
        if (signal.aborted) throw new StudioError('CANCELLED', 'Execution scope has ended')
        const snapshot = jsonCopy(input)
        await services.authorize(scope, 'models.gateway')
        if (!services.models?.gateway) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Native model gateways are unavailable')
        if (signal.aborted) throw new StudioError('CANCELLED', 'Execution scope has ended')
        return services.models.gateway(scope, snapshot, signal)
      },
      list: () => call('models.read', undefined, () => {
        if (!services.models) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Model services are unavailable')
        return services.models.list(scope)
      }),
      get: (id: string) => call('models.read', id, () => {
        if (!services.models) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Model services are unavailable')
        return services.models.get(scope, id)
      }),
      stream: async (input: Parameters<StudioDomainServices['models']['stream']>[0]) => {
        if (signal.aborted) throw new StudioError('CANCELLED', 'Execution scope has ended')
        const snapshot = jsonCopy(input)
        await services.authorize(scope, 'models.stream')
        if (!services.models) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Model services are unavailable')
        if (signal.aborted) throw new StudioError('CANCELLED', 'Execution scope has ended')
        return services.models.stream(scope, snapshot, signal)
      },
    }),
    workflows: Object.freeze({
      run: async (input: Parameters<StudioDomainServices['workflows']['run']>[0]) => {
        const request = parseWorkflowRunStart(input)
        if (!services.workflows) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Workflow services are unavailable')
        return call('workflows.run', request.workflowId, () => services.workflows!.run(scope, request, signal), true)
      },
      get: async (id: string) => {
        if (!services.workflows) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Workflow services are unavailable')
        return call('workflows.read', id, () => services.workflows!.get(scope, id))
      },
      cancel: async (id: string) => {
        if (!services.workflows) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Workflow services are unavailable')
        return call('workflows.cancel', id, () => services.workflows!.cancel(scope, id), true)
      },
    }),
    chat: Object.freeze({
      start: async (input: Parameters<StudioDomainServices['chat']['start']>[0]) => {
        const request = parseChatRunStart(input)
        sessionId(request.sessionId)
        if (!services.chat) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Chat services are unavailable')
        return call('chat.start', request.sessionId, () => services.chat!.start(scope, request, signal), true)
      },
      get: async (id: string) => {
        if (!services.chat) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Chat services are unavailable')
        return call('chat.read', id, () => services.chat!.get(scope, id))
      },
      cancel: async (id: string) => {
        if (!services.chat) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Chat services are unavailable')
        return call('chat.cancel', id, () => services.chat!.cancel(scope, id), true)
      },
    }),
    sessions: Object.freeze({
      get: async (id: string) => { sessionId(id); return call('sessions.read', id, () => services.sessions.get(id)) },
      remove: async (id: string) => {
        sessionId(id)
        if (!services.sessions.remove) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Session removal is unavailable in this host')
        return call('sessions.remove', id, () => services.sessions.remove!(scope, id, signal), true)
      },
    }),
    agents: Object.freeze({ list: () => call('agents.read', undefined, () => services.agents.list(scope.profileId)) }),
    runs: Object.freeze({
      start: async (input: Parameters<StudioDomainServices['runs']['start']>[0]) => {
        const request = parseAgentRunStart(input)
        if (!services.runs?.start) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Run start is unavailable in this host')
        return call('runs.start', request.instanceId, () => services.runs!.start!(scope, request, signal), true)
      },
      get: async (id: string) => { runId(id); return call('runs.read', id, () => services.runs!.get(scope, id)) },
      cancel: async (id: string) => {
        runId(id)
        if (!services.runs?.cancel) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Run cancellation is unavailable')
        return call('runs.cancel', id, () => services.runs!.cancel!(scope, id), true)
      },
      interactions: async (id: string) => {
        runId(id)
        if (!services.runs?.interactions) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Run interactions are unavailable')
        return call('runs.read', id, () => services.runs!.interactions!(scope, id))
      },
      respond: async (id: string, input: Parameters<StudioDomainServices['runs']['respond']>[1]) => {
        runId(id)
        const request = parseInteractionResponse(input)
        if (!services.runs?.respond) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Run responses are unavailable')
        return call('runs.respond', id, () => services.runs!.respond!(scope, id, request), true)
      },
      usage: async (id: string) => {
        runId(id)
        if (!services.runs?.usage) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Run usage is unavailable')
        return call('runs.read', id, () => services.runs!.usage!(scope, id))
      },
      output: async (id: string, after = -1) => {
        runId(id)
        if (!Number.isSafeInteger(after) || after < -1) throw new StudioError('INVALID_ARGUMENT', 'Invalid output cursor')
        return call('runs.read', id, () => services.runs!.output(scope, id, after))
      },
    }),
  })
}
