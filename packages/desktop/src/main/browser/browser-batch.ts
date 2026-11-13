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
      click: ['action', 'ref'], double_click: ['action', 'ref'], right_click: ['action', 'ref'], type: ['action', 'ref', 'text'],
      hover: ['action', 'ref'], select: ['action', 'ref', 'value'], drag: ['action', 'ref', 'target_ref'],
      press: ['action', 'key'], scroll: ['action', 'direction', 'pixels'],
      click_at: ['action', 'x', 'y', 'button', 'click_count'], drag_at: ['action', 'x', 'y', 'to_x', 'to_y'],
    }
    const allowed = typeof row.action === 'string' && Object.hasOwn(fields, row.action) ? fields[row.action] : undefined
    if (!allowed || Object.keys(row).some(key => !allowed.includes(key))) throw invalid()
    const isRef = (value: unknown): value is string => typeof value === 'string' && /^@e[1-9]\d*$/.test(value) && value.length <= 32
    const coordinate = (value: unknown): number => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000) throw invalid()
      return value
    }
    switch (row.action) {
      case 'click':
      case 'double_click':
      case 'right_click':
      case 'type':
      case 'hover':
      case 'select':
      case 'drag': {
        if (!isRef(row.ref)) throw invalid()
        if (row.action === 'type') {
          if (typeof row.text !== 'string' || row.text.length > 100_000) throw invalid()
          return { action: 'type', ref: row.ref, text: row.text }
        }
        if (row.action === 'select') {
          if (typeof row.value !== 'string' || row.value.length > 1000) throw invalid()
          return { action: 'select', ref: row.ref, value: row.value }
        }
        if (row.action === 'drag') {
          if (!isRef(row.target_ref)) throw invalid()
          return { action: 'drag', ref: row.ref, target_ref: row.target_ref }
        }
        return { action: row.action, ref: row.ref }
      }
      case 'press':
        if (typeof row.key !== 'string' || !row.key.trim() || row.key.length > 64) throw invalid()
        return { action: 'press', key: row.key }
      case 'scroll':
        if (!['up', 'down', 'left', 'right'].includes(String(row.direction))) throw invalid()
        if (row.pixels !== undefined && (typeof row.pixels !== 'number' || !Number.isFinite(row.pixels) || row.pixels < 1 || row.pixels > 10_000)) throw invalid()
        return { action: 'scroll', direction: row.direction as 'up' | 'down' | 'left' | 'right', ...(row.pixels === undefined ? {} : { pixels: row.pixels as number }) }
      case 'click_at': {
        if (row.button !== undefined && !['left', 'right', 'middle'].includes(String(row.button))) throw invalid()
        if (row.click_count !== undefined && row.click_count !== 1 && row.click_count !== 2) throw invalid()
        return {
          action: 'click_at', x: coordinate(row.x), y: coordinate(row.y),
          ...(row.button === undefined ? {} : { button: row.button as 'left' | 'right' | 'middle' }),
          ...(row.click_count === undefined ? {} : { click_count: row.click_count as number }),
        }
      }
      case 'drag_at':
        return { action: 'drag_at', x: coordinate(row.x), y: coordinate(row.y), to_x: coordinate(row.to_x), to_y: coordinate(row.to_y) }
      default:
        throw invalid()
    }
  })
}
