import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type {
  BrowserBatchAction,
  BrowserInteractAction,
  BrowserReadTextOptions,
  BrowserReadTextResult,
  BrowserScreenshot,
  BrowserSnapshot,
  BrowserSnapshotNode,
  BrowserSnapshotOptions,
  BrowserWaitOptions,
  BrowserWaitResult,
} from './browser-types'
import { MAX_BROWSER_TEXT_READ_LIMIT } from './browser-types'
import { filterSnapshotNodes, snapshotOptions, DEFAULT_SNAPSHOT_LIMIT } from './browser-snapshot'
import { publicBrowserUrl, redactBrowserContent, redactBrowserText } from './browser-url'
import type { BrowserObservedState, BrowserObservedTarget } from './browser-observation'
import { DOWNLOAD_SOURCE_FUNCTION, PAGE_BLOB_FUNCTION, UPLOAD_FUNCTION, type BrowserUploadFile, type BrowserUploadMethod, type BrowserUploadResult } from './browser-files'
import { CdpTabState } from './browser-cdp'
import type { BrowserMouseButton, BrowserNetworkEntry, BrowserPageDialog } from './browser-types'

interface AxNode {
  sessionId?: string
  frameId?: string
  nodeId?: string
  backendDOMNodeId?: number
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: string }
  description?: { value?: string }
  properties?: Array<{ name?: string; value?: { value?: unknown } }>
}

/** A snapshot element: its DOM node id is only unique within one renderer session. */
interface ElementTarget {
  backendDOMNodeId: number
  role: string
  name: string
  /** DevTools session of an out-of-process iframe; undefined for the main renderer. */
  sessionId?: string
  /** Same-process child frame that holds the node; undefined for the session's root frame. */
  frameId?: string
  key: string
}

interface StoredSnapshot {
  id: string
  refs: Map<string, ElementTarget>
  nodes: BrowserSnapshotNode[]
  allNodes: BrowserSnapshotNode[]
  totalNodes: number
  url: string
  title: string
  options: BrowserSnapshotOptions
}

interface PreparedBatchAction {
  action: BrowserBatchAction
  key?: string
  targetKey?: string
  snapshotOptions?: BrowserSnapshotOptions
}

interface FrameChild {
  sessionId?: string
  frameId?: string
}

const MAX_SNAPSHOT_TEXT = 24_000
const REF_ACTIONS = new Set(['click', 'double_click', 'right_click', 'type', 'hover', 'select', 'drag'])
const INTERACT_ACTIONS = new Set([...REF_ACTIONS, 'press', 'scroll', 'click_at', 'drag_at'])
const MAX_SNAPSHOT_FRAMES = 16
const DRAG_STEPS = 8
const MOUSE_BUTTON_MASK: Record<BrowserMouseButton, number> = { left: 1, right: 2, middle: 4 }
const WAIT_POLL_MS = 200
const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024
const CLICKABLE_ANCESTOR_SELECTOR = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  'label',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const CLICK_TARGET = `
  const node = this;
  const element = node && node.nodeType === 3 ? node.parentElement : node;
  if (!element || typeof element.getBoundingClientRect !== 'function') throw new Error('Browser node has no clickable element');
  const target = typeof element.closest === 'function'
    ? element.closest(${JSON.stringify(CLICKABLE_ANCESTOR_SELECTOR)}) || element : element;
`

type ScriptResponse = { exceptionDetails?: { exception?: { description?: string }; text?: string } }

function scriptFailure(action: string, response: ScriptResponse): Error {
  const detail = response.exceptionDetails?.exception?.description || response.exceptionDetails?.text || ''
  return new Error(`Unable to ${action}${detail ? `: ${redactBrowserText(detail.split('\n')[0], 200)}` : ''}`)
}

function clickFailure(response: ScriptResponse): Error {
  return scriptFailure('click browser element', response)
}

function textValue(value: unknown, limit = 500): string {
  return redactBrowserText(value, limit)
}

function property(node: AxNode, name: string): unknown {
  return node.properties?.find(item => item.name === name)?.value?.value
}

function elementKey(sessionId: string | undefined, backendDOMNodeId: number): string {
  return `${sessionId || ''}#${backendDOMNodeId}`
}

function dialogError(dialog: BrowserPageDialog): Error {
  return new Error(`A page ${dialog.type} dialog is open (${JSON.stringify(dialog.message.slice(0, 200))}); handle it with ekko_studio_browser_dialog before continuing`)
}

function viewportCoordinate(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000) throw new Error(`${name} must be a viewport coordinate in CSS pixels`)
  return value
}

// Runs in the element's own frame: scroll it into view and report the center point
// and whether that point actually lands on the element rather than an overlay.
const POINTER_TARGET_FUNCTION = `function (useClickTarget) {
  const node = this;
  const element = node && node.nodeType === 3 ? node.parentElement : node;
  if (!element || typeof element.getBoundingClientRect !== 'function') throw new Error('Browser node has no element');
  const target = useClickTarget && typeof element.closest === 'function'
    ? element.closest(${JSON.stringify(CLICKABLE_ANCESTOR_SELECTOR)}) || element : element;
  if (!target.isConnected) throw new Error('Browser element was removed');
  target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || getComputedStyle(target).visibility === 'hidden') throw new Error('Element is not visible');
  const left = Math.max(rect.left, 0), right = Math.min(rect.right, innerWidth);
  const top = Math.max(rect.top, 0), bottom = Math.min(rect.bottom, innerHeight);
  if (right <= left || bottom <= top) throw new Error('Element is outside the viewport');
  const x = (left + right) / 2, y = (top + bottom) / 2;
  let hit = document.elementFromPoint(x, y);
  while (hit && hit.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  let covered = true;
  for (let current = hit; current; current = current.parentNode || current.host) {
    if (current === target) { covered = false; break; }
  }
  // Add same-origin parent frames from inside the page: each <iframe> content box offsets the point.
  // The walk stops at the main window or at a cross-origin parent (an out-of-process iframe root).
  let frameX = 0, frameY = 0, view = target.ownerDocument.defaultView, crossOrigin = false;
  while (view && view !== view.parent) {
    let owner = null;
    try { owner = view.frameElement; } catch (error) { owner = null; }
    if (!owner) { crossOrigin = true; break; }
    const box = owner.getBoundingClientRect();
    const style = owner.ownerDocument.defaultView.getComputedStyle(owner);
    frameX += box.left + owner.clientLeft + parseFloat(style.paddingLeft || '0');
    frameY += box.top + owner.clientTop + parseFloat(style.paddingTop || '0');
    view = view.parent;
  }
  return { x, y, covered, frameX, frameY, crossOrigin };
}`

