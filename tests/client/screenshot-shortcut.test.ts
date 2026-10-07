// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { screenshotAccelerator } from '@/utils/screenshot-shortcut'

describe('screenshot shortcut recording', () => {
  it.each([['darwin', 'Shift+Command+S'], ['win32', 'Shift+Super+S'], ['linux', 'Shift+Super+S']])('records the system modifier on %s', (platform, expected) => {
    expect(screenshotAccelerator(new KeyboardEvent('keydown', { key: 'ы', code: 'KeyS', metaKey: true, shiftKey: true }), platform)).toBe(expected)
  })
  it('records navigation keys while rejecting typing, modifier-only presses, repeats and IME input', () => {
    expect(screenshotAccelerator(new KeyboardEvent('keydown', { code: 'ArrowUp', ctrlKey: true, altKey: true }), 'linux')).toBe('Control+Alt+Up')
    for (const options of [{ code: 'KeyS' }, { code: 'KeyS', shiftKey: true }, { code: 'ControlLeft', ctrlKey: true }, { code: 'KeyS', ctrlKey: true, repeat: true }, { code: 'KeyS', ctrlKey: true, isComposing: true }]) {
      expect(screenshotAccelerator(new KeyboardEvent('keydown', options), 'darwin')).toBeNull()
    }
  })
})
