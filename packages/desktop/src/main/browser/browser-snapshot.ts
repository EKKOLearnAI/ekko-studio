import type { BrowserSnapshotNode, BrowserSnapshotOptions } from './browser-types'

export const DEFAULT_SNAPSHOT_LIMIT = 100
export const MAX_SNAPSHOT_LIMIT = 300

const INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'checkbox', 'radio', 'switch', 'textbox',
  'searchbox', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'slider', 'spinbutton', 'treeitem'])

export function snapshotOptions(input: BrowserSnapshotOptions): BrowserSnapshotOptions {
  for (const field of ['snapshotId', 'selector', 'query'] as const) {
    const value = input[field]
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 2000)) {
      throw new Error(`${field} must be 1-2000 characters`)
    }
  }
  for (const [field, min, max] of [['offset', 0, Number.MAX_SAFE_INTEGER], ['limit', 1, MAX_SNAPSHOT_LIMIT]] as const) {
    const value = input[field]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max)) {
      throw new Error(`${field} must be an integer between ${min} and ${max}`)
    }
  }
  if (input.interactiveOnly !== undefined && typeof input.interactiveOnly !== 'boolean') throw new Error('interactive_only must be a boolean')
  if (input.snapshotId && (input.selector !== undefined || input.query !== undefined || input.interactiveOnly !== undefined)) {
    throw new Error('Do not change selector/query/interactive_only when continuing a snapshot; omit snapshot_id for a new search')
  }
  return { ...input, offset: input.offset ?? 0, limit: input.limit ?? DEFAULT_SNAPSHOT_LIMIT }
}

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()

/** Deterministic search over the complete AX tree, before applying the response budget. */
export function filterSnapshotNodes(nodes: BrowserSnapshotNode[], options: BrowserSnapshotOptions) {
  const query = options.query ? normalize(options.query) : ''
  return nodes.filter(node => (!options.interactiveOnly || INTERACTIVE_ROLES.has(node.role.toLowerCase()))
    && (!query || normalize(`${node.role} ${node.name} ${node.description || ''}`).includes(query)))
}
