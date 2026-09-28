import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { BrowserAutomation } from '../../packages/desktop/src/main/browser/browser-automation'

function fakeContents(options: {
  attributes?: string[]
  protectedValue?: boolean
  role?: string
  name?: string
  nodes?: any[]
  scopeIds?: number[]
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
          nodes: options.nodes || [{
            backendDOMNodeId: 7,
            role: { value: options.role || 'textbox' },
            name: { value: options.name || 'Account secret' },
            value: { value: 'should-not-leak' },
            properties: options.protectedValue ? [{ name: 'protected', value: { value: true } }] : [],
          }],
        }
      }
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelector') return { nodeId: options.scopeIds?.length ? 2 : 0 }
      if (method === 'DOM.describeNode') return { node: { nodeName: 'INPUT', attributes: options.attributes || [],
        children: options.scopeIds?.map(backendNodeId => ({ backendNodeId })) } }
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
  const largeTree = () => Array.from({ length: 750 }, (_, index) => ({ backendDOMNodeId: index + 1,
    role: { value: index >= 700 ? 'textbox' : 'StaticText' }, name: { value: `Field ${index + 1}` },
  }))

  it('pages the whole document with stable refs and makes controls after node 300 usable', async () => {
    const automation = new BrowserAutomation()
    const contents = fakeContents({ nodes: largeTree() })
    const first = await automation.snapshot('large', contents)
    expect(first).toMatchObject({ totalNodes: 750, matchedNodes: 750, hasMore: true, nextOffset: 100, truncated: true })
    expect(first.nodes).toHaveLength(100)
    let page = first
    const seen = [...first.nodes]
    while (page.hasMore) {
      page = await automation.snapshot('large', contents, { snapshotId: first.snapshotId, offset: page.nextOffset })
      expect(page.snapshotId).toBe(first.snapshotId)
      seen.push(...page.nodes)
    }
    expect(seen.map(node => node.ref)).toEqual(Array.from({ length: 750 }, (_, i) => `@e${i + 1}`))
    await expect(automation.interact('large', contents, {
      action: 'type', snapshot_id: page.snapshotId, ref: '@e750', text: 'Filled without JEV',
    })).resolves.toBeUndefined()
    await expect(automation.snapshot('large', contents, { snapshotId: first.snapshotId, offset: 100 })).rejects.toThrow('stale')
  })

  it('searches and filters controls before paging, without a semantic provider', async () => {
    const automation = new BrowserAutomation()
    const contents = fakeContents({ nodes: largeTree() })
    const controls = await automation.snapshot('large', contents, { interactiveOnly: true })
    expect(controls.nodes).toHaveLength(50)
    expect(controls.nodes[0].ref).toBe('@e701')
    const found = await automation.snapshot('large', contents, { query: 'ＦＩＥＬＤ 750', limit: 1 })
    expect(found).toMatchObject({ matchedNodes: 1, hasMore: false, nodes: [{ ref: '@e750', name: 'Field 750' }] })
  })

  it('scopes a snapshot to a DOM subtree before applying local search and the node budget', async () => {
    const automation = new BrowserAutomation()
    const contents = fakeContents({ nodes: largeTree(), scopeIds: [720, 721] })
    const found = await automation.snapshot('large', contents, { selector: '#form-demo-layout', interactiveOnly: true })
    expect(found.nodes.map(node => node.ref)).toEqual(['@e720', '@e721'])
    expect(found).toMatchObject({ totalNodes: 750, matchedNodes: 2, scope: { selector: '#form-demo-layout' } })
    await expect(automation.snapshot('large', fakeContents(), { selector: '#missing' })).rejects.toThrow('did not match')
  })

  it('includes selection state for baseline verification', async () => {
    const automation = new BrowserAutomation()
    const contents = fakeContents({ nodes: [{ backendDOMNodeId: 1, role: { value: 'radio' }, name: { value: 'Vertical' },
      properties: [{ name: 'checked', value: { value: 'true' } }, { name: 'selected', value: { value: false } }] }] })
    expect((await automation.snapshot('tab', contents)).nodes[0]).toMatchObject({ checked: true, selected: false })
  })

  it.each([{ limit: 301 }, { offset: -1 }, { offset: 0.5 }, { snapshotId: 'id', query: 'changed' },
    { query: ' ' }, { interactiveOnly: 'yes' }])('rejects invalid snapshot options: %j', async options => {
    await expect(new BrowserAutomation().snapshot('tab', fakeContents(), options as any)).rejects.toThrow()
  })

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

  it.each([
    ['link', 'APP购买'], ['button', 'Delete account'], ['StaticText', 'Send payment'],
  ])('dispatches %s clicks without classifying the label %s', async (role, name) => {
    const automation = new BrowserAutomation()
    let clicks = 0
    const contents = fakeContents({ role, name, runtimeCall: params => {
      if (params.functionDeclaration.includes('target.click')) clicks++
      return { result: { value: true } }
    } })
    const snapshot = await automation.snapshot('tab-1', contents)
    await automation.interact('tab-1', contents, { action: 'click', snapshot_id: snapshot.snapshotId, ref: '@e1' })
    expect(clicks).toBe(1)
  })
})
