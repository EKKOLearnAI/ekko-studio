import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { BrowserAutomation } from '../../packages/desktop/src/main/browser/browser-automation'

function fakeContents(options: {
  attributes?: string[]
  protectedValue?: boolean
  role?: string
  name?: string
  runtimeCall?: (params: Record<string, any>) => unknown
} = {}): WebContents {
  let attached = false
  const debuggerApi = {
    isAttached: () => attached,
    attach: () => { attached = true },
    detach: () => { attached = false },
    sendCommand: async (method: string, params: Record<string, any> = {}) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [{
            backendDOMNodeId: 7,
            role: { value: options.role || 'textbox' },
            name: { value: options.name || 'Account secret' },
            value: { value: 'should-not-leak' },
            properties: options.protectedValue ? [{ name: 'protected', value: { value: true } }] : [],
          }],
        }
      }
      if (method === 'DOM.describeNode') return { node: { nodeName: 'INPUT', attributes: options.attributes || [] } }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'object-1' } }
      if (method === 'Runtime.callFunctionOn') {
        return options.runtimeCall ? options.runtimeCall(params) : { result: { value: true } }
      }
      return {}
    },
  }
  return {
    debugger: debuggerApi,
    isDestroyed: () => false,
    getURL: () => 'https://example.com/',
    getTitle: () => 'Example',
  } as unknown as WebContents
}

