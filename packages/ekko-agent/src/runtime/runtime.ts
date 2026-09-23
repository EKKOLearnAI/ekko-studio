import { createHash, randomUUID } from 'node:crypto'
import { EkkoJevClient } from '../jev'
import { watch, type FSWatcher } from 'node:fs'
import {
  agentReasoningEstimatedTokens,
  agentReasoningText,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  collectModelEvents,
  modelResponseToAgentMessage,
  normalizeAgentMessage,
  normalizeAgentMessages,
} from '../model/messages'
import { countTextTokens } from '../model/tokens'
import type { AgentMessageInput, AgentOutputMessage } from '../model/messages'
import type { AgentMessage, AgentToolCall, AgentToolDefinition, ModelRequest, ModelResponse } from '../model/types'
import type { AgentSkill } from '../skills/types'
import { RunTaskPlan } from '../tools/plan'
import { AgentToolRegistry, createDefaultToolRegistry } from '../tools/registry'
import { sanitizeAgentToolResult } from '../tools/tool-result-sanitizer'
import type { AgentTaskRequest, AgentToolContext, AgentToolResult } from '../tools/types'
import {
  inspectLocalSkillValidationIssues,
  resolveSkillRouting,
  type DiscoveredSkill,
  type SkillRoutingResolution,
  type SkillValidationIssue,
} from '../tools/skills'
import { workspaceToolAssetDirectory } from '../tools/workspace-temp'
import type { AgentRuntimeEvent } from './events'
import { buildSystemPrompt } from './system-prompt'
import type {
  AgentRuntimeBoundaryInterruptRequest,
  AgentRuntimeBoundaryInterruptResult,
  AgentRuntimeBoundaryPhase,
  AgentRuntimeContextEstimate,
  AgentRuntimeOptions,
  AgentRuntimeRecoveryDirective,
  AgentRuntimeRunInput,
  AgentRuntimeRunResult,
  AgentRuntimeStep,
  EkkoBackgroundContinuationContext,
} from './types'
import type { MemoryContext, MemoryEvidenceMessageInput, MemoryOrigin, MemoryRuntimeIdentity } from '../memory/types'
import {
  hasExplicitMemoryForgetIntent,
  hasExplicitMemoryForgetAllIntent,
  hasExplicitMemoryIntent,
  type MemoryCaptureMessage,
} from '../memory/service'
import { PROFILE_MEMORY_SCOPE } from '../memory/scope'
import { createMemoryTools } from '../memory/tools'
import { SkillReviewService } from '../skills/review'
import type { EkkoExternalSkillDirectory } from '../skills/external-directories'
import { EkkoRuntimeLogger } from '../logging/runtime-logger'
import {
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_AGENT_MODEL_MAX_RETRIES,
  DEFAULT_AGENT_SUBTASK_MAX_STEPS,
  DEFAULT_AGENT_TOOL_FAILURE_RECOVERY_THRESHOLD,
  DEFAULT_SKILL_REVIEW_TOOL_CALL_INTERVAL,
} from '../config'

const MAX_TRACKED_SKILL_REVIEW_CONTEXTS = 1_024
const MAX_CONCURRENT_TOOL_CALLS = 8
const SUBTASK_OUTPUT_TAIL_CHARS = 4_000
const SUBTASK_SUMMARY_CHARS = 500
const TOOL_FAILURE_RECOVERY_DETAIL_CHARS = 2_000
interface ModelResponseResult {
  response: ModelResponse
  emittedReasoning: boolean
}

interface BackgroundTask {
  sessionId?: string
  controller: AbortController
  promise: Promise<AgentToolResult>
  resolveContinuationContext: (context: EkkoBackgroundContinuationContext | null) => void
}

interface ActiveBoundaryRun {
  runId: string
  sessionId: string
  phase: AgentRuntimeBoundaryPhase
  modelController: AbortController
  pending: boolean
  terminal: boolean
}

interface HistoricalSkillView {
  messageIndex: number
  toolCallId?: string
  name: string
  filePath: string
  declaredCharacters?: number
  declaredHash?: string
  body: string
}

interface ToolCallSegment {
  mode: 'serial' | 'parallel'
  toolCalls: AgentToolCall[]
}

interface ExecutedToolCall {
  toolCall: AgentToolCall
  result: AgentToolResult
}

interface ToolFailureStreak {
  toolName: string
  failures: number
}

function toolFailureRecoveryPrompt(streak: ToolFailureStreak, result: AgentToolResult): string {
  const detail = String(result.error || result.content || 'Unknown tool failure.')
    .slice(0, TOOL_FAILURE_RECOVERY_DETAIL_CHARS)
  return [
    `Tool recovery required: "${streak.toolName}" failed ${streak.failures} consecutive times.`,
    'Do not repeat the same call unchanged and do not stop the run because of these tool failures.',
    'Diagnose the latest error, correct the arguments or prerequisites, or switch to a different tool or approach.',
    'Continue working toward the user\'s goal.',
    `Latest failure: ${detail}`,
  ].join('\n')
}

function foregroundOnlyDelegateTaskDefinition(definition: AgentToolDefinition): AgentToolDefinition {
  if (definition.name !== 'delegate_task') return definition
  const parameters = definition.parameters || {}
  const properties = parameters.properties && typeof parameters.properties === 'object' && !Array.isArray(parameters.properties)
    ? parameters.properties as Record<string, unknown>
    : {}
  const rawMode = properties.mode
  const mode = rawMode && typeof rawMode === 'object' && !Array.isArray(rawMode)
    ? rawMode as Record<string, unknown>
    : {}
  return {
    ...definition,
    description: [
      'Delegate one self-contained task to an isolated Ekko subagent.',
      'Only foreground delegation is available in this run; the parent waits for the result.',
    ].join(' '),
    parameters: {
      ...parameters,
      properties: {
        ...properties,
        mode: {
          ...mode,
          enum: ['foreground'],
          description: 'foreground waits for and returns the result.',
        },
      },
    },
  }
}

function cloneAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  return structuredClone(messages)
}

export class AgentRuntime {
  readonly jev: EkkoJevClient
  private readonly modelClient?: AgentRuntimeOptions['modelClient']
  private readonly profileId?: string
  private readonly toolsEnabled: boolean
  private readonly tools: AgentToolRegistry
  private readonly skillsEnabled: boolean
  private readonly skillsAvailable?: () => boolean
  private readonly skills: AgentSkill[]
  private readonly skillDirectory?: string
  private readonly externalSkillDirectories: EkkoExternalSkillDirectory[]
  private readonly disabledSkillNames: string[]
  private readonly systemPrompt?: string
  private readonly runtimeInstructions: string[]
  private readonly temporaryRuntimeInstructions?: () => string[]
  private readonly recoveryDirective?: () => AgentRuntimeRecoveryDirective
  private readonly maxSteps: number
  private readonly toolContext?: AgentToolContext
  private readonly modelDefaults?: AgentRuntimeOptions['modelDefaults']
  private readonly maxModelRetries: number
  private readonly toolFailureRecoveryThreshold: number
  private readonly backgroundDelegationEnabled: boolean
  private readonly subtaskMaxSteps: number
  private readonly defaultContextKey?: string
  private readonly memory?: AgentRuntimeOptions['memory']
  private readonly skillReview?: SkillReviewService
  private readonly skillReviewEveryToolCalls: number
  private readonly skillToolCallCounts = new Map<string, number>()
  private readonly modelContexts = new Map<string, unknown>()
  private readonly backgroundTasks = new Map<string, BackgroundTask>()
  private readonly activeBoundaryRuns = new Map<string, ActiveBoundaryRun>()
  private readonly activeSkillValidationIssues = new Map<string, string>()
  private readonly runtimeLogger?: EkkoRuntimeLogger

