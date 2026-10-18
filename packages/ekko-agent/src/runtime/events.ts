import type { AgentOutputMessage } from '../model/messages'
import type { AgentToolCall, ModelUsage } from '../model/types'
import type { AgentToolResult } from '../tools/types'
import type { AgentRuntimeContextEstimate, EkkoBackgroundContinuationContext } from './types'
import type { MemoryContextDiagnostics } from '../memory/types'

export type AgentRuntimeEvent =
  | { type: 'plan.updated'; runId: string; plan: import('../tools/plan').AgentTaskPlan }
  | { type: 'run.started'; runId: string; maxSteps: number }
  | { type: 'memory.retrieved'; runId: string; diagnostics: MemoryContextDiagnostics; memoryIds: string[] }
  | { type: 'skill.review.started'; runId: string; reviewId: string }
  | { type: 'skill.review.completed'; runId: string; reviewId: string; mutations: number }
  | { type: 'skill.review.failed'; runId: string; reviewId: string; error: string }
  | { type: 'model.started'; runId: string; step: number }
  | { type: 'context.estimated'; runId: string; step: number; estimate: AgentRuntimeContextEstimate }
  | { type: 'model.retry'; runId: string; step: number; retry: number; maxRetries: number; error: string }
  | { type: 'model.message'; runId: string; step: number; message: AgentOutputMessage }
  | { type: 'model.delta'; runId: string; step: number; text: string }
  | { type: 'model.reasoning'; runId: string; step: number; text: string }
  | { type: 'model.tool_call'; runId: string; step: number; toolCall: AgentToolCall }
  | { type: 'model.usage'; runId: string; step: number; usage: ModelUsage }
  | { type: 'model.context'; runId: string; step: number; context: unknown }
  | { type: 'tool.started'; runId: string; step: number; toolCallId: string; toolName: string; arguments: Record<string, unknown> }
  | { type: 'tool.completed'; runId: string; step: number; toolCallId: string; toolName: string; result: AgentToolResult; durationMs: number }
  | { type: 'tool.failed'; runId: string; step: number; toolCallId: string; toolName: string; result: AgentToolResult; durationMs: number }
  | { type: 'subagent.start'; runId: string; subagentId: string; goal: string; background: boolean; model?: string; startedAt: number }
  | { type: 'subagent.text'; runId: string; childRunId?: string; subagentId: string; goal: string; background: boolean; text: string }
  | { type: 'subagent.thinking'; runId: string; childRunId?: string; subagentId: string; goal: string; background: boolean; text: string }
  | { type: 'subagent.tool'; runId: string; childRunId?: string; subagentId: string; goal: string; background: boolean; toolName: string; arguments: Record<string, unknown>; toolCount: number }
  | {
      type: 'subagent.complete'
      runId: string
      childRunId?: string
      subagentId: string
      goal: string
      background: boolean
      status: 'completed' | 'failed' | 'interrupted'
      summary: string
      output: string
      outputTail: string
      durationMs: number
      toolCount: number
      apiCalls: number
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
      reasoningTokens: number
      costUsd?: number
      costSource?: 'reported' | 'estimated'
      continuationContext?: EkkoBackgroundContinuationContext
    }
  | { type: 'run.tool_recovery_required'; runId: string; toolName: string; failures: number }
  | { type: 'run.completed'; runId: string; output: AgentOutputMessage; steps: number; context?: unknown; contextEstimate?: AgentRuntimeContextEstimate }
  | { type: 'run.failed'; runId: string; error: string; steps: number }
  | { type: 'run.max_steps'; runId: string; maxSteps: number }
