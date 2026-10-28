import { randomUUID } from 'node:crypto'
import { AgentRuntime, AgentToolRegistry } from '../../../ekko-agent/src'
import type { AgentRuntimeRunInput, AgentRuntimeBoundaryInterruptRequest, AgentRuntimeContextEstimate } from '../../../ekko-agent/src/runtime/types'
import type { ModelRequest } from '../../../ekko-agent/src/model/types'
import type { PersonTaskOrigin } from '../modules/studio/contracts/person'
import type { PersonChatAgentOptions } from '../modules/studio/public/person-runtime'
import { personBudgetedClient } from './person-model-context'
import { estimatePersonContext } from '../modules/studio/services/person/context-estimate'

export function createPersonAgent(options: PersonChatAgentOptions) {
  let originMessages: PersonTaskOrigin['messages'] = []
  let memoryWritable = false
  const registry = new AgentToolRegistry()
  for (const tool of options.tools) registry.register({ definition: { name: tool.name, description: tool.description, parameters: tool.parameters }, async execute(args, context = {}) {
    options.beforeRequest?.()
    if (context.signal?.aborted) throw context.signal.reason || new Error('Cancelled')
    if (tool.name === 'bot_decision_request' && !context.requestUserClarification) throw new Error('User clarification is unavailable in this chat')
    const value = tool.name === 'bot_decision_request'
      ? { response: await context.requestUserClarification?.({ clarifyId: randomUUID(), question: String(args.question || ''),
          choices: Array.isArray(args.choices) ? args.choices.map(String).slice(0, 5) : [], timeoutMs: 30 * 60_000 }) || '',
          instruction: 'Only an actual user response supplies a decision. An empty response is not approval.' }
      : await tool.execute(args, context.sessionId ? { sessionId: context.sessionId, runId: context.runId || '', messages: originMessages } : undefined)
    const content = JSON.stringify(value)
    if (content.length > 18000) throw new Error('Tool result too large; request a smaller page')
    return { ok: !(value && typeof value === 'object' && 'ok' in value && value.ok === false), content }
  } })
  const runtime = new AgentRuntime({ tools: registry, systemPrompt: options.systemPrompt,
    memory: options.memory?.service, profileId: options.memory?.identity.profileId,
    skillsEnabled: false, backgroundDelegationEnabled: false, maxSteps: options.maxSteps, maxModelRetries: 1, modelDefaults: { maxTokens: 2048 } })
  // Reuse the native tools, while fencing writes from callbacks and stale runs.
  for (const name of ['memory_search', 'memory_get', 'memory_write', 'memory_forget']) {
    const tool = registry.get(name)
    if (!tool) continue
    // The native writer exposes both batch and legacy single-write schemas. Person
    // only advertises the atomic batch, avoiding two copies of every field.
    const definition = { ...tool.definition }
    if (name === 'memory_write') {
      const operations = structuredClone((tool.definition.parameters as any).properties.operations)
      // Transcript IDs in retrieved history are not native memory evidence IDs.
      // The native writer already binds omitted IDs to this turn's trusted user input.
      delete operations.items.properties.node.properties.sourceMessageIds
      definition.parameters = {
        type: 'object', properties: { operations }, required: ['operations'], additionalProperties: false,
      }
      definition.description += ' In Person, use only the operations array. Evidence is bound automatically to the current user message; omit sourceMessageIds and never copy historical transcript IDs into memory writes.'
    }
    registry.register({ definition, concurrency: tool.concurrency, async execute(args, context) {
      options.beforeRequest?.()
      context?.signal?.throwIfAborted()
      if (!memoryWritable && (name === 'memory_write' || name === 'memory_forget')) {
        return { ok: false, content: 'A background result cannot change personal memory. Wait for a user message.' }
      }
      return tool.execute(args, context)
    } })
  }
  const isolated = (input: AgentRuntimeRunInput, onPrepared?: (request: ModelRequest) => void): AgentRuntimeRunInput => ({ ...input,
    modelClient: input.modelClient ? personBudgetedClient(input.modelClient, { ...options, onPrepared, messages: [], signal: input.signal || new AbortController().signal }) : undefined,
    memoryEnabled: Boolean(options.memory),
    toolExecutionGuidelinesEnabled: false,
    memoryInput: options.memory ? {
      messages: input.memoryInput?.messages || [], writePolicy: 'automatic',
      origin: options.memory.identity.origin,
      recallScopes: options.memory.identity.recallScopes, writeScopes: options.memory.identity.writeScopes,
      defaultWriteScope: options.memory.identity.defaultWriteScope,
    } : undefined,
    toolContext: options.memory ? { ...input.toolContext, sessionId: options.memory.identity.sessionId, profileId: options.memory.identity.profileId } : input.toolContext,
    skillReviewEnabled: false, backgroundDelegationEnabled: false,
    ephemeralContext: true, contextKey: undefined,
  })
  return {
    sessionWorkspaceDirectory: () => options.workspace,
    requestBoundaryInterrupt: (request: AgentRuntimeBoundaryInterruptRequest) => runtime.requestBoundaryInterrupt(request),
    estimateContext: (input: AgentRuntimeRunInput) => runtime.estimateContext(isolated(input)),
    run: async (input: AgentRuntimeRunInput) => {
      options.beforeRequest?.()
      input.signal?.throwIfAborted()
      memoryWritable = Boolean(input.memoryInput?.messages.some(message => typeof message === 'string' || message.role === 'user'))
      const current = input.messages.findLast(message => typeof message === 'string' || message.role === 'user')
      const query = typeof current === 'string' ? current : current?.content || ''
      const messages = [...(options.loadHistory?.(String(query)) || []), ...input.messages]
      originMessages = structuredClone(messages) as PersonTaskOrigin['messages']
      let latest: AgentRuntimeContextEstimate | undefined
      let runId = '', step = 0
      const result = await runtime.run(isolated({ ...input, messages, onEvent: event => {
        if ('runId' in event) runId = event.runId
        if ('step' in event) step = event.step
        // The runtime estimates before the provider wrapper selects/compacts messages.
        if (event.type !== 'context.estimated') return input.onEvent?.(event)
      } }, request => {
        latest = estimatePersonContext(request)
        input.onEvent?.({ type: 'context.estimated', runId, step, estimate: latest })
      }))
      return { ...result, contextEstimate: latest || result.contextEstimate }
    },
  }
}
