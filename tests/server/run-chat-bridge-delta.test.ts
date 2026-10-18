import { describe, expect, it } from 'vitest'

import { filterBridgeToolCallMarkupDelta, flushPendingToolCallMarkup } from '../../packages/server/src/modules/studio/services/chat-run/bridge-delta'

describe('run-chat bridge delta filtering', () => {
  it('keeps list-nested code while removing a subsequent streamed protocol block', () => {
    const state = {}
    const example = '- ~~~xml\n  <tool_call>literal-example</tool_call>\n  ~~~\n\n'
    const input = `${example}<tool_call>private-arguments</tool_call>\nAnswer`
    const output = [...input].map(char => filterBridgeToolCallMarkupDelta(state, char)).join('')
      + flushPendingToolCallMarkup(state)
    expect(output).toBe(`${example}\nAnswer`)
  })
  it('removes split XML calls before buffering assistant text', () => {
    const state = {}
    expect(filterBridgeToolCallMarkupDelta(state, '<tool_')).toBe('')
    expect(filterBridgeToolCallMarkupDelta(state, 'call><invoke name="read_file">secret</invoke></tool_call>\nDone')).toBe('\nDone')
    expect(flushPendingToolCallMarkup(state)).toBe('')
  })
  it('keeps ordinary assistant text', () => {
    const state = {}

    expect(filterBridgeToolCallMarkupDelta(state, 'hello')).toBe('hello')
    expect(filterBridgeToolCallMarkupDelta(state, ' world')).toBe(' world')
  })

  it('removes complete textual tool-call markup from bridge deltas', () => {
    const state = {}
    const delta = 'Before\n[Calling tool: terminal with arguments: {"cmd":"pwd"}]\nAfter'

    expect(filterBridgeToolCallMarkupDelta(state, delta)).toBe('Before\nAfter')
  })

  it('removes tool-call markup split across multiple chunks', () => {
    const state = {}

    expect(filterBridgeToolCallMarkupDelta(state, '[Calling tool: terminal with arguments: {"cmd"')).toBe('')
    expect(filterBridgeToolCallMarkupDelta(state, ':"pwd"}]\nDone')).toBe('Done')
  })

  it('keeps json arrays and brackets inside tool arguments from leaking', () => {
    const state = {}
    const delta = '[Calling tool: terminal with arguments: {"cmd":"printf \\"[x]\\"","items":["a","b"]}]\nDone'

    expect(filterBridgeToolCallMarkupDelta(state, delta)).toBe('Done')
  })

  it('holds a partial marker suffix until the next chunk', () => {
    const state = {}

    expect(filterBridgeToolCallMarkupDelta(state, 'Text [Call')).toBe('Text ')
    expect(filterBridgeToolCallMarkupDelta(state, 'ing tool: terminal with arguments: {}]\nDone')).toBe('Done')
  })

  it('flushes an orphan partial marker suffix when no text chunk follows', () => {
    const state = {}

    expect(filterBridgeToolCallMarkupDelta(state, 'Text [Call')).toBe('Text ')
    expect(flushPendingToolCallMarkup(state)).toBe('[Call')
    expect(flushPendingToolCallMarkup(state)).toBe('')
  })
})
