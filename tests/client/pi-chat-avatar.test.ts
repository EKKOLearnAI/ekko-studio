import { readPresetStyleSource as readFileSync } from './preset-style-source'
import { describe, expect, it } from 'vitest'

describe('Pi chat identity', () => {
  it('uses the active Agent avatar for assistant messages', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/MessageItem.vue', 'utf8')

    expect(source).toContain('v-if="message.role === \'assistant\'"')
    expect(source).toContain(':src="assistantAgent.src"')
    expect(source).toContain(':alt="assistantAgent.label"')
    expect(source).not.toContain('assistantProfileName')
    expect(source).not.toContain('assistantProfileAvatar')
    expect(source).toMatch(/\.msg-avatar\s*\{[^}]*object-fit: cover;/s)
    expect(source).toMatch(/\.msg-avatar\s*\{[^}]*border: 1px solid #fff;/s)
    expect(source).not.toMatch(/\.msg-avatar\s*\{[^}]*padding:/s)
    expect(source).not.toMatch(/\.msg-avatar\s*\{[^}]*background:/s)
  })

  it('uses the Pi logo in empty state and completion notifications', () => {
    const avatarHelper = readFileSync('packages/client/src/utils/chat-agent-avatar.ts', 'utf8')
    const chatStore = readFileSync('packages/client/src/stores/hermes/chat.ts', 'utf8')

    expect(avatarHelper).toContain("pi: { label: 'Pi', src: '/coding-agents/pi.svg' }")
    expect(chatStore).toContain("if (codingAgentId === 'pi')")
    expect(chatStore).toContain("return { icon: '/coding-agents/pi.svg' }")
  })
})
