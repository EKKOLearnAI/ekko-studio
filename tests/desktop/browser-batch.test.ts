import type { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseBrowserBatchActions } from '../../packages/desktop/src/main/browser/browser-batch'

vi.mock('electron', () => ({
  app: { getLocale: () => 'en' }, BrowserWindow: class {}, WebContentsView: class {},
  dialog: { showMessageBox: vi.fn() }, Menu: {}, session: {}, shell: {},
}))

import { dialog } from 'electron'
import { BrowserManager } from '../../packages/desktop/src/main/browser/browser-manager'

afterEach(() => vi.restoreAllMocks())

async function setup() {
  const page = {
    nodes: [{ id: 1, role: 'button', name: 'First' }, { id: 2, role: 'button', name: 'Second' }, { id: 3, role: 'textbox', name: 'Name' }] as Array<{ id: number; role: string; name: string; value?: string; checked?: boolean }>,
    effects: [] as string[],
    url: 'https://example.com/',
    cancelled: false,
    onEffect: (_effect: string): void | Promise<void> => {},
  }
  const contents = {
    getURL: () => page.url, getTitle: () => 'Example', isDestroyed: () => false, isLoading: () => false, focus: vi.fn(),
    debugger: {
      isAttached: () => true,
      sendCommand: vi.fn(async (method: string, params: any = {}) => {
        if (method === 'Accessibility.getFullAXTree') return {
          nodes: page.nodes.map(node => ({ backendDOMNodeId: node.id, role: { value: node.role }, name: { value: node.name },
            ...(node.value !== undefined ? { value: { value: node.value } } : {}),
            properties: node.checked !== undefined ? [{ name: 'checked', value: { value: String(node.checked) } }] : [] })),
        }
        if (method === 'DOM.resolveNode') return { object: { objectId: `node-${params.backendNodeId}` } }
        let effect = ''
        // Readiness probes and pointer measurement only scroll; they are not page effects.
        if (method === 'Runtime.callFunctionOn' && params.functionDeclaration.includes('covered')) return { result: { value: null } }
        if (method === 'Runtime.callFunctionOn' && !params.functionDeclaration.includes("return 'not visible'")) effect = `${params.functionDeclaration.includes('target.click') ? 'click' : 'focus'}:${params.objectId}`
        if (method === 'Input.insertText') effect = `type:${params.text}`
        if (method === 'Input.dispatchKeyEvent') effect = `${params.type}:${params.key}`
        if (method === 'Runtime.evaluate') effect = 'scroll'
        if (effect) {
          page.effects.push(effect)
          await page.onEffect(effect)
        }
        return { result: { value: true } }
      }),
    },
  }
  const manager = new BrowserManager({} as BrowserWindow, '/tmp/studio-browser-batch-unused')
  const internal = manager as any
  const record = { tab: { id: 'tab', url: page.url, agentControl: 'active' }, view: { webContents: contents }, console: [] }
  internal.records.set('tab', record)
  internal.profileStore.list = () => []
  internal.withAutomationView = (_record: unknown, run: () => unknown) => run()
  const snapshot = await manager.snapshot('tab')
  const assertControl = () => { if (page.cancelled) throw new Error('Browser batch was cancelled by user takeover') }
  const batch = (actions: unknown, snapshotId: unknown = snapshot.snapshotId) => manager.interactBatch('tab', actions, snapshotId, assertControl)
  return { manager, internal, record, contents, page, snapshot, batch }
}

