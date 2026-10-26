import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { BrowserAutomation } from '../../packages/desktop/src/main/browser/browser-automation'
import { CdpTabState } from '../../packages/desktop/src/main/browser/browser-cdp'

type Handler = (method: string, params: Record<string, any>, sessionId?: string) => unknown

interface Sent { method: string; params: Record<string, any>; sessionId?: string }

// A DevTools fake that records commands (with their session) and can push events.
function fakePage(handler: Handler = () => undefined) {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {}
  const sent: Sent[] = []
  let attached = false
  const emit = (method: string, params: Record<string, any> = {}, sessionId?: string) => {
    for (const listener of listeners.message || []) listener({}, method, params, sessionId)
  }
  const contents = {
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true },
      detach: () => { attached = false },
      on: (event: string, listener: (...args: any[]) => void) => { (listeners[event] ||= []).push(listener) },
      removeListener: (event: string, listener: (...args: any[]) => void) => {
        listeners[event] = (listeners[event] || []).filter(item => item !== listener)
      },
      sendCommand: async (method: string, params: Record<string, any> = {}, sessionId?: string) => {
        sent.push({ method, params, sessionId })
        const result = await handler(method, params, sessionId)
        if (result !== undefined) return result
        if (method === 'Accessibility.getFullAXTree') return { nodes: [{ backendDOMNodeId: 7, role: { value: 'button' }, name: { value: 'Target' } }] }
        if (method === 'DOM.resolveNode') return { object: { objectId: `object-${sessionId || 'main'}-${params.backendNodeId}` } }
        if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }
        if (method === 'Runtime.callFunctionOn') {
          if (String(params.functionDeclaration).includes('covered')) return { result: { value: { x: 100, y: 50, covered: false } } }
          return { result: { value: true } }
        }
        return {}
      },
    },
    isDestroyed: () => false,
    getURL: () => 'https://example.com/',
    getTitle: () => 'Example',
  } as unknown as WebContents
  const mouse = () => sent.filter(item => item.method === 'Input.dispatchMouseEvent').map(item => item.params)
  return { contents, sent, emit, mouse }
}

async function ready(automation: BrowserAutomation, contents: WebContents) {
  return (await automation.snapshot('tab', contents)).snapshotId
}

