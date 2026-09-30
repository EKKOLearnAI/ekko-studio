import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ChatPanel Pi effective mode', () => {
  it('offers Global for Pi and only forces the built-in Ekko runtime to scoped mode', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('{ label: t("codingAgents.launchModeGlobal"), value: "global" }')
    expect(source).toContain('if (agent === "ekko-agent") return "scoped";')
    expect(source).toContain('if (agent === "cursor") return "global";')
    expect(source).toContain('const mode = effectiveNewChatMode(newChatAgent.value, newChatAgentMode.value);')
    expect(source).not.toContain('newChatAgent.value === "pi" && newChatAgentMode.value !== "scoped"')
  })
})
