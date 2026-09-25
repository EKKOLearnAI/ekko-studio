import type { ModelClient, ModelRequest, ModelResponse } from '../model/types'
import { agentReasoningText } from '../model/messages'
import type { EkkoLogWriter } from './file-logger'
import type { EkkoJevDiagnostic } from '../jev/client'

export interface EkkoRuntimeLogContext {
  profile?: string
  sessionId?: string
  turnId?: string
}

export interface EkkoModelRequestLogInput {
  client: ModelClient
  request: ModelRequest
  runId: string
  step?: number
  attempt: number
  maxAttempts: number
  transport: 'stream' | 'create'
  purpose?: string
  operationId?: string
  fallback?: boolean
  context?: EkkoRuntimeLogContext
}

export interface EkkoModelRequestSpan {
  complete(response: ModelResponse, extra?: Record<string, unknown>): void
  fail(error: unknown): void
}

/**
 * Writes one compact record for each model-client request attempt.
 *
 * General runtime events are not persisted; optional JEV writes compact stage summaries.
 * A model request writes exactly one
 * terminal record (completed or failed), so streaming and tool events cannot
 * multiply file volume.
 */
export class EkkoRuntimeLogger {
  constructor(
    private readonly writer: EkkoLogWriter,
    private readonly defaultContext: EkkoRuntimeLogContext = {},
  ) {}

  memoryJev(runId: string, diagnostic: EkkoJevDiagnostic, inputContext?: EkkoRuntimeLogContext): void {
    const context = { ...this.defaultContext, ...inputContext }
    try {
      this.writer.write({ category: 'memory', event: 'memory.jev', level: 'info', runId,
        profile: context.profile, sessionId: context.sessionId, turnId: context.turnId,
        data: { ...diagnostic } })
    } catch { /* Diagnostics must never change memory execution. */ }
  }

  skillJev(runId: string, diagnostic: EkkoJevDiagnostic, inputContext?: EkkoRuntimeLogContext): void {
    const context = { ...this.defaultContext, ...inputContext }
    try {
      this.writer.write({ category: 'skill', event: 'skill.jev', level: 'info', runId,
        profile: context.profile, sessionId: context.sessionId, turnId: context.turnId,
        data: { ...diagnostic } })
    } catch { /* Diagnostics must never change skill execution. */ }
  }

  startModelRequest(input: EkkoModelRequestLogInput): EkkoModelRequestSpan {
    const startedAt = Date.now()
    const context = { ...this.defaultContext, ...input.context }
    let common: Record<string, unknown>
    try {
      common = requestSummary(input)
    } catch {
      common = {
        step: input.step,
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
        transport: input.transport,
        provider: input.client.provider,
        requestStyle: input.client.requestStyle,
        model: input.request.model,
      }
    }
    let ended = false

    const write = (
      level: 'info' | 'error',
      status: 'completed' | 'failed',
      data: Record<string, unknown>,
    ) => {
      try {
        this.writer.write({
          category: 'model',
          event: 'model.request',
          level,
          profile: context.profile,
          sessionId: context.sessionId,
          runId: input.runId,
          turnId: context.turnId,
          data: {
            ...common,
            status,
            durationMs: Date.now() - startedAt,
            ...data,
          },
        })
      } catch {
        // Diagnostics must never change model execution.
      }
    }

    return {
      complete: (response, extra = {}) => {
        if (ended) return
        ended = true
        write('info', 'completed', {
          responseId: response.id,
          responseModel: response.model,
          finishReason: response.finishReason,
          outputChars: response.content.length,
          reasoningChars: agentReasoningText(response.reasoning).length,
          toolCallCount: response.toolCalls?.length || 0,
          usage: response.usage,
          ...extra,
        })
      },
      fail: (error) => {
        if (ended) return
        ended = true
        write('error', 'failed', {
          error: errorSummary(error),
        })
      },
    }
  }
}

function requestSummary(input: EkkoModelRequestLogInput): Record<string, unknown> {
  const request = input.request
  const purpose = input.purpose || metadataString(request.metadata, 'purpose') || 'agent'
  return {
    step: input.step,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    transport: input.transport,
    fallback: input.fallback || undefined,
    purpose,
    operationId: input.operationId,
    provider: input.client.provider,
    requestStyle: input.client.requestStyle,
    endpoint: safeRequestTarget(input.client.requestTarget?.(request)),
    model: request.model,
    messageCount: request.messages.length,
    messageRoles: roleCounts(request),
    messageChars: request.messages.reduce((total, message) => total + message.content.length, 0),
    imageCount: request.messages.reduce(
      (total, message) => total + (message.contentParts?.filter(part => part.type === 'image').length || 0),
      0,
    ),
    toolCount: request.tools?.length || 0,
    maxTokens: request.maxTokens,
    reasoningEffort: request.reasoningEffort,
    reasoningSummary: request.reasoningSummary,
  }
}

function roleCounts(request: ModelRequest): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const message of request.messages) {
    counts[message.role] = (counts[message.role] || 0) + 1
  }
  return counts
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function safeRequestTarget(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    url.username = url.username ? '[REDACTED]' : ''
    url.password = url.password ? '[REDACTED]' : ''
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:api[_-]?key|key|token|secret|password|auth|credential|signature|sig)/i.test(key)) {
        url.searchParams.set(key, '[REDACTED]')
      }
    }
    return url.toString()
  } catch {
    return value.replace(
      /([?&](?:api[_-]?key|key|token|access_token|secret|password|auth|credential|signature|sig)=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
  }
}

function errorSummary(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) }
  const details = error as Error & { statusCode?: unknown; retryable?: unknown }
  return {
    name: error.name,
    message: error.message,
    statusCode: details.statusCode,
    retryable: details.retryable,
  }
}
