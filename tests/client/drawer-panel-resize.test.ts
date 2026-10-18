import { readPresetStyleSource as readFileSync } from './preset-style-source'
import { describe, expect, it } from 'vitest'

describe('ChatPanel tool drawer resizing support', () => {
  it('persists and clamps the live chat tool panel width while keeping mobile full width', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('class="chat-tool-panel"')
    expect(source).toContain('const TOOL_PANEL_STORAGE_KEY = "hermes.chat.toolPanelWidth"')
    expect(source).toContain('function clampToolPanelWidth')
    expect(source).toContain('Math.floor(available * 0.88)')
    expect(source).toContain('window.localStorage.setItem(TOOL_PANEL_STORAGE_KEY')
    expect(source).toContain('window.addEventListener("resize", handleToolPanelViewportResize)')
    expect(source).toContain('watch(showToolPanel')
    expect(source).toContain('width: 100% !important;')
    expect(source).toContain('deltaSign: document.documentElement.dir === "rtl" ? 1 : -1')
    expect(source).toMatch(/\.chat-tool-resize-handle\s*\{[\s\S]*inset-inline-start: -7px;/)
  })

  it('mirrors group-chat and workflow resize seams without changing LTR sizing', () => {
    const groupSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const workflowSource = readFileSync('packages/client/src/views/hermes/WorkflowView.vue', 'utf8')

    expect(groupSource).toContain("deltaSign: document.documentElement.dir === 'rtl' ? 1 : -1")
    expect(groupSource).toMatch(/\.group-workspace-resize-handle\s*\{[\s\S]*inset-inline-start: -7px;/)
    expect(workflowSource).toContain("deltaSign: document.documentElement.dir === 'rtl' ? -1 : 1")
    expect(workflowSource).toMatch(/\.workflow-chat-resize-handle\s*\{[\s\S]*inset-inline-end: -7px;/)
  })

  it('uses a full-width mobile workspace tree and replaces it with the selected file', () => {
    const filesSource = readFileSync('packages/client/src/components/hermes/chat/FilesPanel.vue', 'utf8')
    const workflowSource = readFileSync('packages/client/src/views/hermes/WorkflowView.vue', 'utf8')

    expect(filesSource).toContain("'mobile-file-open': mobileFileOpen")
    expect(filesSource).toMatch(/\.files-tree-panel\s*\{[\s\S]*width: 100% !important;/)
    expect(filesSource).toMatch(/\.files-panel-drawer\.mobile-file-open \.files-tree-panel\s*\{\s*display: none;/)
    expect(filesSource).toContain('@click="handleMobileBack"')
    expect(workflowSource).toMatch(/\.workflow-runs-panel\s*\{[\s\S]*inset-inline-end: 0;[\s\S]*&:dir\(rtl\)\s*\{[\s\S]*box-shadow: 8px/)
  })

  it('keeps native Windows title-bar geometry LTR in every app language', () => {
    const source = readFileSync('packages/client/src/components/layout/DesktopTitleBar.vue', 'utf8')

    expect(source).toMatch(/\.desktop-titlebar\s*\{[\s\S]*direction: ltr;/)
  })

  it('renders the workspace, terminal, and desktop browser tabs as a full-height right icon rail', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('class="chat-tool-tabs" role="tablist"')
    expect(source).toContain(':aria-label="t(\'drawer.files\')"')
    expect(source).toContain(':aria-label="t(\'drawer.terminal\')"')
    expect(source).toContain(':aria-label="t(\'browser.title\')"')
    expect(source).toContain('v-if="desktopBrowserAvailable"')
    expect(source).toMatch(/\.chat-tool-panel-inner\s*\{[\s\S]*background: \$bg-main-surface;/)
    expect(source).toMatch(/\.chat-tool-tabs\s*\{[\s\S]*flex-direction: column;[\s\S]*order: 2;[\s\S]*height: 100%;[\s\S]*border-inline-start:/)
    expect(source).toMatch(/\.chat-tool-content\s*\{\s*order: 1;[\s\S]*background: \$bg-main-surface;/)
  })

  it('animates the single and group chat tool panels without exposing the native browser mid-transition', () => {
    const chatSource = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')
    const groupSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const browserSource = readFileSync('packages/client/src/components/hermes/chat/DesktopBrowserPanel.vue', 'utf8')

    for (const source of [chatSource, groupSource]) {
      expect(source).toContain('<Transition')
      expect(source).toContain('name="tool-panel"')
      expect(source).toContain('@before-enter="handleToolPanelBeforeEnter"')
      expect(source).toContain('@after-enter="handleToolPanelAfterEnter"')
      expect(source).toContain('@before-leave="handleToolPanelBeforeLeave"')
      expect(source).toContain('@leave-cancelled="handleToolPanelLeaveCancelled"')
      expect(source).toContain('@media (prefers-reduced-motion: reduce)')
      expect(source).toContain('.tool-panel-enter-from:dir(rtl)')
      expect(source).not.toMatch(/:global\(\[dir=['"]rtl['"]\]\)/)
    }

    expect(chatSource).toContain(':visible="toolPanelTransitionReady"')
    expect(groupSource).toContain(':visible="toolPanelTransitionReady"')
    expect(chatSource).toMatch(/\.tool-panel-enter-active,[\s\S]*transition:[\s\S]*width 0\.25s/)
    expect(groupSource).toMatch(/\.tool-panel-enter-active,[\s\S]*transition:[\s\S]*width 0\.25s/)
    expect(chatSource).toMatch(/\.tool-panel-enter-from,[\s\S]*width: 0 !important;[\s\S]*min-width: 0;/)
    expect(groupSource).toMatch(/\.tool-panel-enter-from,[\s\S]*width: 0 !important;[\s\S]*min-width: 0;/)
    expect(browserSource).toContain('visible?: boolean')
    expect(browserSource).toContain('props.visible && !externalOverlayOpen.value')
  })

  it('uses the drawer content surface for the conversation outline', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/OutlinePanel.vue', 'utf8')

    expect(source).toMatch(/\.outline-panel\s*\{[\s\S]*background-color: \$bg-main-surface;/)
  })

  it('keeps workspace diffs and their editor stretched across the drawer', () => {
    const source = readFileSync('packages/client/src/components/hermes/files/WorkspaceDiffPreview.vue', 'utf8')

    expect(source).toMatch(/\.workspace-diff-preview\s*\{[\s\S]*flex: 1;[\s\S]*width: 100%;[\s\S]*min-width: 0;/)
    expect(source).toMatch(/\.diff-preview-content\s*\{[\s\S]*min-width: 0;/)
    expect(source).toMatch(/:deep\(\.file-editor\)\s*\{[\s\S]*width: 100%;[\s\S]*min-width: 0;/)
  })
})