function keyDescriptor(key: string): { key: string; code: string; keyCode: number } {
  const named: Record<string, [string, number]> = {
    Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
    ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39],
    Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], Space: ['Space', 32],
  }
  const match = named[key]
  if (match) return { key: key === 'Space' ? ' ' : key, code: match[0], keyCode: match[1] }
  const value = key.length === 1 ? key : key.slice(0, 64)
  const upper = value.toUpperCase()
  return { key: value, code: /^[A-Z]$/.test(upper) ? `Key${upper}` : value, keyCode: upper.charCodeAt(0) || 0 }
}

// macOS Chromium runs Cmd shortcuts through native key bindings, so synthetic key events need explicit editing commands.
const MAC_EDITING_COMMANDS: Record<string, string> = { KeyA: 'selectAll', KeyC: 'copy', KeyX: 'cut', KeyV: 'paste', KeyZ: 'undo' }

export function editingCommands(code: string, modifiers: number, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'darwin' || (modifiers & ~8) !== 4) return []
  if (code === 'KeyZ' && modifiers & 8) return ['redo']
  const command = MAC_EDITING_COMMANDS[code]
  return command && !(modifiers & 8) ? [command] : []
}

export class BrowserAutomation {
  private readonly snapshots = new Map<string, StoredSnapshot>()
  private readonly cdpStates = new WeakMap<WebContents, CdpTabState>()

  invalidate(tabId: string): void {
    this.snapshots.delete(tabId)
  }

  private cdp(contents: WebContents): CdpTabState {
    let state = this.cdpStates.get(contents)
    if (!state) {
      state = new CdpTabState(contents)
      this.cdpStates.set(contents, state)
    }
    return state
  }

  /** Main-viewport CSS point where the last interaction dispatched mouse input, for evidence. */
  lastPointer(contents: WebContents): CdpTabState['lastPointer'] {
    return this.cdpStates.get(contents)?.lastPointer
  }

  /** The JavaScript dialog currently blocking the page, if any. */
  pageDialog(contents: WebContents): BrowserPageDialog | undefined {
    const dialog = this.cdpStates.get(contents)?.dialog
    if (!dialog) return undefined
    const { sessionId: _sessionId, ...visible } = dialog
    return visible
  }

  async handleDialog(tabId: string, contents: WebContents, accept: boolean, promptText?: string): Promise<BrowserPageDialog> {
    const state = this.cdp(contents)
    const dialog = state.dialog
    if (!dialog) throw new Error('No page dialog is open')
    await state.send('Page.handleJavaScriptDialog', { accept, ...(promptText !== undefined ? { promptText } : {}) }, dialog.sessionId)
    // DevTools answers the page but leaves Electron's native message box on screen.
    // Electron closes its alert/confirm boxes on this internal event without re-answering.
    const emitter = contents as unknown as { emit?: (event: string, ...args: unknown[]) => boolean }
    if (typeof emitter.emit === 'function') emitter.emit('-cancel-dialogs', { resetState: false })
    if (state.dialog === dialog) state.dialog = undefined
    this.invalidate(tabId)
    const { sessionId: _sessionId, ...visible } = dialog
    return visible
  }

  /** While the agent controls a tab, file pickers are intercepted instead of opening the OS dialog. */
  async setFileChooserInterception(contents: WebContents, enabled: boolean): Promise<void> {
    if (contents.isDestroyed()) return
    await this.cdp(contents).setFileChooserInterception(enabled)
  }

  fileChooserSince(contents: WebContents, since: number): { multiple: boolean } | undefined {
    const chooser = this.cdpStates.get(contents)?.fileChooser
    return chooser && chooser.openedAt >= since ? { multiple: chooser.multiple } : undefined
  }

  networkEntries(contents: WebContents): BrowserNetworkEntry[] {
    return (this.cdpStates.get(contents)?.network || []).map(entry => ({ ...entry }))
  }

  clearNetwork(contents: WebContents): void {
    this.cdpStates.get(contents)?.clearNetwork()
  }

  detach(tabId: string, contents?: WebContents): void {
    this.invalidate(tabId)
    if (!contents || contents.isDestroyed()) return
    this.cdpStates.get(contents)?.dispose()
    this.cdpStates.delete(contents)
    const debuggerApi = contents.debugger
    if (debuggerApi.isAttached()) {
      try { debuggerApi.detach() } catch { /* already detached */ }
    }
  }

  snapshotSelection(tabId: string): BrowserSnapshotOptions {
    return { ...this.snapshots.get(tabId)?.options, snapshotId: undefined }
  }

  observedState(tabId: string): BrowserObservedState | undefined {
    const current = this.snapshots.get(tabId)
    if (!current) return undefined
    return { url: current.url, nodes: new Map(current.allNodes.map(node => [current.refs.get(node.ref)!.key, node])) }
  }

  observedTargets(tabId: string, snapshotId: unknown, actions: BrowserBatchAction[]): BrowserObservedTarget[] {
    return actions.flatMap((action, actionIndex) => 'ref' in action
      ? [{ nodeId: this.resolveRef(tabId, String(snapshotId), action.ref).key, actionIndex,
        ...(action.action === 'type' ? { text: action.text } : {}) }] : [])
  }