  constructor(options: AgentRuntimeOptions) {
    this.jev = new EkkoJevClient(options.jev)
    this.profileId = String(options.profileId || '').trim() || undefined
    this.modelClient = options.modelClient
    this.toolsEnabled = options.toolsEnabled !== false
    this.tools = this.toolsEnabled
      ? options.tools ?? createDefaultToolRegistry({
          skillDirectory: options.skillDirectory,
          externalSkillDirectories: options.externalSkillDirectories,
          disabledSkillNames: options.disabledSkillNames,
          authorizer: options.toolAuthorizer,
        })
      : new AgentToolRegistry()
    if (this.toolsEnabled && options.tools && options.toolAuthorizer) {
      this.tools.setAuthorizer(options.toolAuthorizer)
    }
    this.skillsEnabled = options.skillsEnabled !== false
    this.skillsAvailable = options.skillsAvailable
    this.skills = this.skillsEnabled ? options.skills ?? [] : []
    this.skillDirectory = String(options.skillDirectory || '').trim() || undefined
    this.externalSkillDirectories = options.externalSkillDirectories ?? []
    this.disabledSkillNames = options.disabledSkillNames ?? []
    this.systemPrompt = options.systemPrompt
    this.runtimeInstructions = options.runtimeInstructions ?? []
    this.temporaryRuntimeInstructions = options.temporaryRuntimeInstructions
    this.recoveryDirective = options.recoveryDirective
    this.maxSteps = options.maxSteps ?? DEFAULT_AGENT_MAX_STEPS
    this.toolContext = options.toolContext
    this.modelDefaults = options.modelDefaults
    this.maxModelRetries = options.maxModelRetries ?? DEFAULT_AGENT_MODEL_MAX_RETRIES
    this.toolFailureRecoveryThreshold = Math.max(1, Math.floor(
      options.toolFailureRecoveryThreshold
      ?? options.maxConsecutiveToolFailures
      ?? DEFAULT_AGENT_TOOL_FAILURE_RECOVERY_THRESHOLD,
    ))
    this.backgroundDelegationEnabled = options.backgroundDelegationEnabled !== false
    this.subtaskMaxSteps = Math.max(
      1,
      Math.floor(options.subtaskMaxSteps ?? DEFAULT_AGENT_SUBTASK_MAX_STEPS),
    )
    this.defaultContextKey = options.contextKey
    this.memory = options.memory
    this.runtimeLogger = options.logWriter
      ? new EkkoRuntimeLogger(options.logWriter, { profile: options.logProfile })
      : undefined
    this.skillReviewEveryToolCalls = Math.max(
      0,
      Math.floor(options.skillReviewEveryToolCalls ?? DEFAULT_SKILL_REVIEW_TOOL_CALL_INTERVAL),
    )
    this.skillReview = this.toolsEnabled && this.skillsEnabled && options.skillDirectory
      ? new SkillReviewService({
          skillDirectory: options.skillDirectory,
          externalSkillDirectories: this.externalSkillDirectories,
          disabledSkillNames: this.disabledSkillNames,
        })
      : undefined
    this.registerSkillTools(this.skills)
    if (this.toolsEnabled && this.memory) {
      this.tools.registerMany(createMemoryTools(this.memory))
    }
  }

  registerSkill(skill: AgentSkill): void {
    if (!this.skillsEnabled) return
    this.skills.push(skill)
    this.registerSkillTools([skill])
  }

  registerSkills(skills: AgentSkill[]): void {
    for (const skill of skills) {
      this.registerSkill(skill)
    }
  }

  async refreshTools(context?: AgentToolContext): Promise<void> {
    if (!this.toolsEnabled) return
    await this.tools.refreshTools(context)
  }

  async drainSkillReviews(): Promise<void> {
    await this.skillReview?.drain()
  }

  hasBackgroundTasks(sessionId?: string): boolean {
    for (const task of this.backgroundTasks.values()) {
      if (!sessionId || task.sessionId === sessionId) return true
    }
    return false
  }

  async abortBackgroundTasks(sessionId?: string): Promise<number> {
    const tasks = [...this.backgroundTasks.values()]
      .filter(task => !sessionId || task.sessionId === sessionId)
    for (const task of tasks) {
      task.controller.abort()
      task.resolveContinuationContext(null)
    }
    await Promise.allSettled(tasks.map(task => task.promise))
    return tasks.length
  }

  /**
   * Stop a foreground run at the next runtime-owned safe boundary.
   *
   * Model requests are aborted immediately. Tool batches are allowed to finish
   * in full, and the run stops before the next model request. Repeated requests
   * for the same run are idempotent and never affect detached subagents.
   */
  requestBoundaryInterrupt(
    input: AgentRuntimeBoundaryInterruptRequest,
  ): AgentRuntimeBoundaryInterruptResult {
    const sessionId = input.sessionId.trim()
    const expectedRunId = input.expectedRunId?.trim()
    const sessionRuns = [...this.activeBoundaryRuns.values()]
      .filter(run => run.sessionId === sessionId && !run.terminal)

    if (sessionRuns.length === 0) return { status: 'not_running' }

    const activeRun = expectedRunId
      ? sessionRuns.find(run => run.runId === expectedRunId)
      : sessionRuns.length === 1
        ? sessionRuns[0]
        : undefined

    if (!activeRun) {
      return { status: expectedRunId ? 'run_mismatch' : 'ambiguous' }
    }
    if (activeRun.pending) {
      return {
        status: 'already_pending',
        runId: activeRun.runId,
        phase: activeRun.phase,
      }
    }

    activeRun.pending = true
    if (activeRun.phase === 'model') activeRun.modelController.abort()
    return {
      status: 'accepted',
      runId: activeRun.runId,
      phase: activeRun.phase,
    }
  }

  /**
   * Estimate the provider-visible context without starting a model run.
   *
   * Hosts that own conversation compaction can use this to account for Ekko's
   * system prompt, tools, and provider context while keeping compaction itself
   * outside the runtime.
   */
  async estimateContext(input: AgentRuntimeRunInput): Promise<AgentRuntimeContextEstimate> {
    await this.refreshTools(this.runToolContext(input))
    const modelClient = this.modelClientFor(input)
    const skillRouting = await this.skillRouting(input)
    const messages = this.prepareMessages(input, undefined, skillRouting.names)
    const skillsToLoad = reconcileMatchedSkillContext(messages, skillRouting.matches)
    this.appendMatchedSkillMessages(messages, skillsToLoad)
    const request = this.modelRequest(input, messages, modelClient, this.contextKeyFor(input))
    return estimateModelRequestContext(request)
  }

  async run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult> {
    return this.jev.runScoped(input.signal, () => this.runWithSnapshot(input))
  }

