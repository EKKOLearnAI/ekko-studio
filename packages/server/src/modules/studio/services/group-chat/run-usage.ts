import { createHash } from 'node:crypto'
import type { RunUsageSummary } from '../../contracts/runs/run-usage'

export function parseGroupRunUsage(value: unknown): RunUsageSummary | null {
    try {
        const raw = typeof value === 'string' ? JSON.parse(value) : value
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)
            || typeof raw.runId !== 'string' || !raw.runId || raw.runId.length > 500) return null
        const metric = (key: string): number | null => typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0 ? raw[key] : null
        const rate = metric('cacheHitRate')
        return { runId: raw.runId, assistantMessageId: String(raw.assistantMessageId || ''),
            inputTokens: metric('inputTokens'), outputTokens: metric('outputTokens'), cacheReadTokens: metric('cacheReadTokens'),
            cacheHitRate: rate != null && rate <= 1 ? rate : null, costUsd: metric('costUsd'), tokensPerSecond: metric('tokensPerSecond'),
            speedSource: ['model', 'estimated', 'run'].includes(raw.speedSource) ? raw.speedSource : null,
            isEstimated: raw.isEstimated === true }
    } catch { return null }
}

/** Persist display metadata through the same transport as task cards, including remote Agents. */
export function groupRunUsageMessage(roomId: string, sessionId: string, runId: string, messageId: string, value: unknown) {
    const usage = parseGroupRunUsage(value)
    if (!usage) return null
    const id = 'gcusage_' + createHash('sha256').update(JSON.stringify([roomId, sessionId, runId])).digest('hex')
    return { id, content: JSON.stringify({ ...usage, runId, assistantMessageId: messageId }), extra: {
        role: 'tool', tool_name: 'run_usage', tool_call_id: id, run_id: runId,
    } }
}
