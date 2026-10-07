import { bridgeLogger } from '../../public/logging'
import { normalizeTokenUsage, recordSessionUsage } from './usage-recorder'

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function recordBridgeModelUsage(
  sessionId: string,
  bridgeRunId: string,
  event: Record<string, unknown>,
  profile: string,
  modelContext: { model?: string | null; provider?: string | null },
): void {
  const usage = normalizeTokenUsage(event.usage)
  if (usage.isEstimated) {
    bridgeLogger.warn({
      sessionId,
      bridgeRunId,
      apiRequestId: event.api_request_id,
    }, '[chat-run-socket] ignoring incomplete Hermes model usage event')
    return
  }

  const apiRequestId = stringValue(event.api_request_id)
  const turnId = stringValue(event.turn_id)
  const apiCallCount = Number(event.api_call_count)
  const fallbackId = turnId && Number.isFinite(apiCallCount)
    ? `${turnId}:${Math.max(0, Math.floor(apiCallCount))}`
    : ''
  const requestKey = apiRequestId || fallbackId
  if (!requestKey) {
    bridgeLogger.warn({ sessionId, bridgeRunId }, '[chat-run-socket] ignoring Hermes model usage event without request identity')
    return
  }

  recordSessionUsage({
    sessionId,
    runId: `${bridgeRunId}:api:${requestKey}`,
    parentRunId: bridgeRunId,
    apiDuration: typeof event.api_duration === 'number' ? event.api_duration : undefined,
    source: 'hermes',
    agent: 'hermes',
    usageScope: 'model_call',
    apiCalls: 1,
    usage: event.usage,
    model: stringValue(event.model) || modelContext.model,
    provider: stringValue(event.provider) || modelContext.provider,
    baseUrl: stringValue(event.base_url) || undefined,
    profile,
    isEstimated: false,
  })
}
