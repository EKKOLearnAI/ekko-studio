import type { BrowserBatchAction } from './browser-types'

export const MAX_BROWSER_BATCH_ACTIONS = 50
export const BROWSER_BATCH_TIMEOUT_MS = 30_000

// Validate the entire request before any page interaction takes place.
export function parseBrowserBatchActions(value: unknown): BrowserBatchAction[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BROWSER_BATCH_ACTIONS) {
    throw new Error(`actions must contain 1 to ${MAX_BROWSER_BATCH_ACTIONS} browser actions`)
  }
  return value.map((item, index) => {
    const invalid = () => new Error(`Invalid browser batch action at index ${index}`)
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid()
    const row = item as Record<string, unknown>
    const fields: Record<string, string[]> = {
      click: ['action', 'ref'], type: ['action', 'ref', 'text'],
      press: ['action', 'key'], scroll: ['action', 'direction', 'pixels'],
    }
    const allowed = typeof row.action === 'string' && Object.hasOwn(fields, row.action) ? fields[row.action] : undefined
    if (!allowed || Object.keys(row).some(key => !allowed.includes(key))) throw invalid()
    switch (row.action) {
      case 'click':
      case 'type': {
        if (typeof row.ref !== 'string' || !/^@e[1-9]\d*$/.test(row.ref) || row.ref.length > 32) throw invalid()
        if (row.action === 'click') return { action: 'click', ref: row.ref }
        if (typeof row.text !== 'string' || row.text.length > 100_000) throw invalid()
        return { action: 'type', ref: row.ref, text: row.text }
      }
      case 'press':
        if (typeof row.key !== 'string' || !row.key.trim() || row.key.length > 64) throw invalid()
        return { action: 'press', key: row.key }
      case 'scroll':
        if (!['up', 'down', 'left', 'right'].includes(String(row.direction))) throw invalid()
        if (row.pixels !== undefined && (typeof row.pixels !== 'number' || !Number.isFinite(row.pixels) || row.pixels < 1 || row.pixels > 10_000)) throw invalid()
        return { action: 'scroll', direction: row.direction as 'up' | 'down' | 'left' | 'right', ...(row.pixels === undefined ? {} : { pixels: row.pixels as number }) }
      default:
        throw invalid()
    }
  })
}
