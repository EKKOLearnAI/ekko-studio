import { readPresetStyleSource as readFileSync } from './preset-style-source'
import { describe, expect, it } from 'vitest'
import { resolveSessionNavigation } from '@/components/hermes/chat/session-list-item-navigation'

describe('SessionListItem source and navigation', () => {
  it('uses a one-pixel white outline without internal avatar padding', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/SessionListItem.vue', 'utf8')

    expect(source).toMatch(/\.session-item-agent-logo\s*\{[^}]*border: 1px solid #fff;/s)
    expect(source).not.toMatch(/\.session-item-agent-logo\s*\{[^}]*padding:/s)
    expect(source).not.toMatch(/\.session-item-agent-logo\s*\{[^}]*background:/s)
  })

  it('preserves native modified navigation unless desktop interception is requested', () => {
    const ctrlClick = { ctrlKey: true, button: 0 } as MouseEvent
    const middleClick = {
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      button: 1,
    } as MouseEvent
    const normalClick = {
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      button: 0,
    } as MouseEvent

    expect(resolveSessionNavigation(ctrlClick, false)).toBe('native')
    expect(resolveSessionNavigation(ctrlClick, true)).toBe('open-new')
    expect(resolveSessionNavigation(middleClick, true)).toBe('open-new')
    expect(resolveSessionNavigation(normalClick, true)).toBe('select')
  })
})
