import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const readClientFile = (path: string) => readFileSync(`packages/client/src/${path}`, 'utf8')

describe('client style system', () => {
  it('keeps shared page headers on one layout baseline', () => {
    const globalStyles = readClientFile('styles/global.scss')

    expect(globalStyles).toContain('min-height: 64px;')
    expect(globalStyles).toContain('padding: 14px 20px;')
    expect(globalStyles).toContain('.page-header > .header-actions')
  })

  it('aligns SCSS surfaces and radii with the Naive UI theme', () => {
    const variables = readClientFile('styles/variables.scss')
    const theme = readClientFile('styles/theme.ts')

    expect(variables).toContain('--bg-card: #2a2a2a;')
    expect(theme).toContain("cardColor: '#2a2a2a'")
    expect(variables).toContain('$radius-sm: 6px;')
    expect(variables).toContain('$radius-md: 8px;')
    expect(variables).toContain('$radius-lg: 8px;')
    expect(theme).toContain("borderRadius: '8px'")
    expect(theme).toContain("borderRadiusSmall: '6px'")
  })

  it('keeps chat surfaces aligned while preserving composer elevation in dark mode', () => {
    const chatInput = readClientFile('components/hermes/chat/ChatInput.vue')
    const groupChatInput = readClientFile('components/hermes/group-chat/GroupChatInput.vue')
    const virtualMessageList = readClientFile('components/hermes/chat/VirtualMessageList.vue')

    expect(chatInput).toContain('background-color: $bg-main-surface;')
    expect(groupChatInput).toContain('background-color: $bg-main-surface;')
    expect(virtualMessageList).toContain('background-color: $bg-main-surface;')
    expect(chatInput.match(/background-color: #333333;/g)).toHaveLength(1)
    expect(groupChatInput.match(/background-color: #333333;/g)).toHaveLength(1)
  })

  it('keeps message metadata and context usage on custom theme text colors', () => {
    const chatInput = readClientFile('components/hermes/chat/ChatInput.vue')
    const messageItem = readClientFile('components/hermes/chat/MessageItem.vue')
    const groupMessageItem = readClientFile('components/hermes/group-chat/GroupMessageItem.vue')

    expect(messageItem).toMatch(/\.message-meta\s*\{[^}]*color: \$text-muted;/s)
    expect(groupMessageItem).toMatch(/\.message-meta\s*\{[^}]*color: \$text-muted;/s)
    expect(messageItem).not.toContain('color: #999999;')
    expect(groupMessageItem).not.toContain('color: #999999;')
    expect(chatInput).toMatch(/\.context-usage-row\s*\{[^}]*color: \$text-muted;/s)
    expect(chatInput).not.toContain('color: rgba(255, 255, 255, 0.68);')
    expect(chatInput).toContain('rgba(var(--text-muted-rgb), 0.85)')
  })

  it('keeps selected conversation titles on the primary text color', () => {
    const sessionListItem = readClientFile('components/hermes/chat/SessionListItem.vue')
    const groupChatPanel = readClientFile('components/hermes/group-chat/GroupChatPanel.vue')
    const workflowView = readClientFile('views/hermes/WorkflowView.vue')

    expect(sessionListItem).toMatch(
      /\.session-item\.active \.session-item-title\s*\{\s*color: var\(--text-primary\);/,
    )
    expect(groupChatPanel).toMatch(
      /&\.active \.room-name\s*\{\s*color: \$text-primary;/,
    )
    expect(workflowView).toMatch(
      /&\.selected \.workflow-list-name\s*\{\s*color: var\(--text-primary\);/,
    )
  })

  it('uses the custom selection color for the active profile', () => {
    const profileCard = readClientFile('components/hermes/profiles/ProfileCard.vue')

    expect(profileCard).toContain(
      '<NTag v-if="profile.active" size="tiny" type="primary" :bordered="false">',
    )
    expect(profileCard).toMatch(
      /&\.active\s*\{\s*border-color: rgba\(var\(--accent-primary-rgb\), 0\.4\);/,
    )
    expect(profileCard).not.toContain('rgba(var(--success-rgb), 0.4)')
  })

  it('replays the history detail fade when the selected session changes', () => {
    const historyView = readClientFile('views/hermes/HistoryView.vue')
    const historyMessageList = readClientFile('components/hermes/chat/HistoryMessageList.vue')

    expect(historyView).toContain(`:key="historySession?.id || 'history-empty'"`)
    expect(historyMessageList).toContain('animation: history-message-surface-fade-in 1.5s ease both;')
  })

  it('keeps the four-way conversation switch active state visible in dark mode', () => {
    const pageSidebarNav = readClientFile('components/layout/PageSidebarNav.vue')

    expect(pageSidebarNav).toContain(
      ':global(.dark .conversation-switch--four .conversation-switch-tab.active)',
    )
    expect(pageSidebarNav).toContain('background: $bg-card-hover;')
    expect(pageSidebarNav).toContain('inset 0 0 0 1px $border-color')
  })

  it('keeps the agent manager page aligned with the app main surface', () => {
    const agentManagerView = readClientFile('views/hermes/AgentManagerView.vue')
    const chatPanel = readClientFile('components/hermes/chat/ChatPanel.vue')

    expect(agentManagerView).toMatch(
      /\.agent-manager-panel\s*\{[^}]*height: 100%;[^}]*background: \$bg-main-surface;/s,
    )
    expect(agentManagerView).not.toContain('class="agent-manager-sidebar"')
    expect(agentManagerView).not.toContain('.sidebar-summary')
    expect(agentManagerView).not.toContain('.agent-manager-main')
    expect(chatPanel).toContain('<AgentManagerPanel')
    expect(chatPanel).toContain(':sidebar-collapsed="!showSessions"')
    expect(agentManagerView).not.toContain('min-height: 72px;')
    expect(agentManagerView).not.toContain('padding: 14px 24px;')
    expect(agentManagerView).not.toContain("<p>{{ t('agentManager.subtitle') }}</p>")
    expect(agentManagerView).toContain('<rect x="14" y="14" width="7" height="7" />')
    expect(agentManagerView).toMatch(
      /\.coding-agent-grid\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s,
    )
    expect(agentManagerView).not.toContain('class="cli-path"')
    expect(agentManagerView).not.toContain('class="source-panel"')
  })

  it('makes current theme surfaces translucent over custom backgrounds', () => {
    const variables = readClientFile('styles/variables.scss')
    const app = readClientFile('App.vue')
    const globalStyles = readClientFile('styles/global.scss')
    const useTheme = readClientFile('composables/useTheme.ts')
    const groupMessageItem = readClientFile('components/hermes/group-chat/GroupMessageItem.vue')
    const messageItem = readClientFile('components/hermes/chat/MessageItem.vue')
    const customBackgroundStyles = app
      .split('.app-shell--custom-background {')[1]
      ?.split('.app-shell.desktop-platform-darwin')[0]

    expect(variables).toContain('--bg-main-surface-rgb: var(--bg-card-rgb);')
    expect(variables).toContain('--bg-main-surface-rgb: var(--bg-primary-rgb);')
    expect(customBackgroundStyles).toContain('rgba(var(--bg-main-surface-rgb), 0.72)')
    expect(customBackgroundStyles).toContain('rgba(var(--bg-sidebar-surface-rgb), 0.72)')
    expect(customBackgroundStyles).toContain('backdrop-filter: blur(8px) saturate(110%)')
    expect(customBackgroundStyles).toContain(':deep(.chat-panel > .chat-main)')
    expect(customBackgroundStyles).toContain(':deep(.group-chat-panel > .chat-main)')
    expect(customBackgroundStyles).toContain(':deep(.virtual-message-list)')
    expect(customBackgroundStyles).toContain(':deep(.agent-manager-panel)')
    expect(customBackgroundStyles).toMatch(
      /:deep\(\.workflow-view\),[\s\S]*:deep\(\.petdex-view\)\s*\{\s*background-color: transparent;/,
    )
    expect(customBackgroundStyles).toMatch(
      /:deep\(\.chat-main-content\),[\s\S]*:deep\(\.group-chat-surface\)\s*\{[\s\S]*background-color: rgba\(var\(--bg-main-surface-rgb\), 0\.42\);[\s\S]*backdrop-filter: none;/,
    )
    expect(customBackgroundStyles).toMatch(
      /:deep\(\.virtual-message-list\),[\s\S]*:deep\(\.group-message-shell\)\s*\{[\s\S]*background-color: transparent;[\s\S]*backdrop-filter: none;/,
    )
    expect(customBackgroundStyles).toMatch(
      /:deep\(\.chat-panel > \.chat-main\),[\s\S]*background-color: transparent;[\s\S]*backdrop-filter: none;/,
    )
    expect(customBackgroundStyles).toMatch(
      /:deep\(\.chat-panel > \.chat-main > \.chat-header\),[\s\S]*background-color: rgba\(var\(--bg-main-surface-rgb\), 0\.72\);[\s\S]*backdrop-filter: blur\(8px\) saturate\(110%\);/,
    )
    expect(customBackgroundStyles).toMatch(
      /:deep\(\.desktop-titlebar\),[\s\S]*:deep\(\.chat-panel > \.chat-main > \.chat-header\),[\s\S]*background-color: rgba\(var\(--bg-main-surface-rgb\), 0\.72\);[\s\S]*backdrop-filter: blur\(8px\) saturate\(110%\);/,
    )
    expect(customBackgroundStyles).toMatch(
      /:deep\(\.chat-input-area \.input-wrapper\)\s*\{[\s\S]*background-color: rgba\(var\(--bg-main-surface-rgb\), 0\.72\);[\s\S]*backdrop-filter: blur\(8px\) saturate\(110%\);/,
    )
    expect(customBackgroundStyles).toMatch(
      /:deep\(\.browser-settings-page > \.settings-card\)\s*\{\s*background-color: transparent;/,
    )
    expect(groupMessageItem).toMatch(
      /:global\(html\.theme-has-custom-background \.group-message:not\(\.embedded\) \.msg-content:not\(\.agent-error\)\),[\s\S]*background-color: rgba\(var\(--bg-main-surface-rgb\), 0\.78\);[\s\S]*border: 1px solid rgba\(var\(--text-primary-rgb\), 0\.18\);[\s\S]*backdrop-filter: blur\(8px\) saturate\(110%\);/,
    )
    expect(messageItem).toMatch(
      /:global\(html\.theme-has-custom-background \.message\.user \.message-bubble:not\(\.system\):not\(\.command\):not\(\.agent-error\)\),[\s\S]*background-color: rgba\(var\(--bg-main-surface-rgb\), 0\.78\);[\s\S]*border: 1px solid rgba\(var\(--text-primary-rgb\), 0\.18\);[\s\S]*backdrop-filter: blur\(8px\) saturate\(110%\);/,
    )
    expect(customBackgroundStyles).toMatch(
      /:deep\(\.chat-main-content\),[\s\S]*background-color: rgba\(var\(--bg-main-surface-rgb\), 0\.42\);/,
    )
    expect(useTheme).toContain(
      "document.documentElement.classList.toggle('theme-has-custom-background', active)",
    )
    expect(globalStyles).toMatch(
      /html\.theme-has-custom-background\s*\{[\s\S]*\.n-base-select-menu,[\s\S]*\.n-dropdown-menu,[\s\S]*\.n-cascader-menu,[\s\S]*background-color: rgba\(var\(--bg-main-surface-rgb\), 0\.72\) !important;[\s\S]*backdrop-filter: blur\(8px\) saturate\(110%\);/,
    )
  })

  it('keeps mobile custom-background drawers opaque instead of glassy', () => {
    const app = readClientFile('App.vue')
    const customBackgroundStyles = app
      .split('.app-shell--custom-background {')[1]
      ?.split('.app-shell.desktop-platform-darwin')[0]

    expect(customBackgroundStyles).toMatch(
      /@media \(max-width: \$breakpoint-mobile\) \{[\s\S]*:deep\(\.sidebar\),[\s\S]*:deep\(\.hermes-config-sidebar\),[\s\S]*:deep\(\.ekko-config-sidebar\),[\s\S]*:deep\(\.chat-panel > \.session-list\),[\s\S]*:deep\(\.history-panel > \.session-list\),[\s\S]*:deep\(\.group-chat-panel > \.room-sidebar\),[\s\S]*:deep\(\.workflow-view > \.workflow-sidebar\) \{[\s\S]*background-color: var\(--bg-sidebar-surface\);[\s\S]*-webkit-backdrop-filter: none;[\s\S]*backdrop-filter: none;/,
    )
  })

})