describe('trusted pointer input', () => {
  it('clicks with real mouse events at the element center instead of element.click()', async () => {
    const automation = new BrowserAutomation()
    const page = fakePage()
    const snapshotId = await ready(automation, page.contents)
    await automation.interact('tab', page.contents, { action: 'click', ref: '@e1', snapshot_id: snapshotId })
    expect(page.mouse()).toEqual([
      { type: 'mouseMoved', x: 100, y: 50 },
      { type: 'mousePressed', x: 100, y: 50, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseReleased', x: 100, y: 50, button: 'left', buttons: 0, clickCount: 1 },
    ])
    expect(page.sent.some(item => String(item.params.functionDeclaration || '').includes('target.click()'))).toBe(false)
  })

  it('falls back to a DOM click when an overlay covers the element', async () => {
    const automation = new BrowserAutomation()
    const page = fakePage((method, params) => method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('covered')
      ? { result: { value: { x: 10, y: 10, covered: true } } } : undefined)
    const snapshotId = await ready(automation, page.contents)
    await automation.interact('tab', page.contents, { action: 'click', ref: '@e1', snapshot_id: snapshotId })
    expect(page.mouse()).toEqual([])
    expect(page.sent.some(item => String(item.params.functionDeclaration || '').includes('target.click()'))).toBe(true)
  })

  it('double-clicks and right-clicks, refusing covered targets', async () => {
    const automation = new BrowserAutomation()
    let covered = false
    const page = fakePage((method, params) => method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('covered')
      ? { result: { value: { x: 5, y: 6, covered } } } : undefined)
    await automation.interact('tab', page.contents, { action: 'double_click', ref: '@e1', snapshot_id: await ready(automation, page.contents) })
    expect(page.mouse().filter(event => event.type === 'mousePressed').map(event => event.clickCount)).toEqual([1, 2])
    page.sent.length = 0
    await automation.interact('tab', page.contents, { action: 'right_click', ref: '@e1', snapshot_id: await ready(automation, page.contents) })
    expect(page.mouse().find(event => event.type === 'mousePressed')).toMatchObject({ button: 'right', buttons: 2 })
    covered = true
    await expect(automation.interact('tab', page.contents, { action: 'right_click', ref: '@e1', snapshot_id: await ready(automation, page.contents) }))
      .rejects.toThrow('covers')
  })

  it('clicks viewport coordinates and rejects points outside the viewport', async () => {
    const automation = new BrowserAutomation()
    const page = fakePage()
    await automation.interact('tab', page.contents, { action: 'click_at', x: 20, y: 30, button: 'middle' })
    expect(page.mouse()[1]).toMatchObject({ type: 'mousePressed', x: 20, y: 30, button: 'middle', buttons: 4 })
    await expect(automation.interact('tab', page.contents, { action: 'click_at', x: 900, y: 30 })).rejects.toThrow('outside the 800x600 viewport')
    await expect(automation.interact('tab', page.contents, { action: 'click_at', x: -1, y: 30 })).rejects.toThrow('coordinate')
  })

  it('replays HTML5 drag and drop through intercepted drag data', async () => {
    const automation = new BrowserAutomation()
    let emit: (method: string, params?: Record<string, any>) => void = () => {}
    const data = { items: [{ mimeType: 'text/plain', data: 'card-1' }], dragOperationsMask: 1 }
    const page = fakePage((method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && params.buttons === 1) emit('Input.dragIntercepted', { data })
      return undefined
    })
    emit = page.emit
    await automation.interact('tab', page.contents, { action: 'drag_at', x: 10, y: 10, to_x: 210, to_y: 110 })
    const drags = page.sent.filter(item => item.method === 'Input.dispatchDragEvent').map(item => item.params)
    expect(drags.map(item => item.type)).toEqual(['dragEnter', 'dragOver', 'drop'])
    expect(drags[2]).toEqual({ type: 'drop', x: 210, y: 110, data })
    expect(page.mouse().at(-1)).toMatchObject({ type: 'mouseReleased', x: 210, y: 110 })
    expect(page.sent.filter(item => item.method === 'Input.setInterceptDrags').map(item => item.params.enabled)).toEqual([true, false])
  })

  it('moves the pressed pointer for non-HTML5 drags such as sliders', async () => {
    const automation = new BrowserAutomation()
    const page = fakePage()
    await automation.interact('tab', page.contents, { action: 'drag_at', x: 0, y: 0, to_x: 80, to_y: 0 })
    const moves = page.mouse().filter(event => event.type === 'mouseMoved' && event.buttons === 1)
    expect(moves).toHaveLength(8)
    expect(moves.at(-1)).toMatchObject({ x: 80, y: 0 })
    expect(page.sent.some(item => item.method === 'Input.dispatchDragEvent')).toBe(false)
  })
})