  private async runWithSnapshot(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult> {
    await this.refreshTools(this.runToolContext(input))

    const runId = randomUUID()
    const events: AgentRuntimeEvent[] = []
    const steps: AgentRuntimeStep[] = []
    const maxSteps = input.maxSteps ?? this.maxSteps
    const maxModelRetries = input.maxModelRetries ?? this.maxModelRetries
    const toolFailureRecoveryThreshold = Math.max(1, Math.floor(
      input.toolFailureRecoveryThreshold
      ?? input.maxConsecutiveToolFailures
      ?? this.toolFailureRecoveryThreshold,
    ))
    const pendingBackgroundSubagentIds = new Set<string>()
    const taskPlan = new RunTaskPlan(runId, plan => {
      input.onPlanUpdate?.(plan)
      emit({ type: 'plan.updated', runId, plan })
    })
    const emit = (event: AgentRuntimeEvent) => {
      if (event.type === 'run.completed') {
        taskPlan.finish(event.output.finishReason === 'boundary_interrupt' ? 'interrupted' : 'ended')
      } else if (event.type === 'run.failed') {
        taskPlan.finish(input.signal?.aborted ? 'interrupted' : 'failed')
      }
      events.push(event)
      input.onEvent?.(event)
    }

    // Publish interruption before the host closes its stream, even if an active tool
    // takes time to acknowledge cancellation. The run error path retries failed commits.
    const interruptPlan = () => {
      try { taskPlan.finish('interrupted') } catch { /* Retried by run.failed. */ }
    }
    const inputSkills = this.areSkillsAvailable() ? input.skills ?? [] : []
    this.registerSkillTools(inputSkills)
    const memoryIdentity = this.memoryIdentityFor(input)
    const memoryPreparation = await this.prepareMemory(input, memoryIdentity, runId)
    const memoryContext = memoryPreparation?.context
    const sessionId = this.contextKeyFor(input)?.trim()
    const activeBoundaryRun = sessionId
      ? this.registerBoundaryRun(sessionId, runId)
      : undefined

    emit({ type: 'run.started', runId, maxSteps })

    const executionToolContext: AgentToolContext = {
      ...(this.runToolContext(input, memoryPreparation?.sourceMessageIds) || {}),
      updatePlan: update => {
        throwIfAborted(input.signal)
        return taskPlan.update(update)
      },
      runId,
      modelCapabilities: this.modelClientFor(input).capabilities,
      modelProvider: this.modelClientFor(input).provider,
      modelName: input.model ?? input.modelDefaults?.model ?? this.modelDefaults?.model,
      skillMutationSource: 'foreground',
      delegationDepth: input.toolContext?.delegationDepth ?? this.toolContext?.delegationDepth ?? 0,
      delegateTask: request => {
        if (request.mode === 'background' && this.backgroundDelegationFor(input) === false) {
          return Promise.resolve({
            ok: false,
            content: 'Background subtask delegation is disabled for this run. Use foreground mode.',
            error: 'Background subtask delegation is disabled for this run. Use foreground mode.',
          })
        }
        return this.delegateTask(
          request,
          input,
          runId,
          emit,
          subagentId => pendingBackgroundSubagentIds.add(subagentId),
        )
      },
    }
    if (memoryContext) {
      emit({
        type: 'memory.retrieved',
        runId,
        diagnostics: memoryContext.diagnostics,
        memoryIds: memoryContext.usedMemoryIds,
      })
    }
    const skillRouting = await this.skillRouting(input)
    const messages = this.prepareMessages(
      input,
      memoryContext ? this.memory?.contextPrompt(memoryContext) : undefined,
      skillRouting.names,
    )
    let output: AgentOutputMessage = {
      role: 'assistant',
      content: '',
    }
    const contextKey = this.contextKeyFor(input)
    let contextEstimate: AgentRuntimeContextEstimate | undefined
    let toolFailureStreak: ToolFailureStreak | undefined
    const completeBoundaryInterrupt = (completedSteps: number): AgentRuntimeRunResult => {
      if (activeBoundaryRun) activeBoundaryRun.terminal = true
      output = {
        role: 'assistant',
        content: '',
        finishReason: 'boundary_interrupt',
      }
      const context = contextKey ? this.modelContexts.get(contextKey) : undefined
      emit({ type: 'run.completed', runId, output, steps: completedSteps, context, contextEstimate })
      return { runId, messages, output, steps, events, context, contextEstimate, memoryContext }
    }

    input.signal?.addEventListener('abort', interruptPlan, { once: true })
    try {
      const automaticRecoveryCalls = this.currentRecoveryDirective()?.automaticToolCalls ?? []
      if (automaticRecoveryCalls.length) {
        const toolCalls: AgentToolCall[] = automaticRecoveryCalls
          .filter(call => this.tools.get(call.name))
          .map(call => ({
            id: `recovery-auto-${randomUUID()}`,
            name: call.name,
            arguments: call.arguments ?? {},
          }))
        if (toolCalls.length) {
          const recoveryMessage: AgentOutputMessage = { role: 'assistant', content: '', toolCalls }
          messages.push(recoveryMessage)
          steps.push({ type: 'model', step: 0, message: recoveryMessage })
          for (const segment of this.planToolCallSegments(toolCalls)) {
            const executedCalls = await this.executeToolCallSegment(
              runId,
              0,
              segment,
              executionToolContext,
              emit,
              input.signal,
            )
            for (const { toolCall, result } of executedCalls) {
              messages.push(createToolResultMessage(toolCall.id, result.content, toolCall.name, result.contentParts))
              steps.push({ type: 'tool', step: 0, toolCallId: toolCall.id, toolName: toolCall.name, result })
            }
          }
        }
      }
      const matchedSkills = reconcileMatchedSkillContext(messages, skillRouting.matches)
      if (matchedSkills.length) {
        const toolCalls: AgentToolCall[] = matchedSkills.map(skill => ({
          id: `skill-auto-${randomUUID()}`,
          name: 'skill_view',
          arguments: { name: skill.name },
        }))
        const skillLoadMessage: AgentOutputMessage = {
          role: 'assistant',
          content: '',
          toolCalls,
        }
        messages.push(skillLoadMessage)
        steps.push({ type: 'model', step: 0, message: skillLoadMessage })
        for (const segment of this.planToolCallSegments(toolCalls)) {
          const executedCalls = await this.executeToolCallSegment(
            runId,
            0,
            segment,
            executionToolContext,
            emit,
            input.signal,
          )
          for (const { toolCall, result } of executedCalls) {
            messages.push(createToolResultMessage(toolCall.id, result.content, toolCall.name, result.contentParts))
            steps.push({ type: 'tool', step: 0, toolCallId: toolCall.id, toolName: toolCall.name, result })
          }
        }
      }
      for (let step = 1; step <= maxSteps; step += 1) {
        throwIfAborted(input.signal)
        if (activeBoundaryRun?.pending) return completeBoundaryInterrupt(step - 1)
        const modelSignal = activeBoundaryRun
          ? enterBoundaryModelPhase(activeBoundaryRun, input.signal)
          : input.signal
        const modelClient = this.modelClientFor(input)
        emit({ type: 'model.started', runId, step })
        const request = this.modelRequest(input, messages, modelClient, contextKey, modelSignal)
        request.metadata = { ...request.metadata, session_id: contextKey || runId }
        const recoveryDirective = this.currentRecoveryDirective()
        if (recoveryDirective?.active && request.tools?.length) {
          const allowed = new Set(recoveryDirective.allowedToolNames)
          const recoveryTools = request.tools.filter(tool => allowed.has(tool.name))
          if (recoveryTools.length) {
            request.tools = recoveryTools
            request.toolChoice = 'required'
          }
        }
        contextEstimate = estimateModelRequestContext(request)
        emit({ type: 'context.estimated', runId, step, estimate: contextEstimate })
        const modelResult = await this.createModelResponseWithRetries(
          request,
          modelClient,
          runId,
          step,
          maxModelRetries,
          emit,
          input.logContext,
        )
        if (activeBoundaryRun?.pending) return completeBoundaryInterrupt(step - 1)
        const response = modelResult.response
        const assistantMessage = normalizeToolCallPreamble(modelResponseToAgentMessage(response))
        const toolCalls = assistantMessage.toolCalls ?? []
        const blockedByRecovery = toolCalls.length === 0 && this.currentRecoveryDirective()?.active === true
        if (activeBoundaryRun && toolCalls.length > 0) {
          activeBoundaryRun.phase = 'tool_batch'
        }
        output = assistantMessage
        messages.push(assistantMessage)
        steps.push({ type: 'model', step, message: assistantMessage })
        const reasoningText = agentReasoningText(assistantMessage.reasoning)
        if (reasoningText && !modelResult.emittedReasoning) {
          emit({ type: 'model.reasoning', runId, step, text: reasoningText })
        }
        if (assistantMessage.context !== undefined) {
          if (contextKey) this.modelContexts.set(contextKey, assistantMessage.context)
          emit({ type: 'model.context', runId, step, context: assistantMessage.context })
        }
        if (!blockedByRecovery) emit({ type: 'model.message', runId, step, message: assistantMessage })

        if (activeBoundaryRun?.pending && toolCalls.length === 0) {
          return completeBoundaryInterrupt(step)
        }
        if (blockedByRecovery) {
          const directive = this.currentRecoveryDirective()
          messages.push(createSystemMessage(
            directive?.reminder ||
            'Ekko recovery remains incomplete. Continue using recovery tools and do not ask the user whether to run a safe retry.',
          ))
          continue
        }
        if (toolCalls.length === 0) {
          const context = contextKey ? this.modelContexts.get(contextKey) : assistantMessage.context
          if (activeBoundaryRun) activeBoundaryRun.terminal = true
          emit({ type: 'run.completed', runId, output, steps: step, context, contextEstimate })
          this.completeMemory(memoryIdentity, messages, input)
          this.completeSkillReview(runId, contextKey, messages, input, input.onEvent)
          return { runId, messages, output, steps, events, context, contextEstimate, memoryContext }
        }

        const toolRecoveryPrompts: string[] = []
        for (const segment of this.planToolCallSegments(toolCalls)) {
          const executedCalls = await this.executeToolCallSegment(
            runId,
            step,
            segment,
            executionToolContext,
            emit,
            input.signal,
          )
          for (const { toolCall, result } of executedCalls) {
            messages.push(createToolResultMessage(toolCall.id, result.content, toolCall.name, result.contentParts))
            steps.push({ type: 'tool', step, toolCallId: toolCall.id, toolName: toolCall.name, result })
            if (input.skillReviewEnabled !== false) this.recordSkillToolCall(contextKey, toolCall.name)
            if (result.ok) {
              toolFailureStreak = undefined
              continue
            }
            toolFailureStreak = toolFailureStreak?.toolName === toolCall.name
              ? { toolName: toolCall.name, failures: toolFailureStreak.failures + 1 }
              : { toolName: toolCall.name, failures: 1 }
            if (toolFailureStreak.failures >= toolFailureRecoveryThreshold) {
              emit({
                type: 'run.tool_recovery_required',
                runId,
                toolName: toolCall.name,
                failures: toolFailureStreak.failures,
              })
              toolRecoveryPrompts.push(toolFailureRecoveryPrompt(toolFailureStreak, result))
              toolFailureStreak = undefined
            }
          }
        }
        messages.push(...toolRecoveryPrompts.map(createSystemMessage))
        if (pendingBackgroundSubagentIds.size > 0) {
          const continuationMessages = cloneAgentMessages(messages.slice(1))
          for (const subagentId of pendingBackgroundSubagentIds) {
            this.backgroundTasks.get(subagentId)?.resolveContinuationContext({
              version: 1,
              subagentId,
              originRunId: runId,
              originStep: step,
              messages: continuationMessages,
              memoryPolicy: 'disabled',
            })
          }
          pendingBackgroundSubagentIds.clear()
        }
        if (activeBoundaryRun?.pending) return completeBoundaryInterrupt(step)
      }

      if (activeBoundaryRun) activeBoundaryRun.terminal = true
      emit({ type: 'run.max_steps', runId, maxSteps })
      output = {
        role: 'assistant',
        content: `Stopped after reaching maxSteps (${maxSteps}).`,
        finishReason: 'max_steps',
      }
      const context = contextKey ? this.modelContexts.get(contextKey) : undefined
      emit({ type: 'run.completed', runId, output, steps: maxSteps, context, contextEstimate })
      this.completeMemory(memoryIdentity, messages, input)
      this.completeSkillReview(runId, contextKey, messages, input, input.onEvent)
      return { runId, messages, output, steps, events, context, contextEstimate, memoryContext }
    } catch (error) {
      if (
        activeBoundaryRun?.pending &&
        activeBoundaryRun.modelController.signal.aborted &&
        !input.signal?.aborted &&
        isAbortError(error)
      ) {
        return completeBoundaryInterrupt(steps.filter(step => step.type === 'model' && step.step > 0).length)
      }
      const message = error instanceof Error ? error.message : String(error)
      if (activeBoundaryRun) activeBoundaryRun.terminal = true
      emit({ type: 'run.failed', runId, error: message, steps: steps.length })
      throw error
    } finally {
      input.signal?.removeEventListener('abort', interruptPlan)
      for (const subagentId of pendingBackgroundSubagentIds) {
        const task = this.backgroundTasks.get(subagentId)
        task?.controller.abort()
        task?.resolveContinuationContext(null)
      }
      if (input.ephemeralContext && contextKey) this.modelContexts.delete(contextKey)
      if (activeBoundaryRun) this.activeBoundaryRuns.delete(activeBoundaryRun.runId)
    }
  }

  private async createModelResponseWithRetries(
    request: ModelRequest,
    modelClient: NonNullable<AgentRuntimeOptions['modelClient']>,
    runId: string,
    step: number,
    maxRetries: number,
    emit: (event: AgentRuntimeEvent) => void,
    logContext?: AgentRuntimeRunInput['logContext'],
  ): Promise<ModelResponseResult> {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      try {
        throwIfAborted(request.signal)
        if (request.stream && modelClient.capabilities.streaming) {
          return await this.streamModelResponse(
            request,
            modelClient,
            runId,
            step,
            attempt,
            maxRetries + 1,
            emit,
            logContext,
          )
        }
        const span = this.runtimeLogger?.startModelRequest({
          client: modelClient,
          request,
          runId,
          step,
          attempt,
          maxAttempts: maxRetries + 1,
          transport: 'create',
          context: logContext,
        })
        let response: ModelResponse
        try {
          response = await modelClient.create(request)
          span?.complete(response)
        } catch (error) {
          span?.fail(error)
          throw error
        }
        if (response.usage) emit({ type: 'model.usage', runId, step, usage: response.usage })
        return {
          response,
          emittedReasoning: false,
        }
      } catch (error) {
        throwIfAborted(request.signal)
        if (attempt > maxRetries || isNonRetryableModelError(error)) throw error
        emit({
          type: 'model.retry',
          runId,
          step,
          retry: attempt,
          maxRetries,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    throw new Error('Model request retry loop exited unexpectedly.')
  }

  private async streamModelResponse(
    request: ModelRequest,
    modelClient: NonNullable<AgentRuntimeOptions['modelClient']>,
    runId: string,
    step: number,
    attempt: number,
    maxAttempts: number,
    emit: (event: AgentRuntimeEvent) => void,
    logContext?: AgentRuntimeRunInput['logContext'],
  ): Promise<ModelResponseResult> {
    let emittedReasoning = false
    const streamRequest = { ...request, stream: true }
    const streamSpan = this.runtimeLogger?.startModelRequest({
      client: modelClient,
      request: streamRequest,
      runId,
      step,
      attempt,
      maxAttempts,
      transport: 'stream',
      context: logContext,
    })
    let output: Awaited<ReturnType<typeof collectModelEvents>>
    try {
      const events = modelClient.stream(streamRequest)
      output = await collectModelEvents((async function *streamAndEmit() {
        for await (const event of events) {
          if (event.type === 'text-delta') {
            emit({ type: 'model.delta', runId, step, text: event.text })
          } else if (event.type === 'reasoning-delta') {
            emittedReasoning = true
            emit({ type: 'model.reasoning', runId, step, text: event.text })
          } else if (event.type === 'tool-call') {
            emit({ type: 'model.tool_call', runId, step, toolCall: event.toolCall })
          } else if (event.type === 'error') {
            throw new Error(event.error)
          }
          yield event
        }
      })())
      streamSpan?.complete(output.message, { emptyResponse: isEmptyModelResponse(output.message) })
    } catch (error) {
      streamSpan?.fail(error)
      throw error
    }
    if (output.message.usage) {
      emit({ type: 'model.usage', runId, step, usage: output.message.usage })
    }
    if (isEmptyModelResponse(output.message)) {
      const fallbackRequest = { ...request, stream: false }
      const fallbackSpan = this.runtimeLogger?.startModelRequest({
        client: modelClient,
        request: fallbackRequest,
        runId,
        step,
        attempt,
        maxAttempts,
        transport: 'create',
        fallback: true,
        context: logContext,
      })
      let response: ModelResponse
      try {
        response = await modelClient.create(fallbackRequest)
        fallbackSpan?.complete(response)
      } catch (error) {
        fallbackSpan?.fail(error)
        throw error
      }
      if (response.usage) emit({ type: 'model.usage', runId, step, usage: response.usage })
      return {
        response,
        emittedReasoning: false,
      }
    }
    return {
      response: output.message,
      emittedReasoning,
    }
  }

  private prepareMessages(
    input: AgentRuntimeRunInput,
    memoryContext?: string,
    skillNames: string[] = [],
  ): AgentMessage[] {
    const normalized = normalizeAgentMessages(input.messages)
    const userSystemMessages = normalized.filter(message => message.role === 'system').map(message => message.content)
    const nonSystemMessages = normalized.filter(message => message.role !== 'system')
    const modelClient = this.modelClientFor(input)
    const toolContext = this.mergedToolContext(input)
    const systemPrompt = buildSystemPrompt({
      basePrompt: input.systemPrompt ?? this.systemPrompt,
      runtimeInstructions: this.currentRuntimeInstructions(),
      userSystemMessages,
      memoryContext,
      planningEnabled: this.toolsEnabled && !!this.tools.get('update_plan'),
      clarificationEnabled: this.toolsEnabled && !!this.tools.get('clarify'),
      skillDiscoveryEnabled: this.toolsEnabled && this.areSkillsAvailable() &&
        !!this.tools.get('skill_list') &&
        !!this.tools.get('skill_view'),
      skillManagementEnabled: this.toolsEnabled && this.areSkillsAvailable() && !!this.tools.get('skill_manage'),
      skillNames,
      context: {
        provider: modelClient.provider,
        model: input.model ?? input.modelDefaults?.model ?? this.modelDefaults?.model,
        profile: this.profileId || stringMetadata(input.metadata?.profile) || toolContext?.profileId,
        cwd: toolContext?.cwd,
        workspaceRoot: toolContext?.workspaceRoot,
      },
    })

    return [
      createSystemMessage(systemPrompt),
      ...nonSystemMessages,
    ]
  }

  private currentRuntimeInstructions(): string[] {
    if (!this.temporaryRuntimeInstructions) return this.runtimeInstructions
    try {
      return [
        ...this.runtimeInstructions,
        ...this.temporaryRuntimeInstructions().map(value => String(value || '').trim()).filter(Boolean),
      ]
    } catch (error) {
      return [
        ...this.runtimeInstructions,
        `Ekko temporary diagnostics could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      ]
    }
  }

  private currentRecoveryDirective(): AgentRuntimeRecoveryDirective | undefined {
    if (!this.recoveryDirective) return undefined
    try {
      return this.recoveryDirective()
    } catch {
      return undefined
    }
  }

  private async skillRouting(input: AgentRuntimeRunInput): Promise<SkillRoutingResolution> {
    if (
      !this.toolsEnabled ||
      !this.areSkillsAvailable() ||
      !this.skillDirectory ||
      !this.tools.get('skill_view')
    ) return { names: [], matches: [] }
    const latestMemoryUserMessage = input.memoryInput?.messages?.length
      ? [...normalizeAgentMessages(input.memoryInput.messages as AgentMessageInput[])]
        .reverse()
        .find(message => message.role === 'user' && message.content.trim())
        ?.content
      : undefined
    const latestUserMessage = latestMemoryUserMessage || [...normalizeAgentMessages(input.messages)]
      .reverse()
      .find(message => message.role === 'user' && message.content.trim())
      ?.content
    return resolveSkillRouting(
      this.skillDirectory,
      latestUserMessage,
      this.externalSkillDirectories,
      this.disabledSkillNames,
    )
  }

  private appendMatchedSkillMessages(
    messages: AgentMessage[],
    matchedSkills: DiscoveredSkill[],
  ): void {
    if (!matchedSkills.length) return
    const calls = matchedSkills.map(skill => ({
      id: `skill-auto-estimate-${skill.name}`,
      name: 'skill_view',
      arguments: { name: skill.name },
    }))
    messages.push(createAssistantMessage('', calls))
    for (let index = 0; index < matchedSkills.length; index += 1) {
      const skill = matchedSkills[index]
      messages.push(createToolResultMessage(
        calls[index].id,
        `[skill_view] name=${skill.name} (${skill.content.length} chars) file=SKILL.md sha256=${skillContentHash(skill.content)} baseDirectory=${skill.directory}\n${skill.content}`,
        'skill_view',
      ))
    }
  }

  private memoryIdentityFor(input: AgentRuntimeRunInput): MemoryRuntimeIdentity | undefined {
    if (!this.memory || input.memoryEnabled === false) return undefined
    const sessionId = this.contextKeyFor(input)
    if (!sessionId) return undefined
    const context = this.mergedToolContext(input)
    return {
      sessionId,
      profileId: this.profileId || stringMetadata(input.metadata?.profile) || context?.profileId || 'default',
      origin: input.memoryInput?.origin,
      recallScopes: input.memoryInput?.recallScopes ?? [PROFILE_MEMORY_SCOPE],
      writeScopes: input.memoryInput?.writeScopes ?? [PROFILE_MEMORY_SCOPE],
      defaultWriteScope: input.memoryInput?.defaultWriteScope ?? PROFILE_MEMORY_SCOPE,
    }
  }

  private async prepareMemory(
    input: AgentRuntimeRunInput,
    identity: MemoryRuntimeIdentity | undefined,
    runId: string,
  ): Promise<{ context: MemoryContext; sourceMessageIds: string[] } | undefined> {
    if (!this.memory || !identity) return undefined
    const modelClient = this.modelClientFor(input)
    const model = input.model ?? input.modelDefaults?.model ?? this.modelDefaults?.model
    const normalized = this.memoryCaptureMessages(input)
    const writePolicy = input.memoryInput?.writePolicy ?? 'automatic'
    const shouldCapture = writePolicy === 'automatic' || hasExplicitMemoryIntent(normalized)
    const capturedIds = shouldCapture
      ? await this.memory.captureMessages(identity, normalized)
      : []
    const queryText = [...normalized].reverse().find(message => message.role === 'user')?.content
    let latestUserIndex = -1
    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      if (normalized[index].role === 'user') {
        latestUserIndex = index
        break
      }
    }
    return {
      context: await this.memory.retrieve(identity, queryText),
      sourceMessageIds: latestUserIndex >= 0 && capturedIds[latestUserIndex]
        ? [capturedIds[latestUserIndex]]
        : [],
    }
  }

  private completeMemory(
    identity: MemoryRuntimeIdentity | undefined,
    messages: AgentMessage[],
    input: AgentRuntimeRunInput,
  ): void {
    if (!this.memory || !identity) return
    const writePolicy = input.memoryInput?.writePolicy ?? 'automatic'
    const memoryMessages = input.memoryInput
      ? completedMemoryCaptureMessages(input.memoryInput.messages, messages, input.memoryInput.origin)
      : messages
          .filter(message => message.role === 'user' || message.role === 'assistant')
          .map(toMemoryCaptureMessage)
    this.memory.scheduleCapture(identity, memoryMessages, writePolicy)
  }

  private memoryCaptureMessages(input: AgentRuntimeRunInput): MemoryCaptureMessage[] {
    const origin = input.memoryInput?.origin
    if (input.memoryInput) return normalizeMemoryEvidenceMessages(input.memoryInput.messages, origin)
    return normalizeAgentMessages(input.messages)
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .map(toMemoryCaptureMessage)
  }

  private recordSkillToolCall(contextKey: string | undefined, toolName: string): void {
    if (!this.areSkillsAvailable() || !this.skillReview || this.skillReviewEveryToolCalls <= 0) return
    const key = contextKey || '__default__'
    if (toolName === 'skill_manage') {
      this.skillToolCallCounts.delete(key)
      return
    }
    const count = (this.skillToolCallCounts.get(key) || 0) + 1
    this.skillToolCallCounts.delete(key)
    this.skillToolCallCounts.set(key, count)
    if (this.skillToolCallCounts.size > MAX_TRACKED_SKILL_REVIEW_CONTEXTS) {
      const oldestKey = this.skillToolCallCounts.keys().next().value
      if (oldestKey) this.skillToolCallCounts.delete(oldestKey)
    }
  }

  private completeSkillReview(
    runId: string,
    contextKey: string | undefined,
    messages: AgentMessage[],
    input: AgentRuntimeRunInput,
    emit?: (event: AgentRuntimeEvent) => void,
  ): void {
    if (
      input.skillReviewEnabled === false ||
      !this.areSkillsAvailable() ||
      (input.toolContext?.delegationDepth ?? this.toolContext?.delegationDepth ?? 0) > 0 ||
      !this.skillReview ||
      this.skillReviewEveryToolCalls <= 0 ||
      !this.tools.get('skill_manage')
    ) {
      return
    }
    const key = contextKey || '__default__'
    if ((this.skillToolCallCounts.get(key) || 0) < this.skillReviewEveryToolCalls) return
    this.skillToolCallCounts.delete(key)
    const modelClient = this.modelClientFor(input)
    this.skillReview.schedule({
      modelClient,
      model: input.model ?? input.modelDefaults?.model ?? this.modelDefaults?.model,
      messages: messages.map(message => ({ ...message })),
      requestLogger: this.runtimeLogger,
      requestLogContext: input.logContext,
      requestRunId: runId,
      sessionId: contextKey || runId,
      onUsage: input.onSkillReviewUsage,
      onStarted: reviewId => emit?.({ type: 'skill.review.started', runId, reviewId }),
      onCompleted: (reviewId, mutations) => emit?.({
        type: 'skill.review.completed',
        runId,
        reviewId,
        mutations,
      }),
      onFailed: (reviewId, error) => emit?.({ type: 'skill.review.failed', runId, reviewId, error }),
    })
  }

  private modelRequest(
    input: AgentRuntimeRunInput,
    messages: AgentMessage[],
    modelClient: NonNullable<AgentRuntimeOptions['modelClient']>,
    contextKey: string | undefined,
    signal: AbortSignal | undefined = input.signal,
  ): ModelRequest {
    const modelDefaults = input.modelDefaults ?? this.modelDefaults
    const toolDefinitions = this.toolsEnabled
      ? this.tools.definitions().filter(definition => (
          (input.toolContext?.delegationDepth ?? this.toolContext?.delegationDepth ?? 0) === 0 ||
          definition.name !== 'delegate_task'
        )).map(definition => this.backgroundDelegationFor(input) === false
          ? foregroundOnlyDelegateTaskDefinition(definition)
          : definition)
      : []
    const tools = toolDefinitions.length > 0 ? toolDefinitions : undefined
    return {
      ...modelDefaults,
      model: input.model ?? modelDefaults?.model,
      temperature: input.temperature ?? modelDefaults?.temperature,
      maxTokens: input.maxTokens ?? modelDefaults?.maxTokens,
      reasoningEffort: input.reasoningEffort ?? modelDefaults?.reasoningEffort,
      reasoningSummary: input.reasoningSummary ?? modelDefaults?.reasoningSummary,
      metadata: input.metadata ?? modelDefaults?.metadata,
      messages,
      signal,
      tools,
      toolChoice: tools ? modelDefaults?.toolChoice : undefined,
      stream: modelClient.capabilities.streaming,
      context: input.context ?? (contextKey ? this.modelContexts.get(contextKey) : modelDefaults?.context),
    }
  }

  private contextKeyFor(input: AgentRuntimeRunInput): string | undefined {
    return input.contextKey ||
      (typeof input.metadata?.session_id === 'string' ? input.metadata.session_id : undefined) ||
      input.toolContext?.sessionId ||
      this.defaultContextKey
  }

  private backgroundDelegationFor(input: AgentRuntimeRunInput): boolean {
    return input.backgroundDelegationEnabled ?? this.backgroundDelegationEnabled
  }

  private registerBoundaryRun(sessionId: string, runId: string): ActiveBoundaryRun {
    const activeRun: ActiveBoundaryRun = {
      runId,
      sessionId,
      phase: 'model',
      modelController: new AbortController(),
      pending: false,
      terminal: false,
    }
    this.activeBoundaryRuns.set(runId, activeRun)
    return activeRun
  }

  private modelClientFor(input: AgentRuntimeRunInput): NonNullable<AgentRuntimeOptions['modelClient']> {
    const modelClient = input.modelClient ?? this.modelClient
    if (!modelClient) {
      throw new Error('AgentRuntime requires a modelClient in constructor options or run input.')
    }
    return modelClient
  }

  private runToolContext(input: AgentRuntimeRunInput, sourceMessageIds?: string[]): AgentToolContext | undefined {
    const context = this.mergedToolContext(input)
    const memoryMessages = this.memoryCaptureMessages(input)
    const memoryWritePolicy = input.memoryInput?.writePolicy ?? 'automatic'
    const memoryExplicitIntent = hasExplicitMemoryIntent(memoryMessages)
    const memoryForgetIntent = hasExplicitMemoryForgetIntent(memoryMessages)
    const memoryForgetAllIntent = hasExplicitMemoryForgetAllIntent(memoryMessages)
    return {
      ...context,
      ...(sourceMessageIds?.length ? { sourceMessageIds } : {}),
      ...(this.memory ? {
        memoryWritePolicy,
        memoryExplicitIntent,
        memoryForgetIntent,
        memoryForgetAllIntent,
      } : {}),
      ...(input.memoryInput?.origin ? { memoryOrigin: input.memoryInput.origin } : {}),
      ...(input.memoryInput?.recallScopes ? { memoryRecallScopes: input.memoryInput.recallScopes } : {}),
      ...(input.memoryInput?.writeScopes ? { memoryWriteScopes: input.memoryInput.writeScopes } : {}),
      ...(input.memoryInput?.defaultWriteScope ? { memoryDefaultWriteScope: input.memoryInput.defaultWriteScope } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    }
  }

  private mergedToolContext(input: AgentRuntimeRunInput): AgentToolContext | undefined {
    const context = this.toolContext || input.toolContext
      ? { ...this.toolContext, ...input.toolContext }
      : undefined
    if (!this.profileId) return context
    return { ...context, profileId: this.profileId }
  }

  private planToolCallSegments(toolCalls: AgentToolCall[]): ToolCallSegment[] {
    const segments: ToolCallSegment[] = []
    for (const toolCall of toolCalls) {
      const mode = this.tools.get(toolCall.name)?.concurrency === 'parallel'
        ? 'parallel'
        : 'serial'
      const previous = segments.at(-1)
      if (previous?.mode === mode) previous.toolCalls.push(toolCall)
      else segments.push({ mode, toolCalls: [toolCall] })
    }
    return segments
  }

  private async executeToolCallSegment(
    runId: string,
    step: number,
    segment: ToolCallSegment,
    context: AgentToolContext | undefined,
    emit: (event: AgentRuntimeEvent) => void,
    signal?: AbortSignal,
  ): Promise<ExecutedToolCall[]> {
    if (segment.mode === 'serial' || segment.toolCalls.length <= 1) {
      const executedCalls: ExecutedToolCall[] = []
      for (const toolCall of segment.toolCalls) {
        throwIfAborted(signal)
        const result = await this.executeTool(runId, step, toolCall, context, emit, signal)
        throwIfAborted(signal)
        executedCalls.push({ toolCall, result })
      }
      return executedCalls
    }

    const results: Array<ExecutedToolCall | undefined> = new Array(segment.toolCalls.length)
    let nextIndex = 0
    const worker = async () => {
      while (!signal?.aborted) {
        const index = nextIndex
        nextIndex += 1
        if (index >= segment.toolCalls.length) return
        const toolCall = segment.toolCalls[index]
        const result = await this.executeTool(runId, step, toolCall, context, emit, signal)
        results[index] = { toolCall, result }
      }
    }
    const workerCount = Math.min(MAX_CONCURRENT_TOOL_CALLS, segment.toolCalls.length)
    await Promise.all(Array.from({ length: workerCount }, worker))
    throwIfAborted(signal)
    return results as ExecutedToolCall[]
  }

  private async executeTool(
    runId: string,
    step: number,
    toolCall: AgentToolCall,
    context: AgentToolContext | undefined,
    emit: (event: AgentRuntimeEvent) => void,
    signal?: AbortSignal,
  ): Promise<AgentToolResult> {
    const startedAt = Date.now()
    emit({
      type: 'tool.started',
      runId,
      step,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      arguments: toolCall.arguments,
    })

    try {
      throwIfAborted(signal)
      const skillChangeProbe = toolCall.name === 'terminal_exec' && this.skillDirectory
        ? await createDirectoryChangeProbe(this.skillDirectory)
        : undefined
      let skillDirectoryChanged = false
      let rawResult: AgentToolResult
      try {
        rawResult = await this.tools.execute(toolCall.name, toolCall.arguments, context)
      } finally {
        skillDirectoryChanged = await skillChangeProbe?.stop() ?? false
      }
      const shouldInspectSkills = toolCall.name === 'skill_manage'
        || skillDirectoryChanged
        || (toolCall.name === 'terminal_exec'
          && terminalCallReferencesSkillDirectory(toolCall.arguments, this.skillDirectory))
      const validatedResult = await this.annotateSkillValidation(
        toolCall.name,
        rawResult,
        shouldInspectSkills,
      )
      const result = await sanitizeAgentToolResult(validatedResult, {
        tempRoot: workspaceToolAssetDirectory(context),
      })
      throwIfAborted(signal)
      emit({
        type: result.ok ? 'tool.completed' : 'tool.failed',
        runId,
        step,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result,
        durationMs: Date.now() - startedAt,
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const result: AgentToolResult = {
        ok: false,
        content: message,
        error: message,
      }
      emit({
        type: 'tool.failed',
        runId,
        step,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result,
        durationMs: Date.now() - startedAt,
      })
      return result
    }
  }

  private async annotateSkillValidation(
    toolName: string,
    result: AgentToolResult,
    shouldInspect: boolean,
  ): Promise<AgentToolResult> {
    if (
      !shouldInspect ||
      !this.skillDirectory ||
      (toolName !== 'terminal_exec' && toolName !== 'skill_manage')
    ) return result

    let issues: SkillValidationIssue[]
    try {
      issues = await inspectLocalSkillValidationIssues(this.skillDirectory)
    } catch {
      // Skill validation must never replace the result of the command itself.
      return result
    }

    const currentKeys = new Set(issues.map(issue => issue.directory))
    for (const key of this.activeSkillValidationIssues.keys()) {
      if (!currentKeys.has(key)) this.activeSkillValidationIssues.delete(key)
    }

    const changed = issues.filter(issue => {
      const signature = `${issue.status}:${issue.sha256}:${issue.error}`
      const previous = this.activeSkillValidationIssues.get(issue.directory)
      this.activeSkillValidationIssues.set(issue.directory, signature)
      return previous !== signature
    })
    if (toolName !== 'terminal_exec' || changed.length === 0) return result

    const payload = {
      status: 'requires_repair',
      writable: true,
      issues: changed,
      next: 'Call skill_view for each Skill, then repair its SKILL.md with skill_manage before reporting installation success.',
    }
    const notice = [
      '[skill_validation] Local Skill installation requires repair before deterministic routing:',
      ...changed.map(issue => `- ${issue.name} (${issue.status}): ${issue.error}`),
      payload.next,
    ].join('\n')

    return {
      ...result,
      content: [result.content, notice].filter(Boolean).join('\n\n'),
      data: appendStructuredData(result.data, 'skillValidation', payload),
    }
  }

  private async delegateTask(
    request: AgentTaskRequest,
    parentInput: AgentRuntimeRunInput,
    parentRunId: string,
    emit: (event: AgentRuntimeEvent) => void,
    onBackgroundStarted?: (subagentId: string) => void,
  ): Promise<AgentToolResult> {
    const subagentId = randomUUID()
    const background = request.mode === 'background'
    const startedAt = Date.now()
    const controller = new AbortController()
    let resolveContinuationContext!: (context: EkkoBackgroundContinuationContext | null) => void
    const continuationContextReady = new Promise<EkkoBackgroundContinuationContext | null>((resolve) => {
      resolveContinuationContext = resolve
    })
    const sessionId = this.contextKeyFor(parentInput)
    const childContextKey = sessionId
      ? `${sessionId}:subagent:${subagentId}`
      : `subagent:${subagentId}`
    const abortChild = () => controller.abort()
    parentInput.signal?.addEventListener('abort', abortChild, { once: true })
    if (parentInput.signal?.aborted) controller.abort()
    emit({
      type: 'subagent.start',
      runId: parentRunId,
      subagentId,
      goal: request.goal,
      background,
      model: parentInput.model ?? parentInput.modelDefaults?.model ?? this.modelDefaults?.model,
      startedAt,
    })

    let toolCount = 0
    let apiCalls = 0
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let reasoningTokens = 0
    let childRunId: string | undefined
    const streamedTextSteps = new Set<number>()
    const childPromise = (async (): Promise<AgentToolResult> => {
      let status: 'completed' | 'failed' | 'interrupted' = 'completed'
      let output = ''
      let error: string | undefined
      try {
        const child = await this.run({
          messages: [{
            role: 'user',
            content: subtaskPrompt(request),
          }],
          signal: controller.signal,
          systemPrompt: parentInput.systemPrompt,
          skills: parentInput.skills,
          maxSteps: Math.min(
            parentInput.maxSteps ?? this.maxSteps,
            this.subtaskMaxSteps,
          ),
          maxModelRetries: parentInput.maxModelRetries,
          toolFailureRecoveryThreshold: parentInput.toolFailureRecoveryThreshold
            ?? parentInput.maxConsecutiveToolFailures,
          toolContext: {
            ...(parentInput.toolContext ?? this.toolContext),
            signal: controller.signal,
            delegationDepth: (parentInput.toolContext?.delegationDepth ?? this.toolContext?.delegationDepth ?? 0) + 1,
            delegateTask: undefined,
          },
          model: parentInput.model,
          temperature: parentInput.temperature,
          maxTokens: parentInput.maxTokens,
          reasoningEffort: parentInput.reasoningEffort,
          reasoningSummary: parentInput.reasoningSummary,
          metadata: {
            ...parentInput.metadata,
            session_id: sessionId ? `${sessionId}:subagent:${subagentId}` : `subagent:${subagentId}`,
            parent_session_id: sessionId,
            parent_run_id: parentRunId,
            subagent_id: subagentId,
          },
          modelClient: parentInput.modelClient,
          modelDefaults: parentInput.modelDefaults,
          contextKey: childContextKey,
          memoryEnabled: false,
          backgroundDelegationEnabled: this.backgroundDelegationFor(parentInput),
          logContext: parentInput.logContext,
          onEvent: (event) => {
            if ('runId' in event) childRunId = event.runId
            if (event.type === 'model.delta') {
              streamedTextSteps.add(event.step)
              emit({
                type: 'subagent.text',
                runId: parentRunId,
                childRunId,
                subagentId,
                goal: request.goal,
                background,
                text: event.text,
              })
            } else if (
              event.type === 'model.message' &&
              event.message.content &&
              !streamedTextSteps.has(event.step)
            ) {
              emit({
                type: 'subagent.text',
                runId: parentRunId,
                childRunId,
                subagentId,
                goal: request.goal,
                background,
                text: event.message.content,
              })
            } else if (event.type === 'model.reasoning' && event.text) {
              emit({
                type: 'subagent.thinking',
                runId: parentRunId,
                childRunId,
                subagentId,
                goal: request.goal,
                background,
                text: event.text,
              })
            } else if (event.type === 'tool.started') {
              toolCount += 1
              emit({
                type: 'subagent.tool',
                runId: parentRunId,
                childRunId,
                subagentId,
                goal: request.goal,
                background,
                toolName: event.toolName,
                arguments: event.arguments,
                toolCount,
              })
            } else if (event.type === 'model.usage') {
              apiCalls += 1
              inputTokens += event.usage.inputTokens || 0
              outputTokens += event.usage.outputTokens || 0
              cacheReadTokens += event.usage.cacheReadTokens || 0
              cacheWriteTokens += event.usage.cacheWriteTokens || 0
              reasoningTokens += event.usage.reasoningTokens || 0
            }
          },
        })
        output = child.output.content || ''
        if (child.output.finishReason === 'max_steps') {
          status = 'failed'
          error = output || `Subtask stopped with ${child.output.finishReason}.`
        }
      } catch (childError) {
        status = controller.signal.aborted || isAbortError(childError) ? 'interrupted' : 'failed'
        error = childError instanceof Error ? childError.message : String(childError)
        output = error
      } finally {
        parentInput.signal?.removeEventListener('abort', abortChild)
        this.modelContexts.delete(childContextKey)
      }

      let continuationContext: EkkoBackgroundContinuationContext | undefined
      if (background && status !== 'interrupted') {
        const captured = await continuationContextReady
        if (captured) {
          continuationContext = captured
        } else {
          status = 'interrupted'
          error = 'Background subtask result was suppressed because its origin context was not captured.'
          output = error
        }
      }
      const summary = subtaskSummary(output, status)
      emit({
        type: 'subagent.complete',
        runId: parentRunId,
        childRunId,
        subagentId,
        goal: request.goal,
        background,
        status,
        summary,
        output,
        outputTail: output.slice(-SUBTASK_OUTPUT_TAIL_CHARS),
        durationMs: Date.now() - startedAt,
        toolCount,
        apiCalls,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
        ...(continuationContext ? { continuationContext } : {}),
      })
      const payload = {
        runtime: 'ekko',
        mode: request.mode,
        subagent_id: subagentId,
        status,
        summary,
        output,
        duration_ms: Date.now() - startedAt,
        tool_count: toolCount,
        api_calls: apiCalls,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
        reasoning_tokens: reasoningTokens,
      }
      return {
        ok: status === 'completed',
        content: JSON.stringify(payload, null, 2),
        data: payload,
        ...(error ? { error } : {}),
      }
    })()

    if (!background) return childPromise

    this.backgroundTasks.set(subagentId, {
      sessionId,
      controller,
      promise: childPromise,
      resolveContinuationContext,
    })
    onBackgroundStarted?.(subagentId)
    void childPromise.then(
      () => this.backgroundTasks.delete(subagentId),
      () => this.backgroundTasks.delete(subagentId),
    )
    const payload = {
      runtime: 'ekko',
      mode: request.mode,
      subagent_id: subagentId,
      status: 'running',
      goal: request.goal,
    }
    return {
      ok: true,
      content: JSON.stringify(payload, null, 2),
      data: payload,
    }
  }

  private registerSkillTools(skills: AgentSkill[]): void {
    if (!this.toolsEnabled || !this.skillsEnabled) return
    for (const skill of skills) {
      if (skill.tools?.length) {
        this.tools.registerMany(skill.tools)
      }
    }
  }

  private areSkillsAvailable(): boolean {
    if (!this.skillsEnabled) return false
    try {
      return this.skillsAvailable?.() !== false
    } catch {
      return false
    }
  }
}

function reconcileMatchedSkillContext(
  messages: AgentMessage[],
  matchedSkills: DiscoveredSkill[],
): DiscoveredSkill[] {
  const matchedNames = new Set(matchedSkills.map(skill => skill.name.toLowerCase()))
  const views = messages.flatMap((message, messageIndex): HistoricalSkillView[] => {
    if (
      message.role !== 'tool' ||
      (message.name !== 'skill_view' && !message.content.startsWith('[skill_view] '))
    ) return []
    const parsed = parseHistoricalSkillView(message.content)
    if (!parsed) return []
    return [{
      ...parsed,
      messageIndex,
      toolCallId: message.toolCallId,
    }]
  })
  const removedMessageIndexes = new Set<number>()
  const removedToolCallIds = new Set<string>()
  const skillsToLoad: DiscoveredSkill[] = []

  const historicalGroups = new Map<string, HistoricalSkillView[]>()
  for (const view of views) {
    if (view.filePath === 'SKILL.md' && matchedNames.has(view.name.toLowerCase())) continue
    const key = `${view.name.toLowerCase()}\0${view.filePath}`
    const group = historicalGroups.get(key) ?? []
    group.push(view)
    historicalGroups.set(key, group)
  }
  for (const group of historicalGroups.values()) {
    for (const duplicate of group.slice(0, -1)) {
      removedMessageIndexes.add(duplicate.messageIndex)
      if (duplicate.toolCallId) removedToolCallIds.add(duplicate.toolCallId)
    }
  }

  for (const skill of matchedSkills) {
    const candidates = views.filter(view => (
      view.filePath === 'SKILL.md' && view.name.toLowerCase() === skill.name.toLowerCase()
    ))
    const expectedHash = skillContentHash(skill.content)
    const reusable = [...candidates].reverse().find(view => (
      view.declaredCharacters === view.body.length &&
      (!view.declaredHash || view.declaredHash === expectedHash) &&
      skillContentHash(view.body) === expectedHash
    ))

    for (const candidate of candidates) {
      if (candidate === reusable) continue
      removedMessageIndexes.add(candidate.messageIndex)
      if (candidate.toolCallId) removedToolCallIds.add(candidate.toolCallId)
    }
    if (!reusable) skillsToLoad.push(skill)
  }

  removeHistoricalSkillViews(messages, removedMessageIndexes, removedToolCallIds)
  return skillsToLoad
}

function skillContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function parseHistoricalSkillView(content: string): Omit<HistoricalSkillView, 'messageIndex' | 'toolCallId'> | null {
  const headerEnd = content.indexOf('\n')
  if (headerEnd < 0) return null
  const header = content.slice(0, headerEnd)
  if (!header.startsWith('[skill_view] ')) return null
  const name = header.match(/\bname=([a-z0-9_-]+)/i)?.[1]
  const filePath = header.match(/\bfile=(\S+)/)?.[1]
  if (!name || !filePath) return null
  const declaredCharacters = Number(header.match(/\((\d+) chars\)/)?.[1])
  const declaredHash = header.match(/\bsha256=([a-f0-9]{64})\b/i)?.[1]?.toLowerCase()
  return {
    name,
    filePath,
    ...(Number.isSafeInteger(declaredCharacters) ? { declaredCharacters } : {}),
    ...(declaredHash ? { declaredHash } : {}),
    body: content.slice(headerEnd + 1),
  }
}

function removeHistoricalSkillViews(
  messages: AgentMessage[],
  removedMessageIndexes: Set<number>,
  removedToolCallIds: Set<string>,
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (removedMessageIndexes.has(index)) {
      messages.splice(index, 1)
      continue
    }
    const message = messages[index]
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue
    const remainingToolCalls = message.toolCalls.filter(call => !removedToolCallIds.has(call.id))
    if (remainingToolCalls.length === message.toolCalls.length) continue
    if (
      remainingToolCalls.length === 0 &&
      !message.content.trim() &&
      !agentReasoningText(message.reasoning).trim() &&
      !message.reasoning?.native &&
      !message.contentParts?.length
    ) {
      messages.splice(index, 1)
      continue
    }
    messages[index] = {
      ...message,
      toolCalls: remainingToolCalls.length ? remainingToolCalls : undefined,
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function normalizeToolCallPreamble(message: AgentOutputMessage): AgentOutputMessage {
  if (!message.toolCalls?.length || !/[:：]\s*$/.test(message.content)) return message
  const trailingWhitespace = message.content.match(/\s*$/)?.[0] || ''
  const body = message.content.slice(0, message.content.length - trailingWhitespace.length)
  const punctuation = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(body) ? '。' : '.'
  return {
    ...message,
    content: `${body.slice(0, -1)}${punctuation}${trailingWhitespace}`,
  }
}

function enterBoundaryModelPhase(
  activeRun: ActiveBoundaryRun,
  externalSignal?: AbortSignal,
): AbortSignal {
  activeRun.phase = 'model'
  activeRun.modelController = new AbortController()
  if (!externalSignal) return activeRun.modelController.signal
  return AbortSignal.any([externalSignal, activeRun.modelController.signal])
}

function abortError(): Error {
  const error = new Error('Run aborted.')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'Run aborted.')
}

function isNonRetryableModelError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'retryable' in error &&
    (error as { retryable?: unknown }).retryable === false,
  )
}

interface DirectoryChangeProbe {
  stop(): Promise<boolean>
}

async function createDirectoryChangeProbe(directory: string): Promise<DirectoryChangeProbe | undefined> {
  const before = await localSkillValidationSignature(directory)
  let changed = false
  let watcher: FSWatcher
  try {
    watcher = watch(directory, { recursive: true, persistent: false }, () => {
      changed = true
    })
  } catch {
    return undefined
  }
  watcher.on('error', () => {
    // An uncertain watcher result should fall back to one post-command scan.
    changed = true
  })
  return {
    async stop() {
      // Let filesystem events queued by the child process close reach the
      // watcher before deciding whether validation is necessary.
      await new Promise<void>(resolveStop => setImmediate(resolveStop))
      watcher.close()
      if (changed) return true
      const after = await localSkillValidationSignature(directory)
      return before !== undefined && after !== undefined && before !== after
    },
  }
}

async function localSkillValidationSignature(directory: string): Promise<string | undefined> {
  try {
    const issues = await inspectLocalSkillValidationIssues(directory)
    return JSON.stringify(issues.map(issue => ({
      directory: issue.directory,
      status: issue.status,
      sha256: issue.sha256,
      error: issue.error,
    })))
  } catch {
    return undefined
  }
}

function terminalCallReferencesSkillDirectory(
  input: Record<string, unknown>,
  skillDirectory?: string,
): boolean {
  const target = normalizedPathText(skillDirectory)
  if (!target) return false
  return stringLeaves(input).some(value => normalizedPathText(value).includes(target))
}

function normalizedPathText(value: unknown): string {
  const normalized = String(value || '').trim().replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function stringLeaves(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object' || seen.has(value)) return []
  seen.add(value)
  return Object.values(value as Record<string, unknown>)
    .flatMap(child => stringLeaves(child, seen))
}

function appendStructuredData(
  data: unknown,
  key: string,
  value: unknown,
): Record<string, unknown> {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), [key]: value }
  }
  return {
    ...(data === undefined ? {} : { result: data }),
    [key]: value,
  }
}

function subtaskPrompt(request: AgentTaskRequest): string {
  return [
    `Complete this delegated task independently:\n${request.goal}`,
    request.context ? `Relevant context:\n${request.context}` : '',
    'Return a concise result that the parent agent can use directly.',
  ].filter(Boolean).join('\n\n')
}

function subtaskSummary(output: string, status: 'completed' | 'failed' | 'interrupted'): string {
  const normalized = output.replace(/\s+/g, ' ').trim()
  if (normalized) return normalized.slice(0, SUBTASK_SUMMARY_CHARS)
  if (status === 'interrupted') return 'Subtask interrupted.'
  if (status === 'failed') return 'Subtask failed.'
  return 'Subtask completed.'
}

function isEmptyModelResponse(response: ModelResponse | AgentOutputMessage): boolean {
  return (
    !response.content?.trim() &&
    !agentReasoningText(response.reasoning).trim() &&
    !(response.toolCalls?.length)
  )
}

function estimateModelRequestContext(request: ModelRequest): AgentRuntimeContextEstimate {
  const systemMessages = request.messages.filter(message => message.role === 'system')
  const nonSystemMessages = request.messages.filter(message => message.role !== 'system')
  const systemPrompt = systemMessages.map(message => message.content || '').join('\n\n')
  const systemPromptTokens = countTextTokens(systemPrompt)
  const messageTokens = nonSystemMessages.reduce((sum, message) => {
    const estimatedReasoningTokens = agentReasoningEstimatedTokens(message.reasoning)
    const reasoningTokens = estimatedReasoningTokens !== undefined && estimatedReasoningTokens > 0
      ? estimatedReasoningTokens
      : countTextTokens(agentReasoningText(message.reasoning))
    return sum +
      countTextTokens(message.content || '') +
      reasoningTokens +
      countTextTokens(JSON.stringify(message.toolCalls || ''))
  }, 0)
  const toolTokens = countTextTokens(JSON.stringify(request.tools || []))
  const modelContextTokens = request.context == null ? 0 : countTextTokens(JSON.stringify(request.context))

  return {
    contextTokens: systemPromptTokens + messageTokens + toolTokens + modelContextTokens,
    systemPromptTokens,
    messageTokens,
    toolTokens,
    modelContextTokens,
    messageCount: request.messages.length,
    toolCount: request.tools?.length || 0,
    systemPromptChars: systemPrompt.length,
  }
}

function toMemoryCaptureMessage(message: AgentMessage): MemoryCaptureMessage {
  return {
    role: message.role,
    content: message.content,
  }
}

function completedMemoryCaptureMessages(
  inputs: NonNullable<AgentRuntimeRunInput['memoryInput']>['messages'],
  completedMessages: AgentMessage[],
  origin?: MemoryOrigin,
): MemoryCaptureMessage[] {
  const trusted = normalizeMemoryEvidenceMessages(inputs, origin)
  const finalAssistant = [...completedMessages].reverse()
    .find(message => message.role === 'assistant' && message.content.trim())
  return finalAssistant
    ? [...trusted, withMemoryOrigin(toMemoryCaptureMessage(finalAssistant), origin)]
    : trusted
}

function withMemoryOrigin(
  message: MemoryCaptureMessage,
  origin: MemoryOrigin | undefined,
): MemoryCaptureMessage {
  if (!origin) return message
  return {
    ...message,
    metadata: {
      ...message.metadata,
      memoryOrigin: origin,
    },
  }
}

function normalizeMemoryEvidenceMessages(
  inputs: NonNullable<AgentRuntimeRunInput['memoryInput']>['messages'],
  origin: MemoryOrigin | undefined,
): MemoryCaptureMessage[] {
  return inputs.flatMap(input => {
    const normalized = normalizeAgentMessage(input)
    if (normalized.role !== 'user' && normalized.role !== 'assistant') return []
    const evidence = input && typeof input === 'object' && !Array.isArray(input)
      ? input as MemoryEvidenceMessageInput
      : undefined
    return [withMemoryOrigin({
      ...toMemoryCaptureMessage(normalized),
      ...(evidence?.id ? { id: evidence.id } : {}),
      ...(evidence?.metadata ? { metadata: evidence.metadata } : {}),
      ...(evidence?.createdAt ? { createdAt: evidence.createdAt } : {}),
    }, origin)]
  })
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
