/**
 * Automation semantics (spec-04): the semantic operations the Agent and the
 * panel both consume. Result shapes are identical to the Electron
 * implementation so the Broker (spec-05) can return them verbatim.
 *
 * Nothing here accepts caller-supplied JavaScript: element resolution uses the
 * fixed scripts in `element-script.ts` applied to a backend node id resolved
 * from a snapshot ref, and input goes through CDP `Input.*` events.
 */

import {
  ELEMENT_BOX_SCRIPT,
  ELEMENT_FOCUS_AND_CLEAR_SCRIPT,
  ELEMENT_READ_TEXT_SCRIPT,
} from './element-script'
import {
  SnapshotStore,
  type BrowserSnapshot,
  type SnapshotSource,
  type SnapshotTabInfo,
} from './snapshot'
import { publicBrowserUrl, redactBrowserText } from './url-policy'

export const SCROLL_PIXELS = 500
export const MAX_SCROLL_PIXELS = 10_000
export const DEFAULT_BROWSER_TEXT_READ_LIMIT = 4_000
export const MAX_BROWSER_TEXT_READ_LIMIT = 20_000
export const CONSOLE_BUFFER_LIMIT = 500
export const CONSOLE_MESSAGE_LIMIT = 2_000
export const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024
export const SCREENSHOT_TIMEOUT_MS = 15_000
export const MAX_TYPED_TEXT_LENGTH = 100_000

const MAX_SCREENSHOT_EDGE = 8_192
const MAX_SCREENSHOT_PIXELS = 32_000_000

export type BrowserTextMode = 'innerText' | 'textContent'

export interface BrowserReadTextOptions {
  snapshotId: string
  ref: string
  mode?: BrowserTextMode
  offset?: number
  limit?: number
}

export interface BrowserReadTextResult {
  tabId: string
  snapshotId: string
  ref: string
  mode: BrowserTextMode
  offset: number
  limit: number
  text: string
  totalLength: number
  returnedLength: number
  hasMore: boolean
  nextOffset?: number
}

export interface BrowserScreenshot {
  tabId: string
  url: string
  title: string
  mediaType: 'image/png' | 'image/jpeg'
  data: string
  width: number
  height: number
}

export interface BrowserConsoleEntry {
  level: number
  message: string
  sourceId: string
  line: number
  timestamp: string
}

export type BrowserInteractAction =
  | { action: 'click', ref: string, snapshot_id: string }
  | { action: 'type', ref: string, snapshot_id: string, text: string }
  | { action: 'press', key: string }
  | { action: 'scroll', direction: 'up' | 'down' | 'left' | 'right', pixels?: number }

export interface BrowserAutomationTab extends SnapshotTabInfo {}

export interface BrowserAutomationDeps extends SnapshotSource {
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>
  getTab(tabId: string): BrowserAutomationTab | null
  now?: () => Date
  randomId?: () => string
}

const CONSOLE_LEVELS: Record<string, number> = {
  debug: 0,
  log: 1,
  info: 1,
  warning: 2,
  warn: 2,
  error: 3,
  assert: 3,
}

const MODIFIER_MASKS: Record<string, number> = {
  alt: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  command: 4,
  shift: 8,
}

