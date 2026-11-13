import type { SummaryCacheEntry } from '../types'

const MAX_ENTRIES = 200

export class SummaryCache {
    private cache = new Map<string, SummaryCacheEntry>()
    private ttlMs: number

    constructor(ttlMs = 120_000) {
        this.ttlMs = ttlMs
    }

    get(roomId: string): SummaryCacheEntry | undefined {
        const entry = this.cache.get(roomId)
        if (!entry) return undefined
        if (Date.now() - entry.createdAt >= this.ttlMs) {
            this.cache.delete(roomId)
            return undefined
        }
        return entry
    }

    set(roomId: string, entry: SummaryCacheEntry): void {
        if (this.cache.size >= MAX_ENTRIES) {
            let oldestKey = ''
            let oldestTime = Infinity
            for (const [k, v] of this.cache) {
                if (v.createdAt < oldestTime) {
                    oldestTime = v.createdAt
                    oldestKey = k
                }
            }
            if (oldestKey) this.cache.delete(oldestKey)
        }
        this.cache.set(roomId, entry)
    }

    invalidate(roomId: string): void {
        this.cache.delete(roomId)
    }

    clear(): void {
        this.cache.clear()
    }

    get size(): number {
        return this.cache.size
    }
}
