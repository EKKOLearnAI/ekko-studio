import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

function headerActionsSource() {
  const start = source.indexOf('<div class="header-actions">')
  const end = source.indexOf('</header>', start)
  return source.slice(start, end)
}

describe('ChatPanel session action menus', () => {
  it('keeps the side-panel button and replaces the two adjacent actions with one accessible menu button', () => {
    const header = headerActionsSource()

    expect(header.match(/<NButton/g)).toHaveLength(3)
    expect(header).toContain('class="header-tool-toggle"')
    expect(header).toContain('@click="toggleToolPanel"')
    expect(header).toContain(':aria-label="t(\'chat.sidePanel\')"')
    expect(header).toContain(':aria-expanded="showToolPanel"')
    expect(header).toContain('aria-controls="chat-tool-panel"')
    expect(header).toContain('<NDropdown')
    expect(header).toContain('v-model:show="showActiveSessionMenu"')
    expect(header).toContain(':keyboard="false"')
    expect(header).toContain(':menu-props="activeSessionMenuProps"')
    expect(header).toContain(':node-props="activeSessionMenuNodeProps"')
    expect(header).toContain(':options="activeSessionMenuOptions"')
    expect(header).toContain('@select="handleActiveSessionMenuSelect"')
    expect(header).toContain('class="header-session-menu-trigger"')
    expect(header).toContain(':aria-label="t(\'chat.sessionActions\')"')
    expect(header).toContain(':aria-expanded="showActiveSessionMenu"')
    expect(header).toContain('aria-controls="active-session-actions-menu"')
    expect(header).toContain('<NTooltip trigger="hover" :disabled="showActiveSessionMenu">')
    expect(header).toContain('{{ t("chat.sessionActions") }}')
    expect(header).not.toContain('{{ t("chat.more") }}')
    expect(header).toContain('<circle cx="5" cy="12" r="1.6" />')
    expect(header).toContain('<circle cx="12" cy="12" r="1.6" />')
    expect(header).toContain('<circle cx="19" cy="12" r="1.6" />')
    expect(header).not.toContain('@click="showOutline = !showOutline"')
    expect(header).not.toContain('@click="copySessionId()"')
  })

  it('routes all four current-session menu actions through the existing behavior', () => {
    expect(source).toContain('const activeSessionMenuOptions = computed<DropdownOption[]>(() => buildActiveSessionMenuOptions({')
    expect(source).toContain('canRename: activeSessionSupportsPersistence.value')
    expect(source).toContain('canOpen: activeSessionSupportsPersistence.value')
    expect(source).toContain('function handleActiveSessionMenuSelect(key: string)')
    expect(source).toContain('showOutline.value = !showOutline.value')
    expect(source).toContain('openRenameSession(sessionId)')
    expect(source).toContain('openSessionInNewTab(sessionId, chatStore.activeSession?.profile || null)')
    expect(source).toContain('void copySessionId(sessionId)')
    expect(source).toContain('window.open(sessionHref(sessionId, profile), "_blank", "noopener,noreferrer")')
    expect(source).toContain('role: "menu"')
    expect(source).toContain('role: "menuitem"')
    expect(source).toContain('function handleActiveSessionMenuKeydown(event: KeyboardEvent)')
    expect(source).toContain('function focusAdjacentToActiveSessionMenuTrigger(backwards: boolean)')
    expect(source).toContain('id="chat-tool-panel"')
    expect(source).toContain(':global(#active-session-actions-menu [role="menuitem"]:focus-visible > .n-dropdown-option-body)')
  })

  it('builds the sidebar context menu with the shared icon-bearing option helper', () => {
    expect(source).toContain('buildSessionContextMenuOptions({')
    expect(source).toContain('categoryChildren: buildSessionCategoryMenuChildren({')
    expect(source).toContain('includeArchive: contextSession.value?.source !== "global_agent"')
    expect(source).toContain('includeModel: canSetContextSessionModel.value')
    expect(source).toContain('open: t(desktopChatWindowAvailable')
  })
})
