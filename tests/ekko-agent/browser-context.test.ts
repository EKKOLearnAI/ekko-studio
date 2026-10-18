import { describe, expect, it } from 'vitest'
import { projectBrowserHistory } from '../../packages/ekko-agent/src/model/browser-context'

const snapshot = (id: string, tabId = 'tab') => ({ tabId, snapshotId: id, title: 'Store',
  nodes: Array.from({ length: 100 }, (_, index) => ({ ref: `@e${index + 1}`, role: 'button', name: `Product ${index} ${'x'.repeat(80)}` })),
  text: 'duplicate text '.repeat(300), hasMore: true, nextOffset: 100 })
const tool = (result: unknown, name = 'ekko_studio_browser_toolset') => ({ role: 'tool', name, tool_call_id: 'call', content: JSON.stringify({ result }, null, 2) })

describe('browser context projection', () => {
  it('summarizes superseded snapshots while retaining all pages of the current snapshot for each tab', () => {
    const current = snapshot('new')
    const page2 = { ...current, nodes: [{ ref: '@e101', role: 'button', name: 'Continue' }], offset: 100 }
    const messages = [tool(snapshot('old')), tool(snapshot('other', 'other-tab')), tool(current), tool(page2)]
    const originals = structuredClone(messages)
    const projected = projectBrowserHistory(messages)
    const previous = JSON.parse(projected[0].content).result
    expect(previous).toMatchObject({ snapshotId: 'old', stale: true, historicalNodeCount: 100 })
    expect(previous).not.toHaveProperty('nodes')
    expect(previous).not.toHaveProperty('text')
    expect(previous.facts.every((fact: any) => !fact.ref)).toBe(true)
    expect(projected[0].content.length).toBeLessThan(messages[0].content.length / 5)
    expect(JSON.parse(projected[1].content).result).toEqual(snapshot('other', 'other-tab'))
    expect(JSON.parse(projected[2].content).result).toEqual(current)
    expect(JSON.parse(projected[3].content).result).toEqual(page2)
    expect(messages).toEqual(originals)
    expect(projectBrowserHistory(projected)).toEqual(projected)
  })

  it('retains failures, partial completion and verification evidence in old action results', () => {
    const result = { completed: 1, total: 3, results: [{ status: 'failed', error: 'Target removed' }],
      verification: { status: 'not_met' }, observation: { changed: false }, snapshot: snapshot('old') }
    const projected = projectBrowserHistory([tool(result), tool(snapshot('new'))])
    const { snapshot: old, ...metadata } = JSON.parse(projected[0].content).result
    const { snapshot: _snapshot, ...expected } = result
    expect(metadata).toEqual(expected)
    expect(old.stale).toBe(true)
  })

  it('preserves control state and price facts instead of earlier navigation noise', () => {
    const old = snapshot('old')
    old.nodes.push({ ref: '@e101', role: 'radio', name: 'Gold', checked: true } as any)
    old.nodes.push({ ref: '@e102', role: 'StaticText', name: '¥1299.00' })
    const projected = projectBrowserHistory([tool(old), tool(snapshot('new'))])
    const facts = JSON.parse(projected[0].content).result.facts
    expect(facts[0]).toMatchObject({ name: 'Gold', checked: true })
    expect(facts[1]).toMatchObject({ name: '¥1299.00' })
  })

  it('leaves unrelated tools, plain errors and schema discovery unchanged', () => {
    const messages = [tool(snapshot('old'), 'other'), { ...tool({}), content: 'Error: snapshot stale' },
      tool({ tools: ['ekko_studio_browser_snapshot'] }), { ...tool(snapshot('user')), role: 'user' }]
    expect(projectBrowserHistory(messages)).toEqual(messages)
  })

  it('supports stored row names and updates equivalent text parts without dropping images or call IDs', () => {
    const { name, ...message } = tool(snapshot('old'))
    const image = { type: 'image', url: 'file:///image.png' }
    const original = { ...message, tool_name: name, id: 42, contentParts: [{ type: 'text', text: message.content }, image] }
    const projected = projectBrowserHistory([original, { ...original, content: tool(snapshot('new')).content }])
    expect(projected[0]).toMatchObject({ id: 42, tool_call_id: 'call' })
    expect(projected[0].contentParts).toEqual([{ type: 'text', text: projected[0].content }, image])
  })
})
