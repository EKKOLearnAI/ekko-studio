import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

describe('desktop chat window', () => {
  it('creates one native-chrome BrowserWindow per session on the standalone chat route', () => {
    const mainSource = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf8')
    const preloadSource = readFileSync(resolve('packages/desktop/src/preload/index.ts'), 'utf8')
    const routerSource = readFileSync(resolve('packages/client/src/router/index.ts'), 'utf8')
    const openChatWindowSource = mainSource.slice(
      mainSource.indexOf('async function openChatWindow'),
      mainSource.indexOf('async function initializeDesktopBrowser'),
    )

    expect(mainSource).toContain('const chatWindows = new Map<string, BrowserWindow>()')
    expect(mainSource).toContain("return webUiHashUrl(`/desktop-chat/${encodeURIComponent(sessionId)}${query}`)")
    expect(openChatWindowSource).not.toContain('frame: false')
    expect(openChatWindowSource).toContain('width: 620')
    expect(openChatWindowSource).toContain('height: 760')
    expect(openChatWindowSource).toContain("titleBarStyle: 'hiddenInset'")
    expect(openChatWindowSource).toContain('titleBarOverlay: { height: 46 }')
    expect(openChatWindowSource).toContain("additionalArguments: desktopPreloadArguments('chat', !!activeRemoteServerUrl)")
    expect(mainSource).toContain("ipcMain.handle('hermes-desktop:open-chat-window'")
    expect(preloadSource).toContain("ipcRenderer.invoke('hermes-desktop:open-chat-window'")
    expect(routerSource).toContain("path: '/desktop-chat/:sessionId'")
    expect(routerSource).toContain('meta: { standaloneChat: true }')
  })

  it('targets window controls at the renderer that invoked them', () => {
    const source = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf8')

    expect(source).toContain('const target = BrowserWindow.fromWebContents(event.sender)')
    expect(source).toContain('return handleWindowControl(target, action)')
  })
})