  async snapshot(tabId: string, contents: WebContents, input: BrowserSnapshotOptions = {}): Promise<BrowserSnapshot> {
    const options = snapshotOptions(input)
    if (options.snapshotId) {
      const current = this.snapshots.get(tabId)
      if (!current || current.id !== options.snapshotId) throw new Error('Browser snapshot is stale; take a new snapshot')
      current.options = { ...current.options, offset: options.offset, limit: options.limit }
      return this.snapshotPage(tabId, current)
    }
    await this.ensureAttached(contents)
    this.assertNoDialog(contents)
    const axNodes = await this.collectAxNodes(this.cdp(contents))
    let scope: Set<string> | undefined
    if (options.selector) {
      const document = await contents.debugger.sendCommand('DOM.getDocument')
      const selected = await contents.debugger.sendCommand('DOM.querySelector', { nodeId: document.root.nodeId, selector: options.selector })
      if (!selected.nodeId) throw new Error('Snapshot selector did not match an element; choose another selector or omit it for the whole document')
      const subtree = await contents.debugger.sendCommand('DOM.describeNode', { nodeId: selected.nodeId, depth: -1, pierce: true })
      scope = new Set<string>()
      const pending = [subtree.node]
      while (pending.length) {
        const node = pending.pop()
        if (!node) continue
        if (node.backendNodeId) scope.add(elementKey(undefined, node.backendNodeId))
        pending.push(...(node.children || []), ...(node.shadowRoots || []), node.contentDocument)
      }
    }
    const refs = new Map<string, ElementTarget>()
    const nodes: BrowserSnapshotNode[] = []
    const inScope = new Set<string>()
    for (const node of axNodes) {
      if (node.ignored || !node.backendDOMNodeId) continue
      const role = textValue(node.role?.value, 80)
      const name = textValue(node.name?.value)
      const protectedValue = property(node, 'protected') === true
      // Input whitespace is significant for local value comparisons.
      const value = protectedValue ? '' : redactBrowserContent(node.value?.value, 500)
      if (!role || role === 'none' || role === 'generic' && !name && !value) continue
      const ref = `@e${nodes.length + 1}`
      const key = elementKey(node.sessionId, node.backendDOMNodeId)
      refs.set(ref, { backendDOMNodeId: node.backendDOMNodeId, role, name, sessionId: node.sessionId, frameId: node.frameId, key })
      if (!scope || scope.has(key)) inScope.add(ref)
      const checked = property(node, 'checked')
      const selected = property(node, 'selected')
      const expanded = property(node, 'expanded')
      const pressed = property(node, 'pressed')
      nodes.push({
        ref, role, name,
        ...(!protectedValue && node.value?.value !== undefined ? { value } : {}),
        ...(node.description?.value ? { description: textValue(node.description.value) } : {}),
        ...(property(node, 'disabled') === true ? { disabled: true } : {}),
        ...(property(node, 'focused') === true ? { focused: true } : {}),
        ...(checked === 'mixed' ? { checked } : checked === true || checked === 'true' ? { checked: true }
          : checked === false || checked === 'false' ? { checked: false } : {}),
        ...(typeof selected === 'boolean' ? { selected } : {}),
        ...(typeof expanded === 'boolean' ? { expanded } : {}),
        ...(pressed === 'mixed' ? { pressed } : pressed === true || pressed === 'true' ? { pressed: true }
          : pressed === false || pressed === 'false' ? { pressed: false } : {}),
      })
    }
    const current: StoredSnapshot = { id: randomUUID(), refs, allNodes: nodes, totalNodes: nodes.length,
      nodes: filterSnapshotNodes(nodes.filter(node => inScope.has(node.ref)), options), options,
      url: publicBrowserUrl(contents.getURL()), title: redactBrowserText(contents.getTitle()) }
    this.snapshots.set(tabId, current)
    return this.snapshotPage(tabId, current)
  }

  /**
   * Accessibility nodes for the main frame with each iframe's nodes spliced in after its
   * owner element. Same-process frames are read by frame id; out-of-process iframes
   * through their own auto-attached DevTools session.
   */
  private async collectAxNodes(state: CdpTabState): Promise<AxNode[]> {
    await Promise.all([...state.sessions.values()].map(session => session.ready))
    const result: AxNode[] = []
    const owners = new Map<string, Map<number, FrameChild>>()
    let frames = 0
    const emit = async (sessionId: string | undefined, frameId: string | undefined, depth: number): Promise<void> => {
      if (frames++ >= MAX_SNAPSHOT_FRAMES || depth > 8) return
      const isMain = !sessionId && !frameId
      if (!frameId) await state.send('Accessibility.enable', {}, sessionId).catch(error => { if (isMain) throw error })
      const response = await state.send<{ nodes?: AxNode[] }>('Accessibility.getFullAXTree', frameId ? { frameId } : {}, sessionId)
        .catch(error => { if (isMain) throw error; return { nodes: [] } })
      const sessionKey = sessionId || ''
      if (!owners.has(sessionKey)) owners.set(sessionKey, await this.frameOwners(state, sessionId))
      const children = owners.get(sessionKey)!
      for (const node of response.nodes || []) {
        result.push({ ...node, sessionId, frameId })
        const child = node.backendDOMNodeId ? children.get(node.backendDOMNodeId) : undefined
        if (child) {
          children.delete(node.backendDOMNodeId!)
          await emit(child.sessionId, child.frameId, depth + 1)
        }
      }
      // Frames whose owner element is not in the accessibility tree still belong to this document.
      if (!frameId) {
        for (const [owner, child] of [...children]) {
          children.delete(owner)
          await emit(child.sessionId, child.frameId, depth + 1)
        }
      }
    }
    await emit(undefined, undefined, 0)
    return result
  }