describe('page dialogs', () => {
  it('stops waiting on a click that opened alert() and blocks further page access until answered', async () => {
    const automation = new BrowserAutomation()
    let emit: (method: string, params?: Record<string, any>) => void = () => {}
    const page = fakePage(method => {
      if (method !== 'Input.dispatchMouseEvent') return undefined
      return new Promise(() => {
        emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete token=abc123?', url: 'https://example.com/?token=x' })
      })
    })
    emit = page.emit
    const snapshotId = await ready(automation, page.contents)
    await automation.interact('tab', page.contents, { action: 'click', ref: '@e1', snapshot_id: snapshotId })
    expect(automation.pageDialog(page.contents)).toMatchObject({ type: 'confirm', url: 'https://example.com/?token=%5Bredacted%5D' })
    await expect(automation.snapshot('tab', page.contents)).rejects.toThrow('ekko_studio_browser_dialog')
    await expect(automation.interact('tab', page.contents, { action: 'press', key: 'Enter' })).rejects.toThrow('confirm dialog is open')

    const emitted: unknown[][] = []
    Object.assign(page.contents, { emit: (...args: unknown[]) => { emitted.push(args); return true } })
    await expect(automation.handleDialog('tab', page.contents, false)).resolves.toMatchObject({ type: 'confirm' })
    // Electron's native confirm box must close once DevTools has answered the page.
    expect(emitted).toEqual([['-cancel-dialogs', { resetState: false }]])
    expect(page.sent.find(item => item.method === 'Page.handleJavaScriptDialog')?.params).toEqual({ accept: false })
    expect(automation.pageDialog(page.contents)).toBeUndefined()
    await expect(automation.handleDialog('tab', page.contents, true)).rejects.toThrow('No page dialog')
  })

  it('answers a prompt in the iframe session that opened it', async () => {
    const automation = new BrowserAutomation()
    const page = fakePage()
    await ready(automation, page.contents)
    page.emit('Page.javascriptDialogOpening', { type: 'prompt', message: 'Name?', defaultPrompt: 'x', url: 'https://frame.test/' }, 'frame-session')
    await automation.handleDialog('tab', page.contents, true, 'Alice')
    expect(page.sent.find(item => item.method === 'Page.handleJavaScriptDialog')).toEqual({
      method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'Alice' }, sessionId: 'frame-session',
    })
  })
})

