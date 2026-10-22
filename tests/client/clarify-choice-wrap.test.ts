// @vitest-environment node
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const CHAT = 'packages/client/src/components/hermes/chat/MessageList.vue'
const GROUP_CHAT = 'packages/client/src/components/hermes/group-chat/GroupChatPanel.vue'
const GLOBAL = 'packages/client/src/components/layout/GlobalPendingActions.vue'

function styleBlock(source: string, selector: string): string {
  const start = source.indexOf(selector)
  expect(start, `${selector} is missing`).toBeGreaterThan(-1)

  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(start, index + 1)
  }

  throw new Error(`${selector} block is not closed`)
}

describe('clarify choice wrapping', () => {
  // A clarify choice is a free-form sentence produced by the agent, so it can be far wider
  // than the card. Naive UI buttons are `white-space: nowrap` with `flex-shrink: 0`, which
  // used to push the button past the panel edge and clip the text off screen.
  it.each([CHAT, GROUP_CHAT])('lets long choices wrap inside the float panel (%s)', path => {
    const actions = styleBlock(readFileSync(path, 'utf8'), '.approval-float-actions {')

    expect(actions).toContain('align-items: flex-start;')
    expect(actions).toContain(':deep(.n-button)')
    expect(actions).toContain('flex: 0 1 auto;')
    expect(actions).toContain('max-width: 100%;')
    expect(actions).toContain('white-space: normal;')
    expect(actions).toContain(':deep(.n-button__content)')
    expect(actions).toContain('overflow-wrap: anywhere;')
    expect(actions).not.toContain('!important')
  })

  it.each([CHAT, GROUP_CHAT])('keeps an over-long float panel scrollable (%s)', path => {
    const panel = styleBlock(readFileSync(path, 'utf8'), '.approval-float-panel {')

    expect(panel).toContain('max-height: min(70dvh, calc(100dvh - 170px));')
    expect(panel).toContain('overflow-y: auto;')
    expect(panel).toContain('overflow-x: hidden;')
  })

  it('lets long choices wrap inside the global notification card', () => {
    const source = readFileSync(GLOBAL, 'utf8')
    const choices = styleBlock(source, '.global-pending-actions .n-button, .global-clarify-choices .n-button {')
    const content = styleBlock(source, '.global-pending-actions .n-button__content, .global-clarify-choices .n-button__content {')

    expect(choices).toContain('flex: 0 1 auto;')
    expect(choices).toContain('max-width: 100%;')
    expect(choices).toContain('white-space: normal;')
    expect(choices).not.toContain('!important')
    expect(content).toContain('white-space: normal;')
    expect(content).toContain('overflow-wrap: anywhere;')
    expect(source).toContain('.global-clarify-question { font-weight: 600; overflow-wrap: anywhere; }')
  })
})