  /** Map iframe owner elements in one session to the frame (or OOPIF session) they host. */
  private async frameOwners(state: CdpTabState, sessionId: string | undefined): Promise<Map<number, FrameChild>> {
    type FrameTree = { frame?: { id?: string }; childFrames?: FrameTree[] }
    const tree = await state.send<{ frameTree?: FrameTree }>('Page.getFrameTree', {}, sessionId).catch(() => undefined)
    const remote = new Map([...state.sessions.values()].filter(item => item.parentSessionId === sessionId).map(item => [item.targetId, item.sessionId]))
    const children: Array<{ ownerFrameId: string; child: FrameChild }> = []
    const pending = [...(tree?.frameTree?.childFrames || [])]
    while (pending.length && children.length < MAX_SNAPSHOT_FRAMES) {
      const frame = pending.shift()!
      const id = frame.frame?.id
      if (!id) continue
      const child = remote.get(id)
      if (child) {
        remote.delete(id)
        children.push({ ownerFrameId: id, child: { sessionId: child } })
      } else {
        children.push({ ownerFrameId: id, child: { sessionId, frameId: id } })
        pending.push(...(frame.childFrames || []))
      }
    }
    for (const [targetId, child] of remote) children.push({ ownerFrameId: targetId, child: { sessionId: child } })
    const owners = new Map<number, FrameChild>()
    for (const { ownerFrameId, child } of children) {
      const owner = await state.send<{ backendNodeId?: number }>('DOM.getFrameOwner', { frameId: ownerFrameId }, sessionId).catch(() => undefined)
      if (owner?.backendNodeId) owners.set(owner.backendNodeId, child)
    }
    return owners
  }

  private snapshotPage(tabId: string, current: StoredSnapshot): BrowserSnapshot {
    const { selector, query, interactiveOnly, offset = 0, limit = DEFAULT_SNAPSHOT_LIMIT } = current.options
    const nodes = current.nodes.slice(offset, offset + limit)
    const hasMore = offset + nodes.length < current.nodes.length
    const lines = nodes.map(node => {
      const details = [node.name && `name=${JSON.stringify(node.name)}`, node.value && `value=${JSON.stringify(node.value)}`].filter(Boolean)
      return `${node.ref} ${node.role}${details.length ? ` ${details.join(' ')}` : ''}`
    })
    return {
      tabId, snapshotId: current.id, url: current.url, title: current.title,
      nodes, text: lines.join('\n').slice(0, MAX_SNAPSHOT_TEXT),
      totalNodes: current.totalNodes, matchedNodes: current.nodes.length, offset, limit, hasMore,
      truncated: nodes.length < current.nodes.length,
      ...(hasMore ? { nextOffset: offset + nodes.length } : {}),
      scope: { ...(selector ? { selector } : {}), ...(query ? { query } : {}), ...(interactiveOnly ? { interactiveOnly } : {}) },
      ...(offset > 0 && !nodes.length ? { hint: `Offset ${offset} is outside the ${current.nodes.length} matched nodes. Offsets refer to the filtered results, not @e ref numbers or the full document. Restart at offset=0 with this snapshot_id, or omit snapshot_id to change filters.` }
        : hasMore ? { hint: 'Continue with this snapshot_id and offset=nextOffset. Offsets are relative to filtered results, not @e ref numbers. For focused results start a new snapshot with selector, query or interactive_only. Scrolling alone does not page this tree. These options work without JEV.' } : {}),
    }
  }

  async readText(tabId: string, contents: WebContents, options: BrowserReadTextOptions): Promise<BrowserReadTextResult> {
    await this.ensureAttached(contents)
    const target = this.resolveRef(tabId, options.snapshotId, options.ref)
    const offset = Math.max(0, Math.floor(options.offset))
    const limit = Math.max(1, Math.min(MAX_BROWSER_TEXT_READ_LIMIT, Math.floor(options.limit)))
    const state = this.cdp(contents)
    const objectId = await this.resolveObject(contents, target)
    try {
      const response = await state.send('Runtime.callFunctionOn', {
        objectId,
        returnByValue: true,
        arguments: [
          { value: options.mode },
          { value: offset },
          { value: limit },
        ],
        functionDeclaration: `function (mode, offset, limit) {
          const node = this;
          const element = node && node.nodeType === 3 ? node.parentElement : node;
          let source = '';
          if (mode === 'innerText' && element && typeof element.innerText === 'string') {
            source = element.innerText;
          } else if (node && typeof node.textContent === 'string') {
            source = node.textContent;
          } else if (element && typeof element.textContent === 'string') {
            source = element.textContent;
          }
          const start = Math.min(offset, source.length);
          const end = Math.min(source.length, start + limit);
          return {
            text: source.slice(start, end),
            totalLength: source.length,
            offset: start,
            returnedLength: end - start,
          };
        }`,
      }, target.sessionId) as {
        result?: { value?: { text?: unknown; totalLength?: unknown; offset?: unknown; returnedLength?: unknown } }
        exceptionDetails?: unknown
      }
      const value = response.result?.value
      if (
        response.exceptionDetails
        || !value
        || typeof value.text !== 'string'
        || typeof value.totalLength !== 'number'
        || typeof value.offset !== 'number'
        || typeof value.returnedLength !== 'number'
      ) {
        throw new Error('Unable to read browser element text')
      }
      const totalLength = Math.max(0, Math.floor(value.totalLength))
      const resultOffset = Math.max(0, Math.min(totalLength, Math.floor(value.offset)))
      const returnedLength = Math.max(0, Math.min(limit, Math.floor(value.returnedLength)))
      const hasMore = resultOffset + returnedLength < totalLength
      return {
        tabId,
        snapshotId: options.snapshotId,
        ref: options.ref,
        mode: options.mode,
        offset: resultOffset,
        limit,
        text: redactBrowserContent(value.text, limit),
        totalLength,
        returnedLength,
        hasMore,
        ...(hasMore ? { nextOffset: resultOffset + returnedLength } : {}),
      }
    } finally {
      await state.send('Runtime.releaseObject', { objectId }, target.sessionId).catch(() => undefined)
    }
  }

  prepareBatch(tabId: string, snapshotId: unknown, actions: BrowserBatchAction[]): PreparedBatchAction[] {
    return actions.map(action => {
      if (!('ref' in action)) return { action }
      if (typeof snapshotId !== 'string') throw new Error('snapshot_id is required for batch actions that use a ref')
      const target = this.resolveRef(tabId, snapshotId, action.ref)
      const destination = action.action === 'drag' ? this.resolveRef(tabId, snapshotId, action.target_ref) : undefined
      return { action, key: target.key, targetKey: destination?.key, snapshotOptions: this.snapshotSelection(tabId) }
    })
  }