describe('iframes', () => {
  // main document: button(1) iframe(2 -> same-process frame) iframe(3 -> out-of-process target)
  function framedPage() {
    let emit: (method: string, params?: Record<string, any>, sessionId?: string) => void = () => {}
    const page = fakePage((method, params, sessionId) => {
      if (method === 'Target.setAutoAttach' && !sessionId) {
        emit('Target.attachedToTarget', { sessionId: 'oopif', targetInfo: { type: 'iframe', targetId: 'remote-frame' } })
        emit('Target.attachedToTarget', { sessionId: 'worker', targetInfo: { type: 'worker', targetId: 'w' } })
      }
      if (method === 'Page.getFrameTree' && !sessionId) {
        return { frameTree: { frame: { id: 'main' }, childFrames: [{ frame: { id: 'local-frame' } }, { frame: { id: 'remote-frame' } }] } }
      }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'remote-frame' } } }
      if (method === 'DOM.getFrameOwner') return { backendNodeId: params.frameId === 'local-frame' ? 2 : 3 }
      if (method === 'DOM.getBoxModel') return { model: { content: params.backendNodeId === 3 ? [300, 200, 0, 0, 0, 0, 0, 0] : [10, 20, 0, 0, 0, 0, 0, 0] } }
      if (method === 'Accessibility.getFullAXTree') {
        const node = (id: number, role: string, name: string) => ({ backendDOMNodeId: id, role: { value: role }, name: { value: name } })
        if (sessionId === 'oopif') return { nodes: [node(1, 'button', 'Pay')] }
        if (params.frameId === 'local-frame') return { nodes: [node(1, 'textbox', 'Card')] }
        return { nodes: [node(1, 'button', 'Top'), node(2, 'Iframe', 'Local'), node(3, 'Iframe', 'Remote')] }
      }
      return undefined
    })
    emit = page.emit
    return page
  }

  it('splices same-process and out-of-process iframe content after their owner elements', async () => {
    const automation = new BrowserAutomation()
    const page = framedPage()
    const snapshot = await automation.snapshot('tab', page.contents)
    expect(snapshot.nodes.map(node => `${node.ref} ${node.role} ${node.name}`)).toEqual([
      '@e1 button Top', '@e2 Iframe Local', '@e3 textbox Card', '@e4 Iframe Remote', '@e5 button Pay',
    ])
    await new Promise(resolve => setImmediate(resolve))
    expect(page.sent.find(item => item.method === 'Target.detachFromTarget')?.params).toEqual({ sessionId: 'worker' })
    expect(page.sent.some(item => item.method === 'Network.enable' && item.sessionId === 'oopif')).toBe(true)
  })

  it('never sends commands re-entrantly while Chromium is auto-attaching', async () => {
    const reentrant: string[] = []
    let inside = false
    let emit: (method: string, params?: Record<string, any>, sessionId?: string) => void = () => {}
    const page = fakePage((method, _params, sessionId) => {
      if (inside) reentrant.push(method)
      if (method === 'Target.setAutoAttach' && !sessionId) {
        inside = true
        emit('Target.attachedToTarget', { sessionId: 'oopif', targetInfo: { type: 'iframe', targetId: 'remote-frame' } })
        emit('Target.attachedToTarget', { sessionId: 'worker', targetInfo: { type: 'worker', targetId: 'w' } })
        inside = false
      }
      return undefined
    })
    emit = page.emit
    await new BrowserAutomation().snapshot('tab', page.contents)
    await new Promise(resolve => setImmediate(resolve))
    expect(reentrant).toEqual([])
    expect(page.sent.some(item => item.method === 'Target.detachFromTarget' && item.params.sessionId === 'worker')).toBe(true)
    expect(page.sent.some(item => item.method === 'Page.enable' && item.sessionId === 'oopif')).toBe(true)
  })

  it('keeps refs with the same DOM id distinct and clicks inside an out-of-process iframe at main-viewport coordinates', async () => {
    const automation = new BrowserAutomation()
    const page = framedPage()
    const snapshot = await automation.snapshot('tab', page.contents)
    const keys = new Set(automation.observedState('tab')!.nodes.keys())
    expect(keys).toEqual(new Set(['#1', '#2', '#3', 'oopif#1']))
    await automation.interact('tab', page.contents, { action: 'click', ref: '@e5', snapshot_id: snapshot.snapshotId })
    const measure = page.sent.find(item => String(item.params.functionDeclaration || '').includes('covered'))!
    expect(measure.sessionId).toBe('oopif')
    expect(page.sent.find(item => item.method === 'DOM.getFrameOwner' && item.params.frameId === 'remote-frame' && !item.sessionId)).toBeDefined()
    expect(page.mouse()[1]).toMatchObject({ type: 'mousePressed', x: 400, y: 250 })
  })

  it('prefers same-origin frame offsets measured in the page over DevTools box models', async () => {
    const automation = new BrowserAutomation()
    const page = framedPage()
    const original = page.contents.debugger.sendCommand
    page.contents.debugger.sendCommand = (async (method: string, params: Record<string, any> = {}, sessionId?: string) => {
      if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('covered')) {
        page.sent.push({ method, params, sessionId })
        return { result: { value: { x: 100, y: 50, covered: false, frameX: 297, frameY: 145, crossOrigin: false } } }
      }
      return original(method, params, sessionId)
    }) as typeof original
    const snapshot = await automation.snapshot('tab', page.contents)
    await automation.interact('tab', page.contents, { action: 'double_click', ref: '@e3', snapshot_id: snapshot.snapshotId })
    expect(page.mouse()[1]).toMatchObject({ type: 'mousePressed', x: 397, y: 195 })
    expect(automation.lastPointer(page.contents)).toEqual({ x: 397, y: 195 })
    expect(page.sent.some(item => item.method === 'DOM.getBoxModel')).toBe(false)
  })

  it('offsets a same-process frame by its owner box and types through the main widget', async () => {
    const automation = new BrowserAutomation()
    const page = framedPage()
    const snapshot = await automation.snapshot('tab', page.contents)
    await automation.interact('tab', page.contents, { action: 'click', ref: '@e3', snapshot_id: snapshot.snapshotId })
    expect(page.mouse()[1]).toMatchObject({ x: 110, y: 70 })
    const typing = await automation.snapshot('tab', page.contents)
    await automation.interact('tab', page.contents, { action: 'type', ref: '@e3', snapshot_id: typing.snapshotId, text: '4242' })
    expect(page.sent.find(item => item.method === 'Input.insertText')).toEqual({ method: 'Input.insertText', params: { text: '4242' }, sessionId: undefined })
  })
})

