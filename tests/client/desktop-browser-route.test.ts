// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  delete (window as typeof window & { hermesDesktop?: unknown }).hermesDesktop
  vi.resetModules()
})

describe('desktop browser chat panel gate', () => {
  function browserBridge() {
    const methods = [
      'getState', 'setViewport', 'createTab', 'closeTab', 'activateTab', 'navigate',
      'navigationAction', 'createProfile', 'chooseProfileRootDirectory', 'renameProfile', 'profileSwitchImpact',
      'switchProfile', 'updateProfile', 'deleteProfile', 'clearProfileData', 'cancelDownload',
      'takeOver', 'annotate', 'cancelAnnotation', 'updateAnnotationNote',
      'captureAnnotations', 'clearAnnotations',
      'onAnnotationRequest', 'onStateChange',
    ]
    return Object.fromEntries(methods.map(method => [method, vi.fn()]))
  }

  it('does not register the settings route in an ordinary Web UI', async () => {
    const router = (await import('../../packages/client/src/router')).default
    expect(router.hasRoute('hermes.browser')).toBe(false)
  })

  it('registers the settings route only with the complete desktop bridge', async () => {
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = { isDesktop: true, browser: browserBridge() }
    const router = (await import('../../packages/client/src/router')).default
    expect(router.hasRoute('hermes.browser')).toBe(true)
  })

  it('accepts only the complete trusted desktop bridge', async () => {
    const { hasDesktopBrowserBridge } = await import('../../packages/client/src/utils/desktop-bridge')
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = { isDesktop: true, browser: browserBridge() }
    expect(hasDesktopBrowserBridge()).toBe(true)

    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = { isDesktop: true, browser: { getState: vi.fn() } }
    expect(hasDesktopBrowserBridge()).toBe(false)

    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = { isDesktop: true }
    expect(hasDesktopBrowserBridge()).toBe(false)
  })

  it('separates the pure browser panel from the settings-only page', () => {
    const chatPanel = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')
    const groupChatPanel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
    const browserPanel = readFileSync('packages/client/src/components/hermes/chat/DesktopBrowserPanel.vue', 'utf8')
    const settingsPage = readFileSync('packages/client/src/views/hermes/DesktopBrowserView.vue', 'utf8')
    const sidebar = readFileSync('packages/client/src/components/layout/AppSidebar.vue', 'utf8')
    expect(chatPanel).toContain("const DesktopBrowserPanel = defineAsyncComponent")
    expect(chatPanel).toContain('v-if="desktopBrowserAvailable"')
    expect(chatPanel).toContain("activeToolPanel === 'browser'")
    expect(chatPanel).toContain(':submit="submitBrowserAnnotations"')
    expect(chatPanel).toContain('await chatStore.sendMessage("", [attachment])')
    expect(chatPanel).toContain('OPEN_DESKTOP_BROWSER_PANEL_EVENT')
    expect(groupChatPanel).toContain("activeWorkspacePanel = ref<'files' | 'terminal' | 'browser'>('files')")
    expect(groupChatPanel).toContain('OPEN_DESKTOP_BROWSER_PANEL_EVENT')
    expect(groupChatPanel).toContain('const DesktopBrowserPanel = defineAsyncComponent')
    expect(groupChatPanel).toContain("activeWorkspacePanel === 'browser'")
    expect(groupChatPanel).toContain(':submit="submitBrowserAnnotations"')
    expect(groupChatPanel).toContain("await store.sendMessage('', [attachment])")
    expect(browserPanel).toContain('onAnnotationRequest')
    expect(browserPanel).toContain('EXTERNAL_OVERLAY_SELECTOR')
    expect(browserPanel).toContain("'.n-modal-body-wrapper'")
    expect(browserPanel).toContain("'.n-drawer-mask'")
    expect(browserPanel).toContain("'.image-preview-overlay'")
    expect(browserPanel).toContain('OVERLAY_RECHECK_DELAYS')
    expect(browserPanel).toContain('scheduleExternalOverlayCheck')
    expect(browserPanel).toContain('class="annotation-editor"')
    expect(browserPanel).toContain('class="annotation-popover"')
    expect(browserPanel).toContain('class="annotation-note-input"')
    expect(browserPanel).toContain('data-testid="browser-profile-switcher"')
    expect(browserPanel).toContain('class="download-popover"')
    expect(browserPanel).toContain('cancelDownload(item.id)')
    expect(browserPanel).toContain('background: var(--n-color, var(--bg-card))')
    expect(browserPanel).toContain('color-scheme: inherit')
    expect(browserPanel).toContain('background: var(--theme-overlay-bg, var(--bg-card))')
    expect(browserPanel).toContain('--n-color: var(--theme-overlay-bg, var(--bg-card)) !important')
    expect(browserPanel).toContain('--n-text-color: var(--text-primary) !important')
    expect(browserPanel).not.toContain('--n-color: #fff !important')
    expect(browserPanel).toContain('color: var(--text-primary, #1a1a1a)')
    expect(browserPanel).toContain('background: var(--bg-card, #fff)')
    expect(browserPanel).not.toContain('.tab.active { background: var(--card-color, #fff); }')
    expect(browserPanel).toContain('annotations: annotations.value')
    expect(browserPanel).toContain('const submitted = await props.submit(submission)')
    expect(browserPanel).toContain(':loading="annotationSubmitting"')
    expect(browserPanel).not.toContain("emit('attach'")
    expect(browserPanel).not.toContain('appendText')
    expect(browserPanel).toContain("'--annotation-left'")
    expect(browserPanel).toContain("'--annotation-bottom'")
    expect(browserPanel).not.toContain('profile-select')
    expect(settingsPage).toContain('class="browser-settings-page"')
    expect(settingsPage).toContain('class="header-title"')
    expect(settingsPage).toContain('class="header-actions"')
    expect(settingsPage).not.toContain("t('browser.settings')")
    expect(settingsPage).not.toContain('.page-header { min-height: 72px;')
    expect(settingsPage).toContain('.profile-card.active { border-color: rgba(var(--accent-primary-rgb), .55);')
    expect(settingsPage).toContain('color: var(--accent-primary);')
    expect(settingsPage).toContain('class="profiles-grid"')
    expect(settingsPage).toContain('class="profile-card"')
    expect(settingsPage).toContain('v-for="profile in state.profiles"')
    expect(settingsPage).toContain('@click="openCreateProfile"')
    expect(settingsPage).toContain('@click="openEditProfile(profile)"')
    expect(settingsPage).toContain("profileModalMode === 'create'")
    expect(settingsPage).toContain('choose-browser-profile-root')
    expect(settingsPage).toContain("profilePath(selected, 'data')")
    expect(settingsPage).toContain("profilePath(selected, 'download')")
    expect(settingsPage).toContain("profileProxyMode === 'fixed_servers'")
    expect(settingsPage).not.toContain('class="active-profile-select"')
    expect(settingsPage).not.toContain('native-viewport')
    expect(settingsPage).not.toContain('navigationAction')
    expect(sidebar).toContain("hermes.browser")
  })
})