  async resolveBatchAction(tabId: string, contents: WebContents, prepared: PreparedBatchAction): Promise<BrowserInteractAction> {
    const { action } = prepared
    if (!('ref' in action)) return action
    const snapshot = await this.snapshot(tabId, contents, prepared.snapshotOptions)
    // Ref numbers can shift after each interaction; preserve the original DOM identity.
    const current = this.snapshots.get(tabId)
    const find = (key: string | undefined, ref: string) => {
      const match = [...(current?.refs || [])].find(([, target]) => target.key === key)
      if (!match) throw new Error(`Browser batch target ${ref} is no longer available; take a new snapshot`)
      return match[0]
    }
    const ref = find(prepared.key, action.ref)
    if (action.action === 'drag') return { ...action, ref, target_ref: find(prepared.targetKey, action.target_ref), snapshot_id: snapshot.snapshotId }
    return { ...action, ref, snapshot_id: snapshot.snapshotId } as BrowserInteractAction
  }

  async interact(tabId: string, contents: WebContents, action: BrowserInteractAction, assertActive: () => void = () => {}): Promise<void> {
    if (!action || !INTERACT_ACTIONS.has(action.action)) throw new Error('Invalid browser interaction action')
    await this.ensureAttached(contents)
    this.assertNoDialog(contents)
    assertActive()
    this.cdp(contents).lastPointer = undefined
    // A click can open alert()/confirm(), which blocks the page and the command that caused it.
    // Stop waiting as soon as the dialog appears; the caller reports it instead of hanging.
    await this.cdp(contents).untilDialog(this.dispatch(tabId, contents, action, assertActive))
    this.invalidate(tabId)
  }