describe('intercepted file pickers', () => {
  it('enables interception while the agent controls the tab and uploads into the intercepted input', async () => {
    const automation = new BrowserAutomation()
    const page = fakePage((method, params) => method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('DataTransfer')
      ? { result: { value: { method: params.arguments[1].value, files: [] } } } : undefined)
    await automation.setFileChooserInterception(page.contents, true)
    await ready(automation, page.contents)
    expect(page.sent.find(item => item.method === 'Page.setInterceptFileChooserDialog')?.params).toEqual({ enabled: true })
    const started = Date.now()
    page.emit('Page.fileChooserOpened', { frameId: 'f', mode: 'selectSingle', backendNodeId: 42 }, 'oopif')
    expect(automation.fileChooserSince(page.contents, started)).toEqual({ multiple: false })

    const files = [{ name: 'a.png', type: 'image/png', data: 'AQID' }]
    await expect(automation.upload('tab', page.contents, undefined, undefined, [...files, ...files], 'auto')).rejects.toThrow('only one file')
    await automation.upload('tab', page.contents, undefined, undefined, files, 'drop')
    const resolved = page.sent.filter(item => item.method === 'DOM.resolveNode').at(-1)!
    expect(resolved).toMatchObject({ params: { backendNodeId: 42 }, sessionId: 'oopif' })
    const call = page.sent.filter(item => item.method === 'Runtime.callFunctionOn').at(-1)!
    expect(call.params.arguments[1]).toEqual({ value: 'input' })
    await expect(automation.upload('tab', page.contents, undefined, undefined, files, 'auto')).rejects.toThrow('No intercepted file picker')

    await automation.setFileChooserInterception(page.contents, false)
    expect(page.sent.filter(item => item.method === 'Page.setInterceptFileChooserDialog').at(-1)?.params).toEqual({ enabled: false })
  })
})

describe('network log', () => {
  it('records redacted request summaries without headers or bodies, including redirects and failures', () => {
    const page = fakePage()
    const state = new CdpTabState(page.contents)
    state.listen()
    page.emit('Network.requestWillBeSent', { requestId: '1', type: 'XHR', request: { method: 'POST', url: 'https://api.test/login?password=hunter2', headers: { Cookie: 'x' } } })
    page.emit('Network.requestWillBeSent', { requestId: '1', type: 'XHR', redirectResponse: { status: 302 }, request: { method: 'GET', url: 'https://api.test/home' } })
    page.emit('Network.responseReceived', { requestId: '1', response: { status: 500, mimeType: 'application/json' } })
    page.emit('Network.loadingFinished', { requestId: '1', encodedDataLength: 12.4 })
    page.emit('Network.requestWillBeSent', { requestId: '2', type: 'Script', request: { method: 'GET', url: 'https://cdn.test/a.js' } }, 'oopif')
    page.emit('Network.loadingFailed', { requestId: '2', errorText: 'net::ERR_BLOCKED_BY_CLIENT' }, 'oopif')

    expect(state.network).toEqual([
      expect.objectContaining({ method: 'POST', url: 'https://api.test/login?password=%5Bredacted%5D', status: 302 }),
      expect.objectContaining({ method: 'GET', url: 'https://api.test/home', status: 500, mimeType: 'application/json', encodedBytes: 12 }),
      expect.objectContaining({ url: 'https://cdn.test/a.js', failed: true, error: 'net::ERR_BLOCKED_BY_CLIENT', frame: 'iframe' }),
    ])
    expect(JSON.stringify(state.network)).not.toContain('hunter2')
    expect(JSON.stringify(state.network)).not.toContain('Cookie')
    state.clearNetwork()
    expect(state.network).toEqual([])
  })

  it('keeps only the most recent entries', () => {
    const page = fakePage()
    const state = new CdpTabState(page.contents)
    state.listen()
    for (let id = 0; id < 320; id++) page.emit('Network.requestWillBeSent', { requestId: String(id), request: { url: `https://x.test/${id}` } })
    expect(state.network).toHaveLength(300)
    expect(state.network[0].url).toBe('https://x.test/20')
  })
})
