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
    expect(source).toContain('v-if="hasPageSidebar"')
    expect(source).toContain('!props.standalone && currentMode.value === "chat"')
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
      "session?.codingAgentMode === 'global' && isProviderAgentSession(session)",
    )
    expect(source).toContain('const sessionModelSwitching = ref(false)')
    expect(source).toContain('sessionModelSwitching.value = true')
    expect(source).toContain('sessionModelSwitching.value = false')
    expect(readFileSync('packages/client/src/components/hermes/models/ModelCascader.vue', 'utf8')).toContain("t('chat.modelSwitching')")
    expect(source).toContain(':loading="sessionModelSwitching"')
    expect(source).not.toContain('header-model-button--readonly')
    expect(source).not.toContain('if (isActiveSessionCodingAgent.value) return')
  })

  it('uses the shared model dialog while preserving the session Profile and composer focus', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')
    expect(source).toContain(':groups="sessionModelAllGroups"')
    expect(source).toContain(':trigger-element="sessionModelTrigger"')
    expect(source).toContain('session?.profile || null')
    expect(source).toContain('@model-click="openSessionModelPicker(null, $event)"')
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
    expect(source).toContain('const newChatAgentOptions = computed(() => AGENT_OPTIONS.filter(')
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

  it('creates a conversation from the inline composer submission', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('class="new-chat-page"')
    expect(source).toContain(':submit="submitNewChat"')
    expect(source).not.toContain('<NDrawer')
    expect(source).not.toContain('{{ t("chat.newChat") }}\n            </NButton>')
  })

  it('offers MoA only for Hermes session creation and switching', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('if (group.provider === "moa") return newChatAgent.value === "hermes"')
    expect(source).toContain('group.provider === "moa"\n          ? isSessionModelHermes.value')
    expect(source).toContain("selection.provider === 'moa'")
    expect(source).toContain('await applySessionModelSwitch(preset, "moa")')
  })
})