const NAMED_KEYS: Record<string, [string, number]> = {
  Enter: ['Enter', 13],
  Tab: ['Tab', 9],
  Escape: ['Escape', 27],
  Backspace: ['Backspace', 8],
  Delete: ['Delete', 46],
  ArrowUp: ['ArrowUp', 38],
  ArrowDown: ['ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 39],
  Home: ['Home', 36],
  End: ['End', 35],
  PageUp: ['PageUp', 33],
  PageDown: ['PageDown', 34],
  Space: ['Space', 32],
}

export function keyDescriptor(key: string): { key: string, code: string, keyCode: number } {
  const named = NAMED_KEYS[key]
  if (named) return { key: key === 'Space' ? ' ' : key, code: named[0], keyCode: named[1] }
  const value = key.length === 1 ? key : key.slice(0, 64)
  const upper = value.toUpperCase()
  return {
    key: value,
    code: /^[A-Z]$/.test(upper) ? `Key${upper}` : value,
    keyCode: upper.charCodeAt(0) || 0,
  }
}

export function parseKeyPress(input: string): { key: string, modifiers: number } {
  const parts = String(input || '').split('+').map(part => part.trim()).filter(Boolean)
  const key = parts.pop() || 'Enter'
  const modifiers = parts.reduce(
    (mask, part) => mask | (MODIFIER_MASKS[part.toLowerCase()] || 0),
    0,
  )
  return { key, modifiers }
}

export function formatConsoleArguments(
  args: Array<{ type: string, value?: unknown, description?: string }> | undefined,
): string {
  const text = (args ?? [])
    .map((arg) => {
      if (arg.value !== undefined && arg.value !== null) {
        return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
      }
      return arg.description || arg.type || ''
    })
    .filter(Boolean)
    .join(' ')
  return text.slice(0, CONSOLE_MESSAGE_LIMIT)
}

export class BrowserAutomation {
  readonly snapshots: SnapshotStore
  private readonly deps: BrowserAutomationDeps
  private readonly now: () => Date
  private readonly consoleEntries = new Map<string, BrowserConsoleEntry[]>()
  private readonly domEnabled = new Set<string>()

  constructor(deps: BrowserAutomationDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => new Date())
    this.snapshots = new SnapshotStore(deps)
  }

  private requireTab(tabId: string): BrowserAutomationTab {
    const tab = this.deps.getTab(tabId)
    if (!tab || !tab.cdpSessionId) throw new Error('Browser tab is closed')
    return tab
  }

  /** Wire the console buffer to the CDP client; returns an unsubscribe fn. */
  attachConsole(
    cdp: {
      on: <T = any>(
        method: string,
        handler: (params: T, meta: { sessionId?: string, method: string }) => void,
      ) => () => void
    },
    resolveTabId: (sessionId?: string) => string | null,
  ): () => void {
    const offConsole = cdp.on<{
      type: string
      args?: Array<{ type: string, value?: unknown, description?: string }>
      timestamp?: number
      stackTrace?: { callFrames?: Array<{ url: string, lineNumber: number }> }
    }>('Runtime.consoleAPICalled', (params, meta) => {
      const tabId = resolveTabId(meta.sessionId)
      if (!tabId) return
      const frame = params.stackTrace?.callFrames?.[0]
      this.recordConsole(tabId, {
        level: CONSOLE_LEVELS[params.type] ?? 1,
        message: formatConsoleArguments(params.args),
        sourceId: this.publicSourceId(tabId, frame?.url),
        line: (frame?.lineNumber ?? 0) + 1,
        timestamp: this.timestampFrom(params.timestamp),
      })
    })

    const offException = cdp.on<{
      exceptionDetails?: {
        text?: string
        url?: string
        lineNumber?: number
        exception?: { description?: string, value?: unknown }
      }
      timestamp?: number
    }>('Runtime.exceptionThrown', (params, meta) => {
      const tabId = resolveTabId(meta.sessionId)
      if (!tabId) return
      const details = params.exceptionDetails
      const message = [details?.text, details?.exception?.description]
        .filter(Boolean)
        .join(' ')
      this.recordConsole(tabId, {
        level: 3,
        message: (message || 'Uncaught exception').slice(0, CONSOLE_MESSAGE_LIMIT),
        sourceId: this.publicSourceId(tabId, details?.url),
        line: (details?.lineNumber ?? 0) + 1,
        timestamp: this.timestampFrom(params.timestamp),
      })
    })

    return () => {
      offConsole()
      offException()
    }
  }

  private timestampFrom(timestamp?: number): string {
    if (typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0) {
      return new Date(timestamp).toISOString()
    }
    return this.now().toISOString()
  }

  private publicSourceId(tabId: string, sourceUrl?: string): string {
    const candidate = sourceUrl || this.deps.getTab(tabId)?.url || ''
    return publicBrowserUrl(candidate)
  }

  recordConsole(tabId: string, entry: BrowserConsoleEntry): void {
    const buffer = this.consoleEntries.get(tabId) ?? []
    buffer.push(entry)
    if (buffer.length > CONSOLE_BUFFER_LIMIT) {
      buffer.splice(0, buffer.length - CONSOLE_BUFFER_LIMIT)
    }
    this.consoleEntries.set(tabId, buffer)
  }

  consoleEntriesFor(tabId: string): BrowserConsoleEntry[] {
    return (this.consoleEntries.get(tabId) ?? []).map(entry => ({ ...entry }))
  }

  clearConsole(tabId: string): { ok: true } {
    this.consoleEntries.delete(tabId)
    return { ok: true }
  }

  forgetTab(tabId: string): void {
    this.consoleEntries.delete(tabId)
    this.snapshots.invalidate(tabId)
    this.domEnabled.delete(tabId)
  }

  async snapshot(tabId: string): Promise<BrowserSnapshot> {
    return this.snapshots.take(tabId)
  }

  private async resolveObjectId(tabId: string, backendDOMNodeId: number): Promise<string> {
    const tab = this.requireTab(tabId)
    const sessionId = tab.cdpSessionId as string
    if (!this.domEnabled.has(tabId)) {
      await this.deps.send('DOM.enable', {}, sessionId).catch(() => undefined)
      this.domEnabled.add(tabId)
    }
    const resolved = await this.deps.send<{ object?: { objectId?: string } }>(
      'DOM.resolveNode',
      { backendNodeId: backendDOMNodeId },
      sessionId,
    )
    const objectId = resolved?.object?.objectId
    if (!objectId) throw new Error('Unable to resolve browser element')
    return objectId
  }

  private async callOnObject<T>(
    tabId: string,
    objectId: string,
    functionDeclaration: string,
    args: unknown[] = [],
  ): Promise<T> {
    const tab = this.requireTab(tabId)
    const response = await this.deps.send<{
      result?: { value?: T }
      exceptionDetails?: { text?: string }
    }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        returnByValue: true,
        functionDeclaration,
        arguments: args.map(value => ({ value })),
      },
      tab.cdpSessionId as string,
    )
    if (response?.exceptionDetails) {
      throw new Error(response.exceptionDetails.text || 'Browser element script failed')
    }
    return response?.result?.value as T
  }

  async interact(tabId: string, action: BrowserInteractAction): Promise<void> {
    const allowed = ['click', 'type', 'press', 'scroll']
    if (!action || !allowed.includes(action.action)) {
      throw new Error('Invalid browser interaction action')
    }
    const tab = this.requireTab(tabId)
    const sessionId = tab.cdpSessionId as string

    if (action.action === 'click' || action.action === 'type') {
      if (typeof action.snapshot_id !== 'string' || typeof action.ref !== 'string') {
        throw new Error('snapshot_id and ref are required')
      }
      if (action.action === 'type' && typeof action.text !== 'string') {
        throw new Error('text is required for browser typing')
      }

      const target = this.snapshots.resolveRef(tabId, action.snapshot_id, action.ref)
      const objectId = await this.resolveObjectId(tabId, target.backendDOMNodeId)
      try {
        if (action.action === 'click') {
          const box = await this.callOnObject<{ ok: boolean, reason?: string, x?: number, y?: number }>(
            tabId,
            objectId,
            ELEMENT_BOX_SCRIPT,
          )
          if (!box?.ok) {
            if (box?.reason === 'outside-viewport') throw new Error('Element is outside the viewport')
            throw new Error('Element is not visible')
          }
          const x = Math.round(box.x as number)
          const y = Math.round(box.y as number)
          await this.deps.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 }, sessionId)
          await this.deps.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId)
          await this.deps.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId)
        } else {
          await this.callOnObject(tabId, objectId, ELEMENT_FOCUS_AND_CLEAR_SCRIPT)
          await this.deps.send(
            'Input.insertText',
            { text: String(action.text).slice(0, MAX_TYPED_TEXT_LENGTH) },
            sessionId,
          )
        }
      } finally {
        await this.deps.send('Runtime.releaseObject', { objectId }, sessionId).catch(() => undefined)
      }
      this.snapshots.invalidate(tabId)
      return
    }

    if (action.action === 'scroll') {
      if (!['up', 'down', 'left', 'right'].includes(action.direction)) {
        throw new Error('Invalid browser scroll direction')
      }
      const pixels = Math.max(1, Math.min(MAX_SCROLL_PIXELS, Math.round(action.pixels || SCROLL_PIXELS)))
      const deltaX = action.direction === 'left' ? -pixels : action.direction === 'right' ? pixels : 0
      const deltaY = action.direction === 'up' ? -pixels : action.direction === 'down' ? pixels : 0
      const point = await this.viewportCenter(tabId)
      await this.deps.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: point.x,
        y: point.y,
        deltaX,
        deltaY,
      }, sessionId)
      this.snapshots.invalidate(tabId)
      return
    }

    if (typeof action.key !== 'string' || !action.key.trim()) {
      throw new Error('key is required for browser key presses')
    }
    const { key, modifiers } = parseKeyPress(action.key)
    const descriptor = keyDescriptor(key)
    const type = key.length === 1 && modifiers === 0 ? 'keyDown' : 'rawKeyDown'
    const base = {
      modifiers,
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
    }
    await this.deps.send('Input.dispatchKeyEvent', {
      type,
      ...base,
      ...(type === 'keyDown' ? { text: descriptor.key } : {}),
    }, sessionId)
    await this.deps.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId)
    this.snapshots.invalidate(tabId)
  }

  private async viewportCenter(tabId: string): Promise<{ x: number, y: number }> {
    const tab = this.requireTab(tabId)
    try {
      const metrics = await this.deps.send<{
        cssVisualViewport?: { clientWidth?: number, clientHeight?: number }
      }>('Page.getLayoutMetrics', {}, tab.cdpSessionId as string)
      const width = Math.max(1, Math.round(metrics?.cssVisualViewport?.clientWidth || 800))
      const height = Math.max(1, Math.round(metrics?.cssVisualViewport?.clientHeight || 600))
      return { x: Math.round(width / 2), y: Math.round(height / 2) }
    } catch {
      return { x: 400, y: 300 }
    }
  }

  async readText(tabId: string, options: BrowserReadTextOptions): Promise<BrowserReadTextResult> {
    const tab = this.requireTab(tabId)
    const mode: BrowserTextMode = options.mode === 'textContent' ? 'textContent' : 'innerText'
    const offset = Math.max(0, Math.floor(options.offset ?? 0))
    const limit = Math.max(
      1,
      Math.min(MAX_BROWSER_TEXT_READ_LIMIT, Math.floor(options.limit ?? DEFAULT_BROWSER_TEXT_READ_LIMIT)),
    )
    const target = this.snapshots.resolveRef(tabId, options.snapshotId, options.ref)
    const objectId = await this.resolveObjectId(tabId, target.backendDOMNodeId)

    let fullText = ''
    try {
      const result = await this.callOnObject<{ ok: boolean, text: string }>(
        tabId,
        objectId,
        ELEMENT_READ_TEXT_SCRIPT,
        [mode],
      )
      fullText = result?.text ?? ''
    } finally {
      await this.deps.send('Runtime.releaseObject', { objectId }, tab.cdpSessionId as string)
        .catch(() => undefined)
    }

    const totalLength = fullText.length
    const slice = offset > totalLength ? '' : fullText.slice(offset, offset + limit)
    const hasMore = offset + slice.length < totalLength

    return {
      tabId,
      snapshotId: options.snapshotId,
      ref: options.ref,
      mode,
      offset,
      limit,
      text: slice,
      totalLength,
      returnedLength: slice.length,
      hasMore,
      ...(hasMore ? { nextOffset: offset + slice.length } : {}),
    }
  }

  async screenshot(tabId: string, fullPage = false): Promise<BrowserScreenshot> {
    const tab = this.requireTab(tabId)
    const sessionId = tab.cdpSessionId as string
    const metrics = await this.deps.send<{
      cssVisualViewport?: { clientWidth?: number, clientHeight?: number }
      cssContentSize?: { width?: number, height?: number }
    }>('Page.getLayoutMetrics', {}, sessionId)

    const source = fullPage
      ? { width: metrics?.cssContentSize?.width, height: metrics?.cssContentSize?.height }
      : { width: metrics?.cssVisualViewport?.clientWidth, height: metrics?.cssVisualViewport?.clientHeight }

    let width = Math.max(1, Math.min(MAX_SCREENSHOT_EDGE, Math.ceil(source.width || 1)))
    let height = Math.max(1, Math.min(MAX_SCREENSHOT_EDGE, Math.ceil(source.height || 1)))
    if (width * height > MAX_SCREENSHOT_PIXELS) {
      height = Math.max(1, Math.floor(MAX_SCREENSHOT_PIXELS / width))
    }

    let timer: NodeJS.Timeout | undefined
    let response: { data?: string }
    try {
      response = await Promise.race([
        this.deps.send<{ data?: string }>('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: fullPage,
          ...(fullPage ? { clip: { x: 0, y: 0, width, height, scale: 1 } } : {}),
        }, sessionId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Browser screenshot timed out')), SCREENSHOT_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }

    const data = response?.data || ''
    if (!data) throw new Error('Browser screenshot was empty')
    if (Buffer.byteLength(data, 'base64') > MAX_SCREENSHOT_BYTES) {
      throw new Error('Browser screenshot exceeds the 12 MB safety limit')
    }

    return {
      tabId,
      url: publicBrowserUrl(tab.url),
      title: redactBrowserText(tab.title),
      mediaType: 'image/png',
      data,
      width,
      height,
    }
  }

}
