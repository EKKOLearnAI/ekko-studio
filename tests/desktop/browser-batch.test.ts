import type { BrowserWindow } from 'electron'
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
    nodes: [{ id: 1, role: 'button', name: 'First' }, { id: 2, role: 'button', name: 'Second' }, { id: 3, role: 'textbox', name: 'Name' }],
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
          nodes: page.nodes.map(node => ({ backendDOMNodeId: node.id, role: { value: node.role }, name: { value: node.name } })),
        }
        if (method === 'DOM.resolveNode') return { object: { objectId: `node-${params.backendNodeId}` } }
        let effect = ''
        if (method === 'Runtime.callFunctionOn') effect = `${params.functionDeclaration.includes('target.click') ? 'click' : 'focus'}:${params.objectId}`
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
      if (mode === 'navigation') page.url = 'https://example.com/next'
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

  it('uses current target labels for confirmation and stops when the user declines', async () => {
    const { page, batch } = await setup()
    page.onEffect = () => { page.nodes[1].name = 'Delete account' }
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    const result = await batch([{ action: 'click', ref: '@e1' }, { action: 'click', ref: '@e2' }, { action: 'press', key: 'Tab' }])
    expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ detail: 'Delete account' }))
    expect(result.completed).toBe(1)
    expect(result.results[1].error).toContain('declined')
    expect(page.effects).toEqual(['click:node-1'])
  })

  it('does not resume a batch after takeover while confirmation is open', async () => {
    const { page, batch, manager } = await setup()
    page.onEffect = () => { page.nodes[1].name = 'Delete account' }
    let shown!: () => void
    const opened = new Promise<void>(resolve => { shown = resolve })
    let confirm!: (value: any) => void
    vi.mocked(dialog.showMessageBox).mockImplementationOnce(() => {
      shown()
      return new Promise(resolve => { confirm = resolve })
    })
    const pending = batch([{ action: 'click', ref: '@e1' }, { action: 'click', ref: '@e2' }, { action: 'press', key: 'Enter' }])
    await opened
    page.cancelled = true
    manager.cancelAgentOperation('tab')
    confirm({ response: 1, checkboxChecked: false })
    const result = await pending
    expect(result.completed).toBe(1)
    expect(result.results[1].error).toContain('takeover')
    expect(result.snapshot).toBeUndefined()
    expect(page.effects).toEqual(['click:node-1'])
    expect(manager.state().tabs[0].agentControl).toBe('idle')
  })

  it('does not execute a confirmation accepted after the batch budget expires', async () => {
    const { page, batch, manager } = await setup()
    page.onEffect = () => { page.nodes[1].name = 'Delete account' }
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.mocked(dialog.showMessageBox).mockImplementationOnce(async () => {
      now += 30_001
      return { response: 1, checkboxChecked: false }
    })
    const result = await batch([{ action: 'click', ref: '@e1' }, { action: 'click', ref: '@e2' }])
    expect(result.completed).toBe(1)
    expect(result.results[1].error).toContain('timed out')
    expect(page.effects).toEqual(['click:node-1'])
    expect(manager.state().tabs[0].agentControl).toBe('idle')
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
})