describe('desktop browser batch interactions', () => {
  it('runs multiple clicks and mixed actions using original refs despite changing snapshot numbering', async () => {
    const { page, batch, manager, snapshot } = await setup()
    page.onEffect = effect => {
      if (effect === 'click:node-1') page.nodes.unshift({ id: 99, role: 'button', name: 'Inserted' })
    }
    const result = await batch([
      { action: 'click', ref: '@e1' }, { action: 'click', ref: '@e2' },
      { action: 'type', ref: '@e3', text: 'Example' }, { action: 'press', key: 'Tab' },
      { action: 'scroll', direction: 'down', pixels: 200 },
    ])
    expect(result.completed).toBe(5)
    expect(result.results.map(row => row.status)).toEqual(Array(5).fill('completed'))
    expect(page.effects).toEqual(['click:node-1', 'click:node-2', 'focus:node-3', 'type:Example', 'keyDown:Tab', 'keyUp:Tab', 'scroll'])
    expect(result.snapshot?.snapshotId).not.toBe(snapshot.snapshotId)
    expect(result.snapshot?.nodes[0].name).toBe('Inserted')
    await expect(manager.interact('tab', { action: 'click', snapshot_id: snapshot.snapshotId, ref: '@e1' })).rejects.toThrow('stale')
  })

  it('stops at a removed target without clicking the new element at the same ref number', async () => {
    const { page, batch } = await setup()
    page.onEffect = () => { page.nodes = page.nodes.filter(node => node.id !== 2) }
    const result = await batch([{ action: 'click', ref: '@e1' }, { action: 'click', ref: '@e2' }, { action: 'press', key: 'Enter' }])
    expect(page.effects).toEqual(['click:node-1'])
    expect(result.completed).toBe(1)
    expect(result.results).toEqual([
      { index: 0, action: 'click', status: 'completed' },
      { index: 1, action: 'click', status: 'failed', error: expect.stringContaining('no longer available') },
      { index: 2, action: 'press', status: 'skipped' },
    ])
    expect(result.snapshot).toBeDefined()
  })

  it('validates the entire request and all initial references before any action', async () => {
    const { batch, page } = await setup()
    await expect(batch([{ action: 'click', ref: '@e1' }, { action: 'press', key: '' }])).rejects.toThrow('index 1')
    await expect(batch([{ action: 'click', ref: '@e1' }, { action: 'click', ref: '@e99' }])).rejects.toThrow('Unknown browser element')
    await expect(batch([{ action: 'click', ref: '@e1' }], 'stale')).rejects.toThrow('stale')
    await expect(batch([{ action: 'click', ref: '@e1' }], null)).rejects.toThrow('snapshot_id')
    expect(page.effects).toEqual([])
  })

  it('allows press/scroll-only batches without a snapshot', async () => {
    const { batch, page } = await setup()
    expect((await batch([{ action: 'press', key: 'Tab' }, { action: 'scroll', direction: 'down' }], null)).completed).toBe(2)
    expect(page.effects).toEqual(['keyDown:Tab', 'keyUp:Tab', 'scroll'])
  })

  it.each(['navigation', 'same-url reload', 'closed tab'])('stops later actions after %s', async mode => {
    const { page, batch, internal, record } = await setup()
    page.onEffect = () => {
      if (mode === 'navigation') { page.url = 'https://example.com/next'; Object.assign(record, { documentGeneration: 1 }) }
      if (mode === 'same-url reload') Object.assign(record, { documentGeneration: 1 })
      if (mode === 'closed tab') internal.records.delete('tab')
    }
    const result = await batch([{ action: 'click', ref: '@e1' }, { action: 'click', ref: '@e2' }, { action: 'press', key: 'Tab' }])
    expect(result.completed).toBe(1)
    expect(result.results.map(row => row.status)).toEqual(['completed', 'failed', 'skipped'])
    expect(page.effects).toEqual(['click:node-1'])
  })

  it('stops later actions when the execution budget expires', async () => {
    const { page, batch } = await setup()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    page.onEffect = () => { now += 30_001 }
    const result = await batch([{ action: 'click', ref: '@e1' }, { action: 'click', ref: '@e2' }])
    expect(result.completed).toBe(1)
    expect(result.results[1].error).toContain('timed out')
    expect(page.effects).toEqual(['click:node-1'])
  })

  it('continues same-document SKU URL changes using the original DOM targets', async () => {
    const { page, batch, manager } = await setup()
    page.onEffect = effect => {
      if (effect === 'click:node-1') { page.url += '?sku=gold'; (manager as any).automation.invalidate('tab') }
      if (effect === 'click:node-2') page.nodes[1].checked = true
    }
    const result = await batch([{ action: 'click', ref: '@e1' }, { action: 'click', ref: '@e2' }])
    expect(result.completed).toBe(2)
    expect(result.observation).toMatchObject({ changed: true, navigation: 'same_document',
      targets: [{ after: { name: 'First' } }, { after: { checked: true } }] })
    expect(page.effects).toEqual(['click:node-1', 'click:node-2'])
  })

  it('reports no observed change after a no-op click without replaying it', async () => {
    const { manager, snapshot, page } = await setup()
    const result = await manager.interact('tab', { action: 'click', ref: '@e1', snapshot_id: snapshot.snapshotId })
    expect(result.observation).toMatchObject({ status: 'observed', changed: false, changeCount: 0 })
    expect(result.snapshot?.snapshotId).not.toBe(snapshot.snapshotId)
    expect(page.effects).toEqual(['click:node-1'])
  })

  it('observes asynchronous form updates locally without JEV', async () => {
    const { manager, snapshot, page } = await setup()
    page.onEffect = effect => { if (effect === 'type:Alice') setTimeout(() => { page.nodes[2].value = 'Alice' }, 30) }
    const result = await manager.interact('tab', { action: 'type', ref: '@e3', text: 'Alice', snapshot_id: snapshot.snapshotId })
    expect(result.observation).toMatchObject({ changed: true, targets: [{ valueMatches: true, after: { value: 'Alice' } }] })
    expect(page.effects.filter(effect => effect.startsWith('type:'))).toEqual(['type:Alice'])
  })

  it('returns the popup destination and ignores unrelated new tabs', async () => {
    const { manager, snapshot, page, internal, record } = await setup()
    page.onEffect = () => {
      internal.records.set('other', { ...record, tab: { ...record.tab, id: 'other' } })
      internal.records.set('popup', { ...record, openerTabId: 'tab', tab: { ...record.tab, id: 'popup', title: 'Destination' } })
    }
    const result = await manager.interact('tab', { action: 'click', ref: '@e1', snapshot_id: snapshot.snapshotId })
    expect(result.observation).toMatchObject({ tabId: 'tab', openedTabs: [{ id: 'popup' }] })
    expect(result.observation?.openedTabs).toHaveLength(1)
    expect(result.snapshot?.tabId).toBe('popup')
  })

  it('executes every batch step without keyword classification or a confirmation dialog', async () => {
    const { page, batch } = await setup()
    page.onEffect = () => { page.nodes[1].name = 'Delete account' }
    const result = await batch([{ action: 'click', ref: '@e1' }, { action: 'click', ref: '@e2' }, { action: 'press', key: 'Tab' }])
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(result.completed).toBe(3)
    expect(page.effects).toEqual(['click:node-1', 'click:node-2', 'keyDown:Tab', 'keyUp:Tab'])
  })

  it('stops the remaining batch steps after user takeover', async () => {
    const { page, batch, manager } = await setup()
    page.onEffect = () => { page.cancelled = true; manager.cancelAgentOperation('tab') }
    const result = await batch([{ action: 'click', ref: '@e1' }, { action: 'click', ref: '@e2' }])
    expect(result.completed).toBe(1)
    expect(result.results[1].error).toContain('takeover')
    expect(result.snapshot).toBeUndefined()
    expect(page.effects).toEqual(['click:node-1'])
    expect(manager.state().tabs[0].agentControl).toBe('idle')
  })

  it('stops at a page dialog, reports it instead of a snapshot, and continues after it is answered', async () => {
    const { page, batch, manager, contents } = await setup()
    const listeners: Array<(...args: any[]) => void> = []
    Object.assign(contents.debugger, { on: (event: string, listener: (...args: any[]) => void) => { if (event === 'message') listeners.push(listener) } })
    await manager.snapshot('tab')
    const fresh = await manager.snapshot('tab')
    page.onEffect = effect => {
      if (effect === 'click:node-1') {
        for (const listener of listeners) listener({}, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Saved', url: page.url })
        return new Promise(() => {})
      }
    }
    const result = await batch([{ action: 'click', ref: '@e1' }, { action: 'click', ref: '@e2' }], fresh.snapshotId)
    expect(result.results.map(item => item.status)).toEqual(['completed', 'skipped'])
    expect(result.snapshot).toBeUndefined()
    expect(result.observation).toMatchObject({ dialog: { type: 'alert', message: 'Saved' }, hint: expect.stringContaining('ekko_studio_browser_dialog') })
    expect(page.effects).toEqual(['click:node-1'])
    expect(manager.pageDialog('tab')).toMatchObject({ type: 'alert' })

    page.onEffect = () => {}
    const answered = await manager.handleDialog('tab', true)
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: true })
    expect(answered.dialog.type).toBe('alert')
    expect(answered.snapshot?.nodes).toHaveLength(3)
    expect(manager.pageDialog('tab')).toBeUndefined()
  })

  it('keeps native alert/confirm boxes off screen while the agent controls the tab', async () => {
    const { EventEmitter } = await import('node:events')
    const { manager, internal, record, contents } = await setup()
    const shown: unknown[] = []
    const emitter = Object.assign(new EventEmitter(), contents)
    emitter.on('-run-dialog', (info: unknown) => { shown.push(info) })
    record.view.webContents = emitter
    internal.routePageDialogs(record)

    // The agent controls the tab: Electron's box is not shown; the agent answers via DevTools.
    emitter.emit('-run-dialog', 'agent-confirm', () => {})
    expect(shown).toEqual([])
    expect(record.heldDialog).toMatchObject({ info: 'agent-confirm' })

    // The user takes over before the agent answered: the box is handed to the user.
    internal.automation.pageDialog = () => ({ type: 'confirm' })
    manager.revokeAgentControl('tab')
    expect(shown).toEqual(['agent-confirm'])
    expect(record.heldDialog).toBeUndefined()

    // The user's own browsing keeps Electron's normal native box.
    emitter.emit('-run-dialog', 'user-alert', () => {})
    expect(shown).toEqual(['agent-confirm', 'user-alert'])

    // Answered by the agent, then released: nothing is replayed.
    manager.setAgentControl('tab', 'active')
    emitter.emit('-run-dialog', 'answered', () => {})
    internal.automation.pageDialog = () => undefined
    manager.revokeAgentControl('tab')
    expect(shown).toEqual(['agent-confirm', 'user-alert'])
  })

  it('intercepts file pickers only while the agent controls the tab', async () => {
    const { manager, contents } = await setup()
    manager.setAgentControl('tab', 'idle')
    manager.setAgentControl('tab', 'active')
    manager.setAgentControl('tab', 'active')
    manager.revokeAgentControl('tab')
    await new Promise(resolve => setTimeout(resolve, 0))
    const toggles = contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Page.setInterceptFileChooserDialog').map(([, params]) => params.enabled)
    // The fixture tab starts under agent control; repeated active states do not re-send.
    expect(toggles).toEqual([false, true, false])
  })

  it('uses the configured download preferences for Agent downloads', async () => {
    const { internal, manager, record, contents } = await setup()
    record.tab.profileId = 'profile'
    manager.setAgentControl('tab', 'active', 'Agent', 'click')
    const item = { getFilename: () => 'example.zip', getURL: () => 'https://example.com/example.zip',
      getTotalBytes: () => 100, setSaveDialogOptions: vi.fn(), setSavePath: vi.fn(), on: vi.fn(), once: vi.fn() }
    internal.handleDownload({ id: 'profile', downloadPath: '/tmp/studio-browser-batch-unused/downloads', askBeforeDownload: false, downloadConflictPolicy: 'ask' }, item, contents)
    expect(item.setSavePath).toHaveBeenCalledWith(join('/tmp/studio-browser-batch-unused/downloads', 'example.zip'))
    expect(item.setSaveDialogOptions).not.toHaveBeenCalled()
    internal.handleDownload({ id: 'profile', downloadPath: '/tmp/studio-browser-batch-unused/downloads', askBeforeDownload: true, downloadConflictPolicy: 'ask' }, item, contents)
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith({ defaultPath: join('/tmp/studio-browser-batch-unused/downloads', 'example.zip') })
  })

  it('checks for cancellation after DOM resolution and before page side effects', async () => {
    const { batch, page, contents } = await setup()
    const original = contents.debugger.sendCommand.getMockImplementation()!
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      const response = await original(method, params)
      if (method === 'DOM.resolveNode') page.cancelled = true
      return response
    })
    const result = await batch([{ action: 'click', ref: '@e1' }, { action: 'click', ref: '@e2' }])
    expect(result.completed).toBe(0)
    expect(page.effects).toEqual([])
    expect(result.results[0].error).toContain('takeover')
  })

  it('does not type after the target rejects focus', async () => {
    const { batch, page, contents } = await setup()
    const original = contents.debugger.sendCommand.getMockImplementation()!
    contents.debugger.sendCommand.mockImplementation((method, params) => method === 'Runtime.callFunctionOn'
      ? Promise.resolve({ exceptionDetails: {} } as any) : original(method, params))
    const result = await batch([{ action: 'type', ref: '@e3', text: 'secret' }, { action: 'press', key: 'Tab' }])
    expect(result.results[0].error).toContain('Unable to focus')
    expect(page.effects).toEqual([])
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})

