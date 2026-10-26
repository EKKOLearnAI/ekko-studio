import type { ManagedCodingAgentRun } from '../runtime/run-manager'
import type { OpenCodeTurnHost } from './turn-host'
import { updateSession } from '../../../studio/public/sessions'
import { logger } from '../../../studio/public/logging'
import { normalizeTokenUsage, normalizeUsageCost, recordSessionUsage } from '../../../studio/public/usage'
import { readOpenCodeMessageModel } from './model'

export function applyOpenCodeLine(run: ManagedCodingAgentRun, line: string, host: OpenCodeTurnHost) {
  const trimmed = line.trim()
  if (!trimmed || run.printCompleted) return
  let event: any
  try {
    event = JSON.parse(trimmed)
  } catch {
    logger.debug({ runId: run.id, line: host.sanitizeOutput(trimmed) }, '[coding-agent-run] ignored non-json OpenCode line')
    return
  }
  const nativeSessionId = String(event.sessionID || event.session_id || '').trim()
  if (nativeSessionId) recordOpenCodeNativeSessionId(run, nativeSessionId)
  if (event.type === 'error') {
    host.fail(host.errorMessage(event.error) || 'OpenCode run failed')
    return
  }
  const part = event.part
  if (!part || typeof part !== 'object') return
  if (event.type === 'step_finish' && part.type === 'step-finish') {
    // Scoped runs already record each provider call through the proxy.
    // Native global runs report usage only in their completed step parts.
    if (run.launch.mode === 'global' && part.id && part.tokens) {
      const tokens = part.tokens
      const usage = normalizeTokenUsage({
        inputTokens: tokens.input,
        // OpenCode separates reasoning from output; Studio includes it.
        outputTokens: typeof tokens.output === 'number'
          ? tokens.output + (Number(tokens.reasoning) || 0)
          : undefined,
        cacheReadTokens: tokens.cache?.read,
        cacheWriteTokens: tokens.cache?.write,
        reasoningTokens: tokens.reasoning,
      })
      if (!usage.isEstimated) {
        const nativeModel = readOpenCodeMessageModel(run.launch.env?.OPENCODE_DB, nativeSessionId || run.launch.agentNativeSessionId || '', String(part.messageID || ''))
        if (nativeModel && run.nativeUsage) Object.assign(run.nativeUsage, nativeModel)
        recordSessionUsage({
          sessionId: run.launch.sessionId,
          runId: String(part.id),
          parentRunId: run.usageRunId || run.id,
          source: 'coding_agent',
          agent: 'opencode',
          usageScope: 'model_call',
          apiCalls: 1,
          usage,
          profile: run.launch.profile,
          cost: normalizeUsageCost(part, 'estimated'),
          model: nativeModel?.model || run.launch.model,
          provider: nativeModel?.provider || run.launch.provider,
          isEstimated: false,
        })
      }
    }
    return
  }
  if (event.type === 'text' && part.type === 'text') {
    const text = String(part.text || '')
    if (!text) return
    host.ensureText()
    const delta = host.appendedTextDelta(run.printText || '', text)
    if (!delta) return
    run.printText = `${run.printText || ''}${delta}`
    host.response({
      type: 'response.output_text.delta',
      data: {
        type: 'response.output_text.delta',
        item_id: run.printMessageId,
        output_index: 0,
        content_index: 0,
        delta,
      },
    })
    return
  }
  if (event.type === 'reasoning' && part.type === 'reasoning' && part.text) {
    host.response({
      type: 'response.reasoning.delta',
      data: {
        type: 'response.reasoning.delta',
        item_id: run.printMessageId,
        output_index: 0,
        delta: String(part.text),
      },
    })
    return
  }
  if (event.type !== 'tool_use' || part.type !== 'tool') return
  const state = part.state || {}
  const callId = String(part.callID || part.callId || part.id || `opencode_tool_${Date.now()}`)
  run.usageToolTiming?.recordWallInterval(callId, state.time?.start, state.time?.end)
  const name = String(part.tool || 'tool')
  const argumentsJson = JSON.stringify(state.input || {})
  host.response({
    type: 'response.output_item.done',
    data: {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'function_call', id: callId, call_id: callId, name, arguments: argumentsJson },
    },
  })
  host.response({
    type: 'response.output_item.done',
    data: {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call_output',
        id: callId,
        call_id: callId,
        output: host.truncateToolOutput(state.output || state.error || ''),
        ...(state.status === 'error' ? { status: 'failed' } : {}),
      },
    },
  })
}

function recordOpenCodeNativeSessionId(run: ManagedCodingAgentRun, nativeSessionId: string) {
  if (!nativeSessionId) return
  run.launch.agentNativeSessionId = nativeSessionId
  run.nativeResumeReady = true
  try {
    updateSession(run.launch.sessionId, { agent_native_session_id: nativeSessionId })
  } catch (err) {
    logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] failed to persist OpenCode session id')
  }
}
