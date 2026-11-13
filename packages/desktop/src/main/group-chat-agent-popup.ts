import type { WindowOpenHandlerResponse } from 'electron'

export const GROUP_CHAT_AGENT_LINK_FRAME = 'hermes-group-chat-agent-link'

export function isGroupChatAgentLinkPopup(url: string, frameName: string): boolean {
  if (frameName !== GROUP_CHAT_AGENT_LINK_FRAME) return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (parsed.username || parsed.password) return false
    if (parsed.pathname !== '/') return false
    if (parsed.searchParams.size !== 1 || parsed.searchParams.get('groupChatAgentLink') !== '1') return false
    return parsed.hash === '#/group-chat-link' || parsed.hash.startsWith('#/group-chat-link?')
  } catch {
    return false
  }
}

export function groupChatAgentLinkPopupResponse(
  url: string,
  frameName: string,
): WindowOpenHandlerResponse | null {
  if (!isGroupChatAgentLinkPopup(url, frameName)) return null
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      width: 540,
      height: 720,
      minWidth: 480,
      minHeight: 600,
      title: 'Ekko Studio',
      backgroundColor: '#1a1a1a',
      autoHideMenuBar: true,
      show: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    },
  }
}