describe('batch request validation', () => {
  it.each([null, [], Array(51).fill({ action: 'press', key: 'Tab' }), [{ action: 'navigate', url: 'https://example.com' }],
    [{ action: 'scroll', direction: 'diagonal' }], [{ action: 'scroll', direction: 'down', pixels: Infinity }],
    [{ action: 'click', ref: '@e1', script: 'alert(1)' }], [{ action: 'type', ref: '@e1', text: 1 }],
    [{ action: 'constructor' }], [{ action: 'click', ref: '' }],
  ])('rejects malformed or oversized batches: %j', value => {
    expect(() => parseBrowserBatchActions(value)).toThrow()
  })

  it('accepts pointer, drag and coordinate steps and rejects malformed ones', () => {
    expect(parseBrowserBatchActions([
      { action: 'double_click', ref: '@e1' }, { action: 'right_click', ref: '@e1' }, { action: 'drag', ref: '@e1', target_ref: '@e2' },
      { action: 'click_at', x: 10, y: 20, button: 'right', click_count: 2 }, { action: 'drag_at', x: 1, y: 2, to_x: 3, to_y: 4 },
    ])).toEqual([
      { action: 'double_click', ref: '@e1' }, { action: 'right_click', ref: '@e1' }, { action: 'drag', ref: '@e1', target_ref: '@e2' },
      { action: 'click_at', x: 10, y: 20, button: 'right', click_count: 2 }, { action: 'drag_at', x: 1, y: 2, to_x: 3, to_y: 4 },
    ])
    for (const bad of [{ action: 'drag', ref: '@e1' }, { action: 'click_at', x: -1, y: 0 }, { action: 'click_at', x: 1, y: 1, click_count: 3 },
      { action: 'click_at', x: 1, y: 1, button: 'back' }, { action: 'drag_at', x: 1, y: 1, to_x: 2 }, { action: 'click_at', x: '1', y: 1 }]) {
      expect(() => parseBrowserBatchActions([bad])).toThrow()
    }
  })

  it('accepts hover and select steps with their required fields', () => {
    expect(parseBrowserBatchActions([{ action: 'hover', ref: '@e1' }, { action: 'select', ref: '@e2', value: 'cn' }]))
      .toEqual([{ action: 'hover', ref: '@e1' }, { action: 'select', ref: '@e2', value: 'cn' }])
    expect(() => parseBrowserBatchActions([{ action: 'select', ref: '@e2' }])).toThrow()
    expect(() => parseBrowserBatchActions([{ action: 'hover', ref: '@e1', text: 'x' }])).toThrow()
  })
})

