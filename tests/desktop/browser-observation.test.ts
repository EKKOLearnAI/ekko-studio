import { describe, expect, it } from 'vitest'
import { observeBrowserState, type BrowserObservedState } from '../../packages/desktop/src/main/browser/browser-observation'
import type { BrowserSnapshotNode } from '../../packages/desktop/src/main/browser/browser-types'

const state = (...nodes: Array<[number, BrowserSnapshotNode]>): BrowserObservedState => ({ url: 'https://example.com', nodes: new Map(nodes) })
const field = { ref: '@e1', role: 'textbox', name: 'Name', value: '' }

describe('local browser observations', () => {
  it('does not mistake ref renumbering or focus for a changed control', () => {
    const observation = observeBrowserState(state([1, field]), state([1, { ...field, ref: '@e20', focused: true }]), [])
    expect(observation.changed).toBe(false)
  })

  it('compares only the last typed value per target, not superseded batch input', () => {
    const observation = observeBrowserState(state([1, field]), state([1, { ...field, value: 'final' }]), [
      { nodeId: 1, actionIndex: 0, text: 'first' }, { nodeId: 1, actionIndex: 1, text: 'final' },
    ])
    expect(observation.targets).toHaveLength(1)
    expect(observation.targets?.[0].valueMatches).toBe(true)
  })

  it.each([undefined, '[redacted]'])('does not establish equality for protected or redacted values: %s', value => {
    const observation = observeBrowserState(state([1, field]), state([1, { ...field, value }]), [{ nodeId: 1, actionIndex: 0, text: 'private' }])
    expect(observation.targets?.[0]).not.toHaveProperty('valueMatches')
    expect(JSON.stringify(observation)).not.toContain('private')
  })

  it('prioritizes changed selection over structural noise and bounds evidence', () => {
    const before = state([1, { ...field, checked: false }])
    const after = state(...Array.from({ length: 100 }, (_, i) => [i + 2, { ref: `@e${i + 2}`, role: 'text', name: 'new' }] as [number, BrowserSnapshotNode]),
      [1, { ...field, checked: true }])
    const observation = observeBrowserState(before, after, [])
    expect(observation.changeCount).toBe(101)
    expect(observation.changes).toHaveLength(12)
    expect(observation.changes?.[0].after?.checked).toBe(true)
  })
})
