import { describe, expect, it } from 'vitest'
import {
  BrowserAutomation,
  CONSOLE_BUFFER_LIMIT,
  MAX_BROWSER_TEXT_READ_LIMIT,
  SCROLL_PIXELS,
} from '../../packages/server/src/modules/studio/services/browser/automation'
import { STALE_SNAPSHOT_MESSAGE } from '../../packages/server/src/modules/studio/services/browser/snapshot'

const TAB_ID = 'tab-1'

interface Command {
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

interface HarnessOptions {
  box?: Record<string, unknown>
  text?: string
  history?: { currentIndex: number, entries: Array<{ id: number, url: string, userTypedURL: string, title: string, transitionType: string }> }
}

let snapshotCounter = 0

function createHarness(options: HarnessOptions = {}) {
  const commands: Command[] = []
  const axNodes = [
    { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Example' }, backendDOMNodeId: 1 },
    { nodeId: '2', ignored: false, role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 3 },
    { nodeId: '3', ignored: false, role: { value: 'paragraph' }, name: { value: 'Body' }, backendDOMNodeId: 4 },
  ]

  const automation = new BrowserAutomation({
    send: async (method, params, sessionId) => {
      commands.push({ method, params, sessionId })
      switch (method) {
        case 'Accessibility.getFullAXTree':
          return { nodes: axNodes }
        case 'DOM.resolveNode':
          return { object: { objectId: `obj-${params?.backendNodeId}` } }
        case 'Runtime.callFunctionOn': {
          const declaration = String(params?.functionDeclaration || '')
          if (declaration.includes('getBoundingClientRect')) {
            return { result: { value: options.box ?? { ok: true, x: 120.4, y: 80.6, width: 40, height: 20 } } }
          }
          if (declaration.includes('isContentEditable')) return { result: { value: true } }
          return { result: { value: { ok: true, text: options.text ?? 'hello world' } } }
        }
        case 'Page.getLayoutMetrics':
          return {
            cssVisualViewport: { clientWidth: 800, clientHeight: 600 },
            cssContentSize: { width: 800, height: 2400 },
          }
        case 'Page.captureScreenshot':
          return { data: Buffer.from('fake-png').toString('base64') }
        case 'Page.getNavigationHistory':
          return options.history ?? { currentIndex: 0, entries: [] }
        default:
          return {}
      }
    },
    getTab: id => (id === TAB_ID
      ? { id, url: 'https://example.com/page', title: 'Example', cdpSessionId: 'sess-1' }
      : null),
    randomId: () => `snap-${++snapshotCounter}`,
    now: () => new Date('2026-10-16T10:00:00.000Z'),
  })

  return { automation, commands }
}

function commandsOf(commands: Command[], method: string): Command[] {
  return commands.filter(command => command.method === method)
}

async function seeded() {
  const harness = createHarness()
  const snapshot = await harness.automation.snapshot(TAB_ID)
  harness.commands.length = 0
  return { ...harness, snapshot }
}

describe('browser automation input', () => {
  it('clicks with move + press + release at the element centre', async () => {
    const { automation, commands, snapshot } = await seeded()

    await automation.interact(TAB_ID, { action: 'click', ref: '@e2', snapshot_id: snapshot.snapshotId })

    const mouse = commandsOf(commands, 'Input.dispatchMouseEvent').map(command => command.params)
    expect(mouse.map(params => params?.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(mouse[0]).toMatchObject({ x: 120, y: 81, button: 'none' })
    expect(mouse[1]).toMatchObject({ x: 120, y: 81, button: 'left', clickCount: 1 })

    // The element object is always released, and the snapshot is invalidated.
    expect(commandsOf(commands, 'Runtime.releaseObject')).toHaveLength(1)
    expect(() => automation.snapshots.resolveRef(TAB_ID, snapshot.snapshotId, '@e2'))
      .toThrow(STALE_SNAPSHOT_MESSAGE)
  })

  it('reports a precise error when the element is not visible or off-viewport', async () => {
    const invisible = createHarness({ box: { ok: false, reason: 'not-visible' } })
    const invisibleSnapshot = await invisible.automation.snapshot(TAB_ID)

    await expect(invisible.automation.interact(TAB_ID, {
      action: 'click',
      ref: '@e2',
      snapshot_id: invisibleSnapshot.snapshotId,
    })).rejects.toThrow('Element is not visible')
    expect(commandsOf(invisible.commands, 'Input.dispatchMouseEvent')).toHaveLength(0)

    const offscreen = createHarness({ box: { ok: false, reason: 'outside-viewport' } })
    const offscreenSnapshot = await offscreen.automation.snapshot(TAB_ID)

    await expect(offscreen.automation.interact(TAB_ID, {
      action: 'click',
      ref: '@e2',
      snapshot_id: offscreenSnapshot.snapshotId,
    })).rejects.toThrow('Element is outside the viewport')
  })

  it('types by clearing the field then using Input.insertText (IME-safe, not per character)', async () => {
    const { automation, commands, snapshot } = await seeded()

    await automation.interact(TAB_ID, {
      action: 'type',
      ref: '@e2',
      snapshot_id: snapshot.snapshotId,
      text: '你好 🙂',
    })

    const calls = commandsOf(commands, 'Runtime.callFunctionOn')
    expect(calls).toHaveLength(1)
    expect(String(calls[0].params?.functionDeclaration)).toContain('isContentEditable')

    const inserts = commandsOf(commands, 'Input.insertText')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].params).toEqual({ text: '你好 🙂' })
    expect(commandsOf(commands, 'Input.dispatchKeyEvent')).toHaveLength(0)
  })

  it.each([
    ['Enter', 0, 'rawKeyDown', 13],
    ['a', 0, 'keyDown', 65],
    ['Meta+K', 4, 'rawKeyDown', 75],
    ['Control+Shift+A', 10, 'rawKeyDown', 65],
  ] as const)('presses %s with modifiers %d', async (key, modifiers, downType, keyCode) => {
    const { automation, commands } = await seeded()

    await automation.interact(TAB_ID, { action: 'press', key })

    const events = commandsOf(commands, 'Input.dispatchKeyEvent')
    expect(events).toHaveLength(2)
    expect(events[0].params).toMatchObject({
      type: downType,
      modifiers,
      windowsVirtualKeyCode: keyCode,
    })
    expect(events[1].params).toMatchObject({ type: 'keyUp', modifiers })
    if (downType === 'keyDown') expect(events[0].params).toMatchObject({ text: 'a' })
  })

  it('scrolls with a wheel event, defaulting to 500 pixels and capping extreme values', async () => {
    const { automation, commands } = await seeded()

    await automation.interact(TAB_ID, { action: 'scroll', direction: 'down' })
    let wheel = commandsOf(commands, 'Input.dispatchMouseEvent')[0]
    expect(wheel.params).toMatchObject({ type: 'mouseWheel', deltaX: 0, deltaY: SCROLL_PIXELS, x: 400, y: 300 })

    commands.length = 0
    await automation.interact(TAB_ID, { action: 'scroll', direction: 'left', pixels: 50_000 })
    wheel = commandsOf(commands, 'Input.dispatchMouseEvent')[0]
    expect(wheel.params).toMatchObject({ deltaX: -10_000, deltaY: 0 })
  })

  it('rejects malformed interactions before touching CDP', async () => {
    const { automation, commands, snapshot } = await seeded()

    await expect(automation.interact(TAB_ID, { action: 'hover' } as any))
      .rejects.toThrow('Invalid browser interaction action')
    await expect(automation.interact(TAB_ID, { action: 'click', ref: '@e2' } as any))
      .rejects.toThrow('snapshot_id and ref are required')
    await expect(automation.interact(TAB_ID, {
      action: 'type', ref: '@e2', snapshot_id: snapshot.snapshotId,
    } as any)).rejects.toThrow('text is required for browser typing')
    await expect(automation.interact(TAB_ID, { action: 'press', key: '  ' }))
      .rejects.toThrow('key is required for browser key presses')
    await expect(automation.interact(TAB_ID, { action: 'scroll', direction: 'diagonal' } as any))
      .rejects.toThrow('Invalid browser scroll direction')

    expect(commandsOf(commands, 'Input.dispatchMouseEvent')).toHaveLength(0)
  })

  it('refuses to act on a closed tab or a stale snapshot', async () => {
    const { automation, snapshot } = await seeded()

    await expect(automation.interact('missing', { action: 'press', key: 'Enter' }))
      .rejects.toThrow('Browser tab is closed')

    await automation.snapshot(TAB_ID)
    await expect(automation.interact(TAB_ID, {
      action: 'click',
      ref: '@e2',
      snapshot_id: snapshot.snapshotId,
    })).rejects.toThrow(STALE_SNAPSHOT_MESSAGE)
  })
})

describe('browser text read', () => {
  it('paginates with defaults and reports the next offset', async () => {
    const text = 'x'.repeat(9_000)
    const { automation, commands } = createHarness({ text })
    const snapshot = await automation.snapshot(TAB_ID)

    const first = await automation.readText(TAB_ID, {
      snapshotId: snapshot.snapshotId,
      ref: '@e3',
    })

    expect(first).toMatchObject({
      tabId: TAB_ID,
      snapshotId: snapshot.snapshotId,
      ref: '@e3',
      mode: 'innerText',
      offset: 0,
      limit: 4_000,
      totalLength: 9_000,
      returnedLength: 4_000,
      hasMore: true,
      nextOffset: 4_000,
    })

    const second = await automation.readText(TAB_ID, {
      snapshotId: snapshot.snapshotId,
      ref: '@e3',
      mode: 'textContent',
      offset: 8_000,
      limit: 4_000,
    })

    expect(second).toMatchObject({
      mode: 'textContent',
      returnedLength: 1_000,
      hasMore: false,
    })
    expect(second.nextOffset).toBeUndefined()

    const argumentsSent = commandsOf(commands, 'Runtime.callFunctionOn')
      .map(command => (command.params?.arguments as Array<{ value: string }>)[0].value)
    expect(argumentsSent).toEqual(['innerText', 'textContent'])
  })

  it('returns empty text for an out-of-range offset instead of throwing', async () => {
    const { automation } = createHarness({ text: 'short' })
    const snapshot = await automation.snapshot(TAB_ID)

    const result = await automation.readText(TAB_ID, {
      snapshotId: snapshot.snapshotId,
      ref: '@e3',
      offset: 10_000,
    })

    expect(result).toMatchObject({ text: '', returnedLength: 0, hasMore: false, offset: 10_000 })
    expect(result.nextOffset).toBeUndefined()
  })

  it(`caps the limit at ${MAX_BROWSER_TEXT_READ_LIMIT}`, async () => {
    const { automation } = createHarness({ text: 'x'.repeat(50_000) })
    const snapshot = await automation.snapshot(TAB_ID)

    const result = await automation.readText(TAB_ID, {
      snapshotId: snapshot.snapshotId,
      ref: '@e3',
      limit: 999_999,
    })

    expect(result.limit).toBe(MAX_BROWSER_TEXT_READ_LIMIT)
    expect(result.returnedLength).toBe(MAX_BROWSER_TEXT_READ_LIMIT)
  })
})

describe('browser screenshot', () => {
  it('returns the desktop contract shape without touching the disk', async () => {
    const { automation } = createHarness()

    const screenshot = await automation.screenshot(TAB_ID)

    expect(screenshot).toEqual({
      tabId: TAB_ID,
      url: 'https://example.com/page',
      title: 'Example',
      mediaType: 'image/png',
      data: Buffer.from('fake-png').toString('base64'),
      width: 800,
      height: 600,
    })
  })

  it('captures beyond the viewport for full-page shots', async () => {
    const { automation, commands } = createHarness()

    const screenshot = await automation.screenshot(TAB_ID, true)

    expect(screenshot).toMatchObject({ width: 800, height: 2_400 })
    const capture = commandsOf(commands, 'Page.captureScreenshot')[0]
    expect(capture.params).toMatchObject({
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 800, height: 2_400, scale: 1 },
    })
  })

  it('rejects an empty capture', async () => {
    const empty = new BrowserAutomation({
      send: async (method) => (method === 'Page.getLayoutMetrics'
        ? { cssVisualViewport: { clientWidth: 10, clientHeight: 10 } }
        : {}),
      getTab: () => ({ id: TAB_ID, url: 'https://example.com', title: '', cdpSessionId: 'sess-1' }),
    })

    await expect(empty.screenshot(TAB_ID)).rejects.toThrow('Browser screenshot was empty')
  })
})

describe('browser console buffer', () => {
  function attach() {
    const { automation } = createHarness()
    const handlers = new Map<string, Set<(params: any, meta: any) => void>>()
    const cdp = {
      on(method: string, handler: (params: any, meta: any) => void) {
        let set = handlers.get(method)
        if (!set) {
          set = new Set()
          handlers.set(method, set)
        }
        set.add(handler)
        return () => set?.delete(handler)
      },
    }
    const detach = automation.attachConsole(cdp, sessionId => (sessionId === 'sess-1' ? TAB_ID : null))
    const emit = (method: string, params: any, sessionId?: string) => {
      for (const handler of handlers.get(method) ?? []) handler(params, { method, sessionId })
    }
    return { automation, emit, detach }
  }

  it('records console calls with a redacted source and a 1-based line', () => {
    const { automation, emit } = attach()

    emit('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ type: 'string', value: 'boom' }, { type: 'number', value: 42 }],
      timestamp: Date.parse('2026-10-16T09:00:00.000Z'),
      stackTrace: { callFrames: [{ url: 'https://example.com/app.js?token=abc', lineNumber: 6 }] },
    }, 'sess-1')

    const entries = automation.consoleEntriesFor(TAB_ID)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: 3,
      message: 'boom 42',
      line: 7,
      timestamp: '2026-10-16T09:00:00.000Z',
    })
    expect(entries[0].sourceId).toContain('token=%5Bredacted%5D')
    expect(entries[0].sourceId).not.toContain('abc')
  })

  it('records exceptions at level 3 and ignores foreign sessions', () => {
    const { automation, emit } = attach()

    emit('Runtime.exceptionThrown', {
      exceptionDetails: { text: 'Uncaught', url: 'https://example.com/app.js', lineNumber: 0, exception: { description: 'TypeError: nope' } },
    }, 'sess-1')
    emit('Runtime.consoleAPICalled', { type: 'log', args: [] }, 'sess-foreign')

    const entries = automation.consoleEntriesFor(TAB_ID)
    expect(entries).toHaveLength(1)
    expect(entries[0].level).toBe(3)
    expect(entries[0].message).toContain('TypeError: nope')
    expect(automation.consoleEntriesFor('other-tab')).toEqual([])
  })

  it(`keeps the newest ${CONSOLE_BUFFER_LIMIT} entries`, () => {
    const { automation, emit } = attach()

    for (let index = 0; index < CONSOLE_BUFFER_LIMIT + 20; index += 1) {
      emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: `line-${index}` }] }, 'sess-1')
    }

    const entries = automation.consoleEntriesFor(TAB_ID)
    expect(entries).toHaveLength(CONSOLE_BUFFER_LIMIT)
    expect(entries[0].message).toBe('line-20')
  })

  it('truncates long messages and clears on demand', () => {
    const { automation, emit } = attach()

    emit('Runtime.consoleAPICalled', {
      type: 'warning',
      args: [{ type: 'string', value: 'y'.repeat(5_000) }],
    }, 'sess-1')
    expect(automation.consoleEntriesFor(TAB_ID)[0].message).toHaveLength(2_000)
    expect(automation.consoleEntriesFor(TAB_ID)[0].level).toBe(2)

    expect(automation.clearConsole(TAB_ID)).toEqual({ ok: true })
    expect(automation.consoleEntriesFor(TAB_ID)).toEqual([])
  })

  it('detaches every console listener', () => {
    const { automation, emit, detach } = attach()

    detach()
    emit('Runtime.consoleAPICalled', { type: 'log', args: [] }, 'sess-1')

    expect(automation.consoleEntriesFor(TAB_ID)).toEqual([])
  })
})