describe('desktop browser editing input', () => {
  it('selects existing contenteditable content instead of rewriting the editor DOM', async () => {
    const { JSDOM } = await import('jsdom')
    const { batch, contents } = await setup()
    await batch([{ action: 'type', ref: '@e3', text: 'Example' }])
    const focus = contents.debugger.sendCommand.mock.calls.find(([method, params]: any[]) => method === 'Runtime.callFunctionOn' && params.functionDeclaration.includes('isContentEditable'))
    expect(focus).toBeDefined()
    const dom = new JSDOM('<div contenteditable="true"><div data-block="true"><span>old draft</span></div></div>')
    const editor = dom.window.document.querySelector('[contenteditable]') as HTMLElement & { isContentEditable: boolean }
    Object.defineProperty(editor, 'isContentEditable', { value: true })
    editor.scrollIntoView = () => {}
    const block = editor.firstElementChild
    const run = new dom.window.Function(`return (${focus![1].functionDeclaration})`)() as (this: HTMLElement) => boolean
    expect(run.call(editor)).toBe(true)
    expect(editor.firstElementChild).toBe(block)
    expect(dom.window.document.getSelection()?.toString()).toBe('old draft')
  })

  it('adds macOS editing commands to Cmd shortcuts only', async () => {
    const { editingCommands } = await import('../../packages/desktop/src/main/browser/browser-automation')
    expect(editingCommands('KeyA', 4, 'darwin')).toEqual(['selectAll'])
    expect(editingCommands('KeyV', 4, 'darwin')).toEqual(['paste'])
    expect(editingCommands('KeyZ', 4 | 8, 'darwin')).toEqual(['redo'])
    expect(editingCommands('KeyV', 4 | 8, 'darwin')).toEqual([])
    expect(editingCommands('KeyA', 2, 'darwin')).toEqual([])
    expect(editingCommands('KeyA', 4 | 1, 'darwin')).toEqual([])
    expect(editingCommands('KeyA', 2, 'linux')).toEqual([])
    expect(editingCommands('KeyA', 4, 'win32')).toEqual([])
  })

  it('sends the editing command with the synthetic Cmd key press', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      const { batch, contents } = await setup()
      await batch([{ action: 'press', key: 'Meta+A' }], null)
      const keyEvents = contents.debugger.sendCommand.mock.calls.filter(([method]: any[]) => method === 'Input.dispatchKeyEvent').map(([, params]: any[]) => params)
      expect(keyEvents[0]).toMatchObject({ type: 'keyDown', code: 'KeyA', modifiers: 4, commands: ['selectAll'] })
      expect(keyEvents[1]).not.toHaveProperty('commands')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })
})
