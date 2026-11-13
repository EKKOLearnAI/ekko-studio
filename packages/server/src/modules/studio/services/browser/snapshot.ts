/**
 * Accessibility snapshot with stable element references (spec-04).
 *
 * Shapes are byte-compatible with the desktop contract
 * (`packages/desktop/src/main/browser/browser-types.ts`):
 * `{ tabId, snapshotId, url, title, nodes, text }` with nodes
 * `{ ref, role, name, value?, description?, disabled?, focused? }`.
 *
 * `ref` is `@e1`, `@e2`, ... valid **only for that snapshot**: every new
 * snapshot, every interaction and every navigation invalidates the previous
 * mapping, and using a stale `snapshot_id` fails loudly instead of guessing an
 * element.
 *
 * Sensitive node metadata is excluded by construction: protected (password)
 * values are never read, and no DOM attributes, dataset, event handlers,
 * cookies or storage ever enter a node.
 */

import { randomUUID } from 'crypto'
import type { CdpAXNode } from './cdp-types'
import { publicBrowserUrl, redactBrowserText } from './url-policy'

export const MAX_SNAPSHOT_NODES = 300
export const MAX_SNAPSHOT_TEXT = 24_000
export const STALE_SNAPSHOT_MESSAGE =
  'Browser snapshot is stale; take a new snapshot before interacting'
export const UNKNOWN_REFERENCE_MESSAGE = 'Unknown browser element reference'

export interface BrowserSnapshotNode {
  ref: string
  role: string
  name: string
  value?: string
  description?: string
  disabled?: boolean
  focused?: boolean
}

export interface BrowserSnapshot {
  tabId: string
  snapshotId: string
  url: string
  title: string
  nodes: BrowserSnapshotNode[]
  text: string
}

export interface StoredSnapshotRef {
  backendDOMNodeId: number
  role: string
  name: string
}

export interface SnapshotTabInfo {
  id: string
  url: string
  title: string
  cdpSessionId: string | null
}

export interface SnapshotSource {
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>
  getTab(tabId: string): SnapshotTabInfo | null
  randomId?: () => string
}

export class SnapshotStaleError extends Error {
  constructor() {
    super(STALE_SNAPSHOT_MESSAGE)
    this.name = 'SnapshotStaleError'
  }
}

export class SnapshotReferenceError extends Error {
  constructor(ref: string) {
    super(`${UNKNOWN_REFERENCE_MESSAGE}: ${ref}`)
    this.name = 'SnapshotReferenceError'
  }
}

function propertyValue(node: CdpAXNode, name: string): unknown {
  return node.properties?.find(item => item.name === name)?.value?.value
}

function textValue(input: unknown, limit = 500): string {
  return String(input ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

export class SnapshotStore {
  private readonly source: SnapshotSource
  private readonly randomId: () => string
  private readonly snapshots = new Map<string, { id: string, refs: Map<string, StoredSnapshotRef> }>()

  constructor(source: SnapshotSource) {
    this.source = source
    this.randomId = source.randomId ?? (() => randomUUID())
  }

  /** Drop the stored mapping for a tab (navigation, interaction, disposal). */
  invalidate(tabId: string): void {
    this.snapshots.delete(tabId)
  }

  hasSnapshot(tabId: string, snapshotId: string): boolean {
    return this.snapshots.get(tabId)?.id === snapshotId
  }

  resolveRef(tabId: string, snapshotId: string, ref: string): StoredSnapshotRef {
    const stored = this.snapshots.get(tabId)
    if (!stored || stored.id !== snapshotId) throw new SnapshotStaleError()
    const target = stored.refs.get(ref)
    if (!target) throw new SnapshotReferenceError(ref)
    return target
  }

  async take(tabId: string): Promise<BrowserSnapshot> {
    const tab = this.source.getTab(tabId)
    if (!tab || !tab.cdpSessionId) throw new Error('Browser tab is closed')
    const sessionId = tab.cdpSessionId

    await this.source.send('Accessibility.enable', {}, sessionId)
    const response = await this.source.send<{ nodes?: CdpAXNode[] }>(
      'Accessibility.getFullAXTree',
      {},
      sessionId,
    )

    const refs = new Map<string, StoredSnapshotRef>()
    const nodes: BrowserSnapshotNode[] = []

    for (const node of response?.nodes ?? []) {
      if (nodes.length >= MAX_SNAPSHOT_NODES) break
      if (node.ignored || !node.backendDOMNodeId) continue

      const role = textValue(node.role?.value, 80)
      const name = textValue(node.name?.value)
      // A protected (password) value is never read into the snapshot.
      const protectedValue = propertyValue(node, 'protected') === true
      const value = protectedValue ? '' : textValue(node.value?.value)
      if (!role || role === 'none' || (role === 'generic' && !name && !value)) continue

      const ref = `@e${nodes.length + 1}`
      refs.set(ref, { backendDOMNodeId: node.backendDOMNodeId, role, name })
      nodes.push({
        ref,
        role,
        name,
        ...(value ? { value } : {}),
        ...(node.description?.value ? { description: textValue(node.description.value) } : {}),
        ...(propertyValue(node, 'disabled') === true ? { disabled: true } : {}),
        ...(propertyValue(node, 'focused') === true ? { focused: true } : {}),
      })
    }

    const snapshotId = this.randomId()
    this.snapshots.set(tabId, { id: snapshotId, refs })

    const lines = nodes.map(node => {
      const details = [
        node.name && `name=${JSON.stringify(node.name)}`,
        node.value && `value=${JSON.stringify(node.value)}`,
      ].filter(Boolean)
      return `${node.ref} ${node.role}${details.length ? ` ${details.join(' ')}` : ''}`
    })

    return {
      tabId,
      snapshotId,
      url: publicBrowserUrl(tab.url),
      title: redactBrowserText(tab.title),
      nodes,
      text: lines.join('\n').slice(0, MAX_SNAPSHOT_TEXT),
    }
  }
}
