import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { AGENT_OPTIONS } from '../../packages/client/src/utils/agent-options'

describe('ChatPanel session clicks', () => {
  it('switches the store when the route is already on the clicked session', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('if (chatStore.activeSessionId !== sessionId)')
    expect(source).toContain('await chatStore.switchSession(sessionId)')
  })

  it('opens desktop sessions in a native chat window while preserving the web tab fallback', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('function openSessionInNewTab(sessionId: string, profile = sessionProfile(sessionId))')
    expect(source).toContain('bridge.openChatWindow(sessionId, profile || undefined)')
    expect(source).toContain('window.open(sessionHref(sessionId, profile), "_blank", "noopener,noreferrer")')
    expect(source).toContain('openSessionInNewTab(sessionId, chatStore.activeSession?.profile || null)')
    expect(source).toContain('v-if="currentMode === \'chat\' && !standalone"')
    expect(source).toContain('<header v-if="!standalone" class="chat-header">')
  })

  it('replays the whole chat surface fade without remounting the input', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('ref="chatMainContentRef" class="chat-main-content"')
    expect(source).toContain('() => chatStore.activeSessionId')
    expect(source).toContain('sessionFadeAnimation = surface.animate(')
    expect(source).toContain('sessionFadeAnimation?.cancel()')
    expect(source).not.toContain(':key="chatStore.activeSessionId" class="chat-main-content"')
  })

  it('allows scoped coding-agent model switching but disables it for global agents', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('contextSession.value?.source === "coding_agent"')
    expect(source).toContain('isSessionModelScopedCodingAgent')
    expect(source).toContain('canScopedCodingAgentUseProvider(sessionModelCodingAgentId.value, group.provider)')
    expect(source).toContain('showSessionModelModeModal')
    expect(source).toContain('pendingSessionModelSwitch')
    expect(source).toContain('chatStore.switchSessionModel(model, provider, sessionModelSessionId.value, apiMode)')
    expect(source).toContain('activeSessionUsesGlobalCodingAgentConfig')
    expect(source).toContain(':model-disabled="activeSessionUsesGlobalCodingAgentConfig"')
    expect(source).toContain('contextSession.value?.codingAgentMode !== "global"')
    expect(source).toContain('requestedSession?.codingAgentMode === "global"')
    expect(readFileSync('packages/client/src/stores/hermes/chat.ts', 'utf8')).toContain(
      "session?.codingAgentMode === 'global' && isCodingAgentLikeSession(session)",
    )
    expect(source).toContain('const sessionModelSwitching = ref(false)')
    expect(source).toContain('sessionModelSwitching.value = true')
    expect(source).toContain('sessionModelSwitching.value = false')
    expect(source).toContain(':show="sessionModelSwitching"')
    expect(source).toContain("t('chat.modelSwitching')")
    expect(source).toContain(':loading="sessionModelSwitching"')
    expect(source).not.toContain('header-model-button--readonly')
    expect(source).not.toContain('if (isActiveSessionCodingAgent.value) return')
  })

  it('keeps the custom session model provider below the scrollable model lists', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')
    const modalStart = source.indexOf('v-model:show="showSessionModelModal"')
    const modalEnd = source.indexOf('</NModal>', modalStart)
    const modal = source.slice(modalStart, modalEnd)
    const standardList = modal.indexOf('<div v-if="sessionModelKind === \'model\'" class="session-model-list"')
    const moaList = modal.indexOf('<div v-else class="session-model-list"', standardList)
    const customFooter = modal.indexOf('<div v-if="sessionModelKind === \'model\'" class="session-model-custom"', moaList)

    expect(standardList).toBeGreaterThanOrEqual(0)
    expect(moaList).toBeGreaterThan(standardList)
    expect(customFooter).toBeGreaterThan(moaList)
    expect(modal.slice(standardList, moaList)).not.toContain('session-model-custom')
  })

  it('uses codingAgentId to filter scoped agent models and requests an API mode for all scoped agents', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('const sessionModelCodingAgentId = computed<ChatCodingAgentId | undefined>')
    expect(source).toContain('sessionModelSession.value?.codingAgentId ||')
    expect(source).toContain('sessionModelSession.value?.agent === "claude"')
    expect(source).toContain('sessionModelSession.value?.agent === "ekko-agent"')
    expect(source).toContain('if (isSessionModelScopedCodingAgent.value)')
    expect(source).not.toContain('sessionModelSession.value?.agent === "claude-code"')
  })

  it('uses the active sidebar model as the new chat default for the active profile', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('const selectedProvider = appStore.selectedProvider || ""')
    expect(source).toContain('const selectedModel = appStore.selectedModel || ""')
    expect(source).toContain('profile === activeProfileName')
    expect(source).toContain('selectedGroup?.models.includes(selectedModel)')
  })

  it('offers Ekko when creating chats in production builds', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(AGENT_OPTIONS).toContainEqual({ label: 'Ekko', value: 'ekko-agent' })
    expect(source).toContain('const newChatAgentOptions = computed(() => AGENT_OPTIONS.map(')
    expect(source).not.toContain('showEkkoAgentEntry')
    expect(source).not.toContain('import.meta.env.DEV')
  })

  it('persists Pi as the Pi agent instead of falling back to Hermes', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('newChatAgent.value === "pi"')
    expect(source).toContain('? "pi"')
    expect(source).toContain('codingAgentId: newChatAgent.value === "hermes" ? undefined : newChatAgent.value')
  })

  it('shows and persists the API mode for Ekko chats and model switches', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('apiMode: isNewChatCodingAgent.value && !isGlobalCodingAgent ? newChatApiMode.value : undefined')
    expect(source).toContain('v-if="isNewChatCodingAgent && effectiveNewChatAgentMode === \'scoped\'"')
    expect(source).toContain('if (isSessionModelScopedCodingAgent.value)')
    expect(source).toContain('await applySessionModelSwitch(pending.model, pending.provider, sessionModelApiMode.value)')
  })

  it('uses a create action in the new chat drawer instead of duplicating the new chat trigger label', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('{{ t("common.create") }}')
    expect(source).not.toContain('{{ t("chat.newChat") }}\n            </NButton>')
  })

  it('offers MoA only for Hermes session creation and switching', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('if (group.provider === "moa") return newChatAgent.value === "hermes"')
    expect(source).toContain('newChatAgent.value === "hermes" && Boolean(newChatMoaGroup.value?.models.length)')
    expect(source).toContain('group.provider === "moa"\n          ? !isSessionModelCodingAgent.value')
    expect(source).toContain('name="new-chat-model-kind"')
    expect(source).toContain('name="session-model-kind"')
    expect(source).toContain("{{ t('chat.modelType') }}")
    expect(source).toContain('<NRadioButton value="model">{{ t(\'chat.standardModels\') }}</NRadioButton>')
    expect(source).toContain('<NRadioButton value="moa">{{ t(\'chat.moaPresets\') }}</NRadioButton>')
    expect(source).toContain('await applySessionModelSwitch(preset, "moa")')
  })
})
