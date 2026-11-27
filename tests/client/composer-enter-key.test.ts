// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { enterShouldSendMessage } from '../../packages/client/src/utils/device'

function enter(shiftKey = false) {
  return { key: 'Enter', shiftKey }
}

describe('enterShouldSendMessage', () => {
  it('sends on a plain Enter with a hardware keyboard', () => {
    expect(enterShouldSendMessage(enter(), false)).toBe(true)
  })

  it('keeps Shift+Enter as a newline on a hardware keyboard', () => {
    expect(enterShouldSendMessage(enter(true), false)).toBe(false)
  })

  it('never sends on touch devices, where Shift+Enter is unreachable', () => {
    // Soft keyboards do not report Shift (W3C uievents#542), so Enter has to
    // insert a newline and the send button submits.
    expect(enterShouldSendMessage(enter(), true)).toBe(false)
    expect(enterShouldSendMessage(enter(true), true)).toBe(false)
  })

  it('ignores keys other than Enter', () => {
    expect(enterShouldSendMessage({ key: 'a', shiftKey: false }, false)).toBe(false)
    expect(enterShouldSendMessage({ key: 'Tab', shiftKey: false }, false)).toBe(false)
  })

  it('defaults to the detected device type', () => {
    // jsdom reports no touch points and a desktop user agent.
    expect(enterShouldSendMessage(enter())).toBe(true)
  })
})
