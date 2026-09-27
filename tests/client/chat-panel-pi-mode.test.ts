import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { effectiveNewChatMode } from '../../packages/client/src/components/hermes/chat/category-new-chat-preset'

describe('ChatPanel Pi effective mode', () => {
  it('offers Global for Pi and only forces the built-in Ekko runtime to scoped mode', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('{ label: t("codingAgents.launchModeGlobal"), value: "global" }')
    // The drawer and category presets share one launch-mode rule.
    expect(source).toMatch(/import \{[^}]*\beffectiveNewChatMode\b[^}]*\} from "\.\/category-new-chat-preset";/)
    expect(source).not.toMatch(/function effectiveNewChatMode\(/)
    expect(source).toContain('const mode = effectiveNewChatMode(newChatAgent.value, newChatAgentMode.value);')
    expect(source).not.toContain('newChatAgent.value === "pi" && newChatAgentMode.value !== "scoped"')

    expect(effectiveNewChatMode('pi', 'global')).toBe('global')
    expect(effectiveNewChatMode('pi', 'scoped')).toBe('scoped')
    expect(effectiveNewChatMode('ekko-agent', 'global')).toBe('scoped')
    expect(effectiveNewChatMode('cursor', 'scoped')).toBe('global')
  })
})
