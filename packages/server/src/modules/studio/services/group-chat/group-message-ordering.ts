export interface CanonicalGroupMessage {
    id: string
    timestamp: number
}

export interface GroupMessageCursorCutoff {
    throughMessageId?: string
    afterMessageId?: string
}

export interface GroupMessageCursorSlice<T extends CanonicalGroupMessage> {
    messages: T[]
    throughMessageFound: boolean
    afterMessageFound: boolean
}

export interface GroupSnapshotTailSlice<T extends CanonicalGroupMessage> {
    messages: T[]
    snapshotCursorFound: boolean
}

export interface GroupMessagePaginationOptions {
    limit?: number
    offset?: number
}

export function groupRunOrder(id: string): { baseId: string; phase: number } {
    const value = String(id || '')
    const partMatch = value.match(/^(.*)_part_(\d+)(?:_(toolcall|toolresult)_.+)?$/)
    if (partMatch) {
        const part = Number(partMatch[2] || 0)
        const kind = partMatch[3] || 'assistant'
        const offset = kind === 'toolcall' ? 1 : kind === 'toolresult' ? 2 : 0
        return { baseId: partMatch[1], phase: part * 3 + offset }
    }
    const toolIdx = value.indexOf('_toolcall_')
    if (toolIdx >= 0) return { baseId: value.slice(0, toolIdx), phase: 0 }
    const resultIdx = value.indexOf('_toolresult_')
    if (resultIdx >= 0) return { baseId: value.slice(0, resultIdx), phase: 1 }
    return { baseId: value, phase: 2 }
}

function compareStorageIds(a: string, b: string): number {
    // SQLite's default BINARY collation compares the UTF-8 bytes stored in
    // TEXT values. JavaScript relational comparison uses UTF-16 code units,
    // which disagrees for supplementary-plane characters versus some BMP
    // characters and can make SQL cursor prefilters silently drop messages.
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

export function sortGroupMessagesCanonical<T extends CanonicalGroupMessage>(messages: readonly T[]): T[] {
    const baseMinTimestamp = new Map<string, number>()
    for (const msg of messages) {
        const { baseId } = groupRunOrder(msg.id)
        const existing = baseMinTimestamp.get(baseId)
        if (existing == null || msg.timestamp < existing) baseMinTimestamp.set(baseId, msg.timestamp)
    }
    return [...messages].sort((a, b) => {
        const ao = groupRunOrder(a.id)
        const bo = groupRunOrder(b.id)
        const at = baseMinTimestamp.get(ao.baseId) ?? a.timestamp
        const bt = baseMinTimestamp.get(bo.baseId) ?? b.timestamp
        if (at !== bt) return at - bt
        if (ao.baseId !== bo.baseId) return compareStorageIds(ao.baseId, bo.baseId)
        if (ao.phase !== bo.phase) return ao.phase - bo.phase
        if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
        return compareStorageIds(a.id, b.id)
    })
}

export function sliceGroupMessagesCanonical<T extends CanonicalGroupMessage>(
    messages: readonly T[],
    cutoff?: GroupMessageCursorCutoff,
): GroupMessageCursorSlice<T> {
    const ordered = sortGroupMessagesCanonical(messages)
    let throughMessageFound = !cutoff?.throughMessageId
    let afterMessageFound = !cutoff?.afterMessageId
    let sliced = ordered

    if (cutoff?.throughMessageId) {
        const throughIdx = ordered.findIndex(message => message.id === cutoff.throughMessageId)
        if (throughIdx >= 0) {
            throughMessageFound = true
            sliced = ordered.slice(0, throughIdx + 1)
        }
    }

    if (cutoff?.afterMessageId) {
        const afterIdx = sliced.findIndex(message => message.id === cutoff.afterMessageId)
        if (afterIdx >= 0) {
            afterMessageFound = true
            sliced = sliced.slice(afterIdx + 1)
        }
    }

    return {
        messages: sliced,
        throughMessageFound,
        afterMessageFound,
    }
}

/**
 * Resolve the verbatim transcript tail that should follow a persisted summary snapshot.
 *
 * If the cursor anchor is still present, we keep only messages strictly after it. If the
 * anchor is missing, it was likely pruned while the summary remained persisted. In that case
 * the summary is still valid for the older conversation, but the exact incremental boundary is
 * gone, so we conservatively treat the entire retained transcript as the verbatim post-summary
 * tail. We intentionally do not guess with timestamp fallbacks.
 */
export function sliceGroupMessagesForSnapshotTail<T extends CanonicalGroupMessage>(
    messages: readonly T[],
    snapshotLastMessageId: string,
): GroupSnapshotTailSlice<T> {
    const slice = sliceGroupMessagesCanonical(messages, { afterMessageId: snapshotLastMessageId })
    return {
        messages: slice.messages,
        snapshotCursorFound: slice.afterMessageFound,
    }
}

/**
 * Return a recent UI page in canonical order without splitting grouped assistant/tool events.
 *
 * Pagination remains offset-from-newest for compatibility with the previous SQL query, but the
 * page boundaries are expanded to include every message sharing the boundary messages' grouped
 * run base id. This can return slightly more than `limit` rows when the boundary crosses a
 * multipart assistant/toolcall/toolresult group, which is preferable to rendering broken runs.
 */
export function paginateRecentGroupMessagesCanonical<T extends CanonicalGroupMessage>(
    messages: readonly T[],
    options: GroupMessagePaginationOptions = {},
): T[] {
    const limit = Math.max(0, Math.floor(Number(options.limit ?? 150)))
    const offset = Math.max(0, Math.floor(Number(options.offset ?? 0)))
    if (limit === 0) return []

    const ordered = sortGroupMessagesCanonical(messages)
    const rawEnd = Math.max(0, ordered.length - offset)
    if (rawEnd === 0) return []

    let start = Math.max(0, rawEnd - limit)
    let end = rawEnd

    if (start < end) {
        const startBase = groupRunOrder(ordered[start].id).baseId
        while (start > 0 && groupRunOrder(ordered[start - 1].id).baseId === startBase) start--

        const endBase = groupRunOrder(ordered[end - 1].id).baseId
        while (end < ordered.length && groupRunOrder(ordered[end].id).baseId === endBase) end++
    }

    return ordered.slice(start, end)
}