  private async dispatch(tabId: string, contents: WebContents, action: BrowserInteractAction, assertActive: () => void): Promise<void> {
    const state = this.cdp(contents)
    if (action.action === 'click_at') {
      const button = action.button || 'left'
      if (!MOUSE_BUTTON_MASK[button]) throw new Error('button must be left, right or middle')
      const point = await this.viewportPoint(state, action.x, action.y)
      assertActive()
      await this.mouseClick(state, point, button, action.click_count === 2 ? 2 : 1)
      return
    }
    if (action.action === 'drag_at') {
      const from = await this.viewportPoint(state, action.x, action.y)
      const to = await this.viewportPoint(state, action.to_x, action.to_y)
      assertActive()
      await this.drag(state, from, to, assertActive)
      return
    }
    if (action.action === 'scroll') {
      if (!['up', 'down', 'left', 'right'].includes(action.direction)) throw new Error('Invalid browser scroll direction')
      const pixels = Math.max(1, Math.min(10_000, Math.round(action.pixels || 650)))
      const deltaX = action.direction === 'left' ? -pixels : action.direction === 'right' ? pixels : 0
      const deltaY = action.direction === 'up' ? -pixels : action.direction === 'down' ? pixels : 0
      await state.send('Runtime.evaluate', {
        expression: `window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)})`,
        returnByValue: true,
      })
      return
    }
    if (action.action === 'press') {
      if (typeof action.key !== 'string' || !action.key.trim()) throw new Error('key is required for browser key presses')
      const parts = action.key.split('+').map(value => value.trim()).filter(Boolean)
      const key = parts.pop() || 'Enter'
      const modifiers = parts.reduce((mask, item) => mask | ({ alt: 1, control: 2, ctrl: 2, meta: 4, command: 4, shift: 8 }[item.toLowerCase()] || 0), 0)
      const descriptor = keyDescriptor(key)
      const commands = editingCommands(descriptor.code, modifiers)
      await state.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...descriptor, windowsVirtualKeyCode: descriptor.keyCode, ...(commands.length ? { commands } : {}) })
      await state.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...descriptor, windowsVirtualKeyCode: descriptor.keyCode })
      return
    }

    if (typeof action.snapshot_id !== 'string' || typeof action.ref !== 'string') throw new Error('snapshot_id and ref are required')
    if (action.action === 'type' && typeof action.text !== 'string') throw new Error('text is required for browser typing')
    if (action.action === 'select' && typeof action.value !== 'string') throw new Error('value is required for browser select')
    const target = this.resolveRef(tabId, action.snapshot_id, action.ref)
    const destination = action.action === 'drag' ? this.resolveRef(tabId, action.snapshot_id, action.target_ref) : undefined
    const objectId = await this.resolveObject(contents, target)
    try {
      assertActive()
      switch (action.action) {
        case 'click':
          await this.click(state, target, objectId, assertActive)
          return
        case 'double_click':
        case 'right_click': {
          const point = await this.pointerPoint(state, target, objectId, true)
          if (point.covered) throw new Error('Another element covers the center of this element; close the overlay or scroll first')
          assertActive()
          await this.mouseClick(state, point, action.action === 'right_click' ? 'right' : 'left', action.action === 'double_click' ? 2 : 1)
          return
        }
        case 'hover': {
          const point = await this.pointerPoint(state, target, objectId, false)
          // A trusted pointer move drives :hover styles and mouseover/mouseenter menus.
          state.lastPointer = { x: Math.round(point.x), y: Math.round(point.y) }
          await state.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
          return
        }
        case 'drag': {
          const from = await this.pointerPoint(state, target, objectId, false)
          const destinationObject = await this.resolveObject(contents, destination!)
          try {
            const to = await this.pointerPoint(state, destination!, destinationObject, false)
            // Scrolling the destination into view may move the source; re-measure it.
            const start = await this.pointerPoint(state, target, objectId, false).catch(() => from)
            assertActive()
            await this.drag(state, start, to, assertActive)
          } finally {
            await state.send('Runtime.releaseObject', { objectId: destinationObject }, destination!.sessionId).catch(() => undefined)
          }
          return
        }
        case 'select':
          await this.selectOption(state, target, objectId, action.value)
          return
        case 'type':
          await this.typeText(state, target, objectId, action.text, assertActive)
          return
      }
    } finally {
      await state.send('Runtime.releaseObject', { objectId }, target.sessionId).catch(() => undefined)
    }
  }

  private async click(state: CdpTabState, target: ElementTarget, objectId: string, assertActive: () => void): Promise<void> {
    // Only readiness is polled. Once dispatch starts, a click is never retried.
    const deadline = Date.now() + 1500
    while (true) {
      assertActive()
      const ready = await state.send('Runtime.callFunctionOn', {
        objectId, returnByValue: true,
        functionDeclaration: `function () { ${CLICK_TARGET}
          if (!target.isConnected) throw new Error('Browser element was removed');
          if (target.disabled || target.getAttribute('aria-disabled') === 'true') return 'disabled';
          target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          const rect = target.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0 || getComputedStyle(target).visibility === 'hidden') return 'not visible';
          if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return 'outside the viewport';
          return true;
        }`,
      }, target.sessionId) as { result?: { value?: unknown } } & ScriptResponse
      if (ready.exceptionDetails) throw clickFailure(ready)
      if (ready.result?.value === true) break
      if (Date.now() >= deadline) throw new Error(`Browser element did not become clickable: ${String(ready.result?.value || 'unavailable')}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assertActive()
    // Prefer a trusted mouse click so pages that check isTrusted, popup blockers and
    // user-activation gated APIs behave as they would for a person.
    const point = await this.pointerPoint(state, target, objectId, true).catch(() => undefined)
    if (point && !point.covered) {
      assertActive()
      await this.mouseClick(state, point, 'left', 1)
      return
    }
    // Covered or unmeasurable targets keep the previous DOM click behavior.
    const response = await state.send('Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      functionDeclaration: `function () { ${CLICK_TARGET}
        if (!target.isConnected || target.disabled || target.getAttribute('aria-disabled') === 'true') throw new Error('Browser element is unavailable or disabled');
        const rect = target.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error('Element is not visible');
        target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const next = target.getBoundingClientRect();
        if (next.bottom <= 0 || next.right <= 0 || next.top >= innerHeight || next.left >= innerWidth) throw new Error('Element is outside the viewport');
        if (typeof target.click === 'function') target.click();
        else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      }`,
    }, target.sessionId) as { result?: { value?: unknown } } & ScriptResponse
    if (response.exceptionDetails || response.result?.value !== true) throw clickFailure(response)
  }

  private async typeText(state: CdpTabState, target: ElementTarget, objectId: string, text: string, assertActive: () => void): Promise<void> {
    const response = await state.send('Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        if (!this.isConnected || this.disabled || this.readOnly || this.getAttribute?.('aria-disabled') === 'true') throw new Error('Browser input is unavailable or disabled');
        this.scrollIntoView({ block: 'center', inline: 'center' });
        this.focus();
        if ('value' in this) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), 'value')?.set;
          if (setter) setter.call(this, ''); else this.value = '';
          this.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (this.isContentEditable) {
          // Select instead of clearing the DOM so editor-managed fields (React/Draft.js/ProseMirror) replace it via their own input handling.
          const selection = this.ownerDocument.getSelection();
          const range = this.ownerDocument.createRange();
          range.selectNodeContents(this);
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        return true;
      }`,
    }, target.sessionId) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (response.exceptionDetails || response.result?.value !== true) throw new Error('Unable to focus browser input')
    assertActive()
    // Keyboard input is routed by the main widget to the focused frame, including iframes.
    await state.send('Input.insertText', { text: String(text).slice(0, 100_000) })
  }

  /** Center of an element in main-viewport CSS pixels, plus whether something covers it. */
  private async pointerPoint(state: CdpTabState, target: ElementTarget, objectId: string, clickTarget: boolean): Promise<{ x: number; y: number; covered: boolean }> {
    const response = await state.send('Runtime.callFunctionOn', {
      objectId, returnByValue: true, functionDeclaration: POINTER_TARGET_FUNCTION, arguments: [{ value: clickTarget }],
    }, target.sessionId) as { result?: { value?: { x?: unknown; y?: unknown; covered?: unknown; frameX?: unknown; frameY?: unknown; crossOrigin?: unknown } } } & ScriptResponse
    const value = response.result?.value
    if (response.exceptionDetails || typeof value?.x !== 'number' || typeof value.y !== 'number') {
      throw scriptFailure('locate browser element', response)
    }
    // Same-origin frames are measured in the page. DevTools box models are only needed when
    // the walk stopped inside this session (same-process cross-origin frame), plus once per
    // out-of-process iframe boundary.
    const inPage = typeof value.frameX === 'number' && typeof value.frameY === 'number'
    const stoppedEarly = value.crossOrigin === true && !!target.frameId && !target.sessionId
    const local = inPage && !stoppedEarly ? { x: value.frameX as number, y: value.frameY as number }
      : target.frameId ? await this.ownerBoxOffset(state, target.frameId, target.sessionId) : { x: 0, y: 0 }
    const session = await this.sessionOffset(state, target.sessionId)
    return { x: value.x + local.x + session.x, y: value.y + local.y + session.y, covered: value.covered === true }
  }

  /** Content-box origin of a frame's <iframe> element, relative to its session's root viewport. */
  private async ownerBoxOffset(state: CdpTabState, frameId: string, sessionId: string | undefined): Promise<{ x: number; y: number }> {
    const owner = await state.send<{ backendNodeId?: number }>('DOM.getFrameOwner', { frameId }, sessionId)
    const box = await state.send<{ model?: { content?: number[] } }>('DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, sessionId)
    const content = box.model?.content
    if (!content || content.length < 2) throw new Error('Browser frame is not visible')
    return { x: content[0], y: content[1] }
  }

  /** Offset of an out-of-process iframe session's viewport inside the main viewport, one owner per boundary. */
  private async sessionOffset(state: CdpTabState, sessionId: string | undefined): Promise<{ x: number; y: number }> {
    let x = 0, y = 0
    let session = sessionId
    for (let depth = 0; session; depth++) {
      if (depth >= 10) throw new Error('Browser frames are nested too deeply')
      const info = state.sessions.get(session)
      if (!info) throw new Error('Browser frame is no longer available; take a new snapshot')
      const offset = await this.ownerBoxOffset(state, info.targetId, info.parentSessionId)
      x += offset.x
      y += offset.y
      session = info.parentSessionId
    }
    return { x, y }
  }

  private async viewportPoint(state: CdpTabState, xValue: unknown, yValue: unknown): Promise<{ x: number; y: number }> {
    const x = viewportCoordinate(xValue, 'x'), y = viewportCoordinate(yValue, 'y')
    const metrics = await state.send<{ cssVisualViewport?: { clientWidth?: number; clientHeight?: number } }>('Page.getLayoutMetrics').catch(() => undefined)
    const width = metrics?.cssVisualViewport?.clientWidth, height = metrics?.cssVisualViewport?.clientHeight
    if (width && height && (x >= width || y >= height)) {
      throw new Error(`Point (${x}, ${y}) is outside the ${Math.floor(width)}x${Math.floor(height)} viewport; use viewport screenshot coordinates`)
    }
    return { x, y }
  }

  private async mouseClick(state: CdpTabState, point: { x: number; y: number }, button: BrowserMouseButton, clickCount: number): Promise<void> {
    const { x, y } = point
    state.lastPointer = { x: Math.round(x), y: Math.round(y) }
    await state.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    for (let count = 1; count <= clickCount; count++) {
      await state.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: MOUSE_BUTTON_MASK[button], clickCount: count })
      await state.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: count })
    }
  }

  /**
   * Pointer drags (sliders, sortable lists) see the mouse moves directly. HTML5 drag
   * and drop is intercepted so no native OS drag session starts, then replayed as
   * drag events on the destination.
   */
  private async drag(state: CdpTabState, from: { x: number; y: number }, to: { x: number; y: number }, assertActive: () => void): Promise<void> {
    let data: unknown
    state.lastPointer = { x: Math.round(from.x), y: Math.round(from.y), to_x: Math.round(to.x), to_y: Math.round(to.y) }
    state.onDragIntercepted = value => { data = value }
    await state.send('Input.setInterceptDrags', { enabled: true }).catch(() => undefined)
    let pressed = false
    try {
      await state.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
      await state.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
      pressed = true
      for (let step = 1; step <= DRAG_STEPS; step++) {
        assertActive()
        const x = from.x + (to.x - from.x) * step / DRAG_STEPS
        const y = from.y + (to.y - from.y) * step / DRAG_STEPS
        await state.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
        if (data) break
      }
      if (!data) await new Promise(resolve => setTimeout(resolve, 50))
      if (data) {
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
          await state.send('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data })
        }
      }
    } finally {
      if (pressed) await state.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => undefined)
      state.onDragIntercepted = undefined
      await state.send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined)
    }
  }

  private async selectOption(state: CdpTabState, target: ElementTarget, objectId: string, value: string): Promise<void> {
    const response = await state.send('Runtime.callFunctionOn', {
      objectId, returnByValue: true, arguments: [{ value }],
      functionDeclaration: `function (wanted) {
        const node = this && this.nodeType === 3 ? this.parentElement : this;
        const select = node instanceof HTMLSelectElement ? node : node?.closest?.('select') || (node?.control instanceof HTMLSelectElement ? node.control : null);
        if (!select) throw new Error('Element is not a native select; click the option instead');
        if (select.disabled) throw new Error('Select is disabled');
        const options = Array.from(select.options);
        const option = options.find(item => item.value === wanted) || options.find(item => item.label.trim() === wanted.trim() || item.text.trim() === wanted.trim());
        if (!option) throw new Error('No option matches the requested value or label');
        if (option.disabled) throw new Error('Option is disabled');
        select.focus();
        option.selected = true;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }`,
    }, target.sessionId) as { result?: { value?: unknown } } & ScriptResponse
    if (response.exceptionDetails || response.result?.value !== true) {
      throw scriptFailure('select browser option', response)
    }
  }

  /**
   * Hand files to the page as in-memory File objects; nothing is written to disk.
   * Without a ref, the file picker the page just tried to open receives them.
   */
  async upload(tabId: string, contents: WebContents, snapshotId: string | undefined, ref: string | undefined, files: BrowserUploadFile[], method: BrowserUploadMethod, assertActive: () => void = () => {}): Promise<BrowserUploadResult> {
    await this.ensureAttached(contents)
    this.assertNoDialog(contents)
    const state = this.cdp(contents)
    let target: Pick<ElementTarget, 'backendDOMNodeId' | 'sessionId'>
    if (ref) {
      if (!snapshotId) throw new Error('snapshot_id is required with ref')
      target = this.resolveRef(tabId, snapshotId, ref)
    } else {
      const chooser = state.fileChooser
      if (!chooser) throw new Error('No intercepted file picker is waiting; pass the ref of the upload control instead')
      if (files.length > 1 && !chooser.multiple) throw new Error('This file picker accepts only one file')
      target = { backendDOMNodeId: chooser.backendNodeId, sessionId: chooser.sessionId }
      method = 'input'
    }
    const objectId = await this.resolveObject(contents, target)
    try {
      assertActive()
      const response = await state.send('Runtime.callFunctionOn', {
        objectId, returnByValue: true, functionDeclaration: UPLOAD_FUNCTION,
        arguments: [{ value: files }, { value: method }],
      }, target.sessionId) as { result?: { value?: BrowserUploadResult } } & ScriptResponse
      const result = response.result?.value
      if (response.exceptionDetails || !result || !Array.isArray(result.files)) {
        throw scriptFailure('upload files', response)
      }
      if (!ref) state.fileChooser = undefined
      return result
    } finally {
      await state.send('Runtime.releaseObject', { objectId }, target.sessionId).catch(() => undefined)
      this.invalidate(tabId)
    }
  }

  async downloadSource(tabId: string, contents: WebContents, snapshotId: string, ref: string): Promise<{ url: string; fileName: string }> {
    await this.ensureAttached(contents)
    this.assertNoDialog(contents)
    const state = this.cdp(contents)
    const target = this.resolveRef(tabId, snapshotId, ref)
    const objectId = await this.resolveObject(contents, target)
    try {
      const response = await state.send('Runtime.callFunctionOn', {
        objectId, returnByValue: true, functionDeclaration: DOWNLOAD_SOURCE_FUNCTION,
      }, target.sessionId) as { result?: { value?: { url?: unknown; fileName?: unknown } } } & ScriptResponse
      const value = response.result?.value
      if (response.exceptionDetails || typeof value?.url !== 'string' || !value.url) {
        throw scriptFailure('find a download URL', response)
      }
      return { url: value.url, fileName: typeof value.fileName === 'string' ? value.fileName : '' }
    } finally {
      await state.send('Runtime.releaseObject', { objectId }, target.sessionId).catch(() => undefined)
    }
  }

  async readPageBlob(contents: WebContents, url: string, limit: number): Promise<{ data: Buffer; type: string }> {
    await this.ensureAttached(contents)
    this.assertNoDialog(contents)
    const response = await this.cdp(contents).send('Runtime.evaluate', {
      expression: `(${PAGE_BLOB_FUNCTION})(${JSON.stringify(url)}, ${limit})`, awaitPromise: true, returnByValue: true,
    }) as { result?: { value?: { data?: unknown; type?: unknown } } } & ScriptResponse
    const value = response.result?.value
    if (response.exceptionDetails || typeof value?.data !== 'string') {
      throw scriptFailure('read page blob', response)
    }
    return { data: Buffer.from(value.data, 'base64'), type: typeof value.type === 'string' ? value.type : '' }
  }

  /** Poll rendered text until it appears or disappears; never interacts with the page. */
  async wait(tabId: string, contents: WebContents, options: BrowserWaitOptions, assertActive: () => void = () => {}): Promise<BrowserWaitResult> {
    await this.ensureAttached(contents)
    const state = this.cdp(contents)
    const started = Date.now()
    const expression = `(() => { const text = document.body ? document.body.innerText : '';
      return { has: ${JSON.stringify(options.text ?? null)} === null || text.includes(${JSON.stringify(options.text ?? '')}),
        gone: ${JSON.stringify(options.textGone ?? null)} === null || !text.includes(${JSON.stringify(options.textGone ?? '')}) } })()`
    while (true) {
      assertActive()
      this.assertNoDialog(contents)
      const evaluated = await state.untilDialog(state.send('Runtime.evaluate', { expression, returnByValue: true }).catch(() => ({})))
      if (evaluated === 'dialog') this.assertNoDialog(contents)
      const value = (evaluated as { result?: { value?: { has?: boolean; gone?: boolean } } }).result?.value
      const matched = !!value?.has && !!value?.gone
      const elapsedMs = Date.now() - started
      if (matched || elapsedMs >= options.timeoutMs) {
        this.invalidate(tabId)
        return { tabId, matched, elapsedMs, url: publicBrowserUrl(contents.getURL()) }
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(WAIT_POLL_MS, options.timeoutMs - elapsedMs)))
    }
  }

  async screenshot(tabId: string, contents: WebContents, fullPage = false): Promise<BrowserScreenshot> {
    await this.ensureAttached(contents)
    const metrics = await contents.debugger.sendCommand('Page.getLayoutMetrics') as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
      cssContentSize?: { width?: number; height?: number }
    }
    const source = fullPage
      ? { width: metrics.cssContentSize?.width, height: metrics.cssContentSize?.height }
      : { width: metrics.cssVisualViewport?.clientWidth, height: metrics.cssVisualViewport?.clientHeight }
    let width = Math.max(1, Math.min(8192, Math.ceil(source.width || 1)))
    let height = Math.max(1, Math.min(8192, Math.ceil(source.height || 1)))
    const maxPixels = 32_000_000
    if (width * height > maxPixels) height = Math.max(1, Math.floor(maxPixels / width))
    let response: { data?: string }
    let screenshotTimer: NodeJS.Timeout | undefined
    try {
      response = await Promise.race([
        contents.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: fullPage,
          ...(fullPage ? { clip: { x: 0, y: 0, width, height, scale: 1 } } : {}),
        }) as Promise<{ data?: string }>,
        new Promise<never>((_resolve, reject) => {
          screenshotTimer = setTimeout(() => reject(new Error('Browser screenshot timed out')), 15_000)
          screenshotTimer.unref?.()
        }),
      ])
    } catch (error) {
      this.detach(tabId, contents)
      throw error
    } finally {
      if (screenshotTimer) clearTimeout(screenshotTimer)
    }
    const data = response.data || ''
    if (!data) throw new Error('Browser screenshot was empty')
    if (Buffer.byteLength(data, 'base64') > MAX_SCREENSHOT_BYTES) throw new Error('Browser screenshot exceeds the 12 MB safety limit')
    return { tabId, url: publicBrowserUrl(contents.getURL()), title: redactBrowserText(contents.getTitle()), mediaType: 'image/png', data, width, height }
  }

  private async ensureAttached(contents: WebContents): Promise<void> {
    if (contents.isDestroyed()) throw new Error('Browser tab is closed')
    const state = this.cdp(contents)
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach('1.3')
      state.reset()
    }
    state.listen()
    if (!state.configured) {
      // Dialog, file chooser and network events need their domains before the first action.
      state.configured = true
      await state.configureSession()
      return
    }
    await state.send('Page.enable')
    await state.send('DOM.enable')
  }

  private assertNoDialog(contents: WebContents): void {
    const dialog = this.pageDialog(contents)
    if (dialog) throw dialogError(dialog)
  }

  private resolveRef(tabId: string, snapshotId: string, ref: string): ElementTarget {
    const stored = this.snapshots.get(tabId)
    if (!stored || stored.id !== snapshotId) throw new Error('Browser snapshot is stale; take a new snapshot before interacting')
    const target = stored.refs.get(ref)
    if (!target) throw new Error(`Unknown browser element reference: ${ref}`)
    return target
  }

  private async resolveObject(contents: WebContents, target: Pick<ElementTarget, 'backendDOMNodeId' | 'sessionId'>): Promise<string> {
    const response = await this.cdp(contents).send('DOM.resolveNode', { backendNodeId: target.backendDOMNodeId }, target.sessionId) as { object?: { objectId?: string } }
    if (!response.object?.objectId) throw new Error('Browser element is no longer available')
    return response.object.objectId
  }

}