describe('desktop browser automation safety', () => {
  it('waits for a temporarily hidden target and dispatches exactly one click', async () => {
    const automation = new BrowserAutomation()
    let probes = 0, clicks = 0
    const contents = fakeContents({ runtimeCall: params => {
      if (params.functionDeclaration.includes('target.click')) { clicks++; return { result: { value: true } } }
      return { result: { value: ++probes < 3 ? 'not visible' : true } }
    } })
    const snapshot = await automation.snapshot('tab', contents)
    await automation.interact('tab', contents, { action: 'click', ref: '@e1', snapshot_id: snapshot.snapshotId })
    expect(probes).toBe(3)
    expect(clicks).toBe(1)
  })

  it('does not dispatch after takeover while waiting or retry a failed dispatch', async () => {
    for (const takeover of [true, false]) {
      const automation = new BrowserAutomation()
      let cancelled = false, clicks = 0
      const contents = fakeContents({ runtimeCall: params => {
        if (params.functionDeclaration.includes('target.click')) {
          clicks++
          return { exceptionDetails: { exception: { description: 'Error: Element is not visible\nstack' } } }
        }
        cancelled = takeover
        return { result: { value: true } }
      } })
      const snapshot = await automation.snapshot('tab', contents)
      await expect(automation.interact('tab', contents, { action: 'click', ref: '@e1', snapshot_id: snapshot.snapshotId },
        () => { if (cancelled) throw new Error('takeover') })).rejects.toThrow(takeover ? 'takeover' : 'Element is not visible')
      expect(clicks).toBe(takeover ? 0 : 1)
    }
  })
  it('redacts protected accessibility values and rejects stale refs', async () => {
    const automation = new BrowserAutomation()
    const contents = fakeContents({ protectedValue: true })
    const snapshot = await automation.snapshot('tab-1', contents)

    expect(snapshot.nodes[0].value).toBeUndefined()
    expect(snapshot.text).not.toContain('should-not-leak')
    automation.invalidate('tab-1')
    await expect(automation.interact('tab-1', contents, {
      action: 'click', snapshot_id: snapshot.snapshotId, ref: '@e1',
    })).rejects.toThrow(/stale/)
  })

  it('skips debugger cleanup when web contents are missing', () => {
    const automation = new BrowserAutomation()

    expect(() => automation.detach('missing-tab', undefined)).not.toThrow()
  })

  it('skips debugger cleanup when web contents are destroyed', () => {
    const automation = new BrowserAutomation()
    const destroyedContents = {
      isDestroyed: () => true,
      get debugger() {
        throw new Error('debugger must not be read after destruction')
      },
    } as unknown as WebContents

    expect(() => automation.detach('destroyed-tab', destroyedContents)).not.toThrow()
  })

  it.each([
    ['password', ['type', 'password']],
    ['payment', ['type', 'text', 'name', 'card_number']],
    ['file', ['type', 'file']],
  ])('does not block Agent typing into %s fields', async (_field, attributes) => {
    const automation = new BrowserAutomation()
    const contents = fakeContents({ attributes })
    const snapshot = await automation.snapshot('tab-1', contents)

    await expect(automation.interact('tab-1', contents, {
      action: 'type', snapshot_id: snapshot.snapshotId, ref: '@e1', text: 'test value',
    })).resolves.toBeUndefined()
  })

  it('clicks a current safe element through its resolved DOM object', async () => {
    const automation = new BrowserAutomation()
    let clickFunction = ''
    const contents = fakeContents({
      runtimeCall: (params) => {
        clickFunction = String(params.functionDeclaration || '')
        return { result: { value: true } }
      },
    })
    const snapshot = await automation.snapshot('tab-1', contents)
    await expect(automation.interact('tab-1', contents, {
      action: 'click', snapshot_id: snapshot.snapshotId, ref: '@e1',
    })).resolves.toBeUndefined()
    expect(clickFunction).toContain('node.nodeType === 3 ? node.parentElement')
    expect(clickFunction).toContain('.closest(')
  })

  it('reads long text from a current snapshot ref in bounded pages', async () => {
    const source = `First line\n${'x'.repeat(1_100)}\nLast line`
    const automation = new BrowserAutomation()
    const contents = fakeContents({
      name: source,
      role: 'StaticText',
      runtimeCall: (params) => {
        const offset = Number(params.arguments?.[1]?.value || 0)
        const limit = Number(params.arguments?.[2]?.value || 0)
        const end = Math.min(source.length, offset + limit)
        return {
          result: {
            value: {
              text: source.slice(offset, end),
              totalLength: source.length,
              offset,
              returnedLength: end - offset,
            },
          },
        }
      },
    })
    const snapshot = await automation.snapshot('tab-1', contents)

    expect(snapshot.nodes[0].name).toHaveLength(500)
    const first = await automation.readText('tab-1', contents, {
      snapshotId: snapshot.snapshotId,
      ref: '@e1',
      mode: 'innerText',
      offset: 0,
      limit: 700,
    })
    expect(first).toMatchObject({
      text: source.slice(0, 700),
      totalLength: source.length,
      returnedLength: 700,
      hasMore: true,
      nextOffset: 700,
    })

    const second = await automation.readText('tab-1', contents, {
      snapshotId: snapshot.snapshotId,
      ref: '@e1',
      mode: 'innerText',
      offset: first.nextOffset!,
      limit: 700,
    })
    expect(`${first.text}${second.text}`).toBe(source)
    expect(second.hasMore).toBe(false)
    expect(second.nextOffset).toBeUndefined()
  })

  it('requires user confirmation for high-risk activation labels', async () => {
    const automation = new BrowserAutomation()
    const contents = fakeContents({ role: 'button', name: 'Delete account' })
    const snapshot = await automation.snapshot('tab-1', contents)

    expect(automation.interactionRisk('tab-1', {
      action: 'click', snapshot_id: snapshot.snapshotId, ref: '@e1',
    })).toEqual({ kind: 'high-risk-activation', label: 'Delete account' })
  })

  it('keeps high-risk confirmation for StaticText refs promoted to clickable parents', async () => {
    const automation = new BrowserAutomation()
    const contents = fakeContents({ role: 'StaticText', name: 'Send payment' })
    const snapshot = await automation.snapshot('tab-1', contents)

    expect(automation.interactionRisk('tab-1', {
      action: 'click', snapshot_id: snapshot.snapshotId, ref: '@e1',
    })).toEqual({ kind: 'high-risk-activation', label: 'Send payment' })
  })
})
