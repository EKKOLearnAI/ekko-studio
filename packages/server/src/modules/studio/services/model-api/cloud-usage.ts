import { randomUUID } from 'node:crypto'
import type { RecordedUsage } from '../usage/usage-recorder'

export interface CloudModelUsage {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
  costUsd: number | null
  costSource: 'reported' | 'estimated' | 'unknown'
}

type Receipt = { userId: number; keyId: string; report: (usage: RecordedUsage) => void }
const receipts = new Map<string, Receipt>()

// Only the bridge knows this one-use token. A caller-controlled request ID or
// header must not be able to attach ordinary local calls to a cloud ledger row.
export function issueCloudUsageReceipt(userId: number, keyId: string, send: (usage: CloudModelUsage) => void) {
  if (receipts.size >= 32) throw new Error('cloud_usage_capacity_exceeded')
  const token = randomUUID()
  receipts.set(token, { userId, keyId, report: value => {
    send({
      inputTokens: value.isEstimated ? null : value.inputTokens,
      outputTokens: value.isEstimated ? null : value.outputTokens,
      cacheReadTokens: value.isEstimated ? null : value.cacheReadTokens,
      cacheWriteTokens: value.isEstimated ? null : value.cacheWriteTokens,
      reasoningTokens: value.isEstimated ? null : value.reasoningTokens,
      costUsd: value.costUsd ?? null, costSource: value.costSource || 'unknown',
    })
  } })
  return { token, dispose: () => { receipts.delete(token) } }
}

export function claimCloudUsageReceipt(token: string, userId: number | undefined, keyId: string | undefined) {
  const receipt = receipts.get(token)
  if (!receipt || receipt.userId !== userId || receipt.keyId !== keyId) return undefined
  receipts.delete(token)
  return receipt.report
}
