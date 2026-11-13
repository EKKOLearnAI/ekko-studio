import { desktopBridge, hasDesktopBrowserBridge } from './desktop-bridge'

export type LinkOpenTarget = 'hermes-studio' | 'default-browser'

export const LINK_OPEN_TARGET_STORAGE_KEY = 'hermes_link_open_target'
export const DEFAULT_LINK_OPEN_TARGET: LinkOpenTarget = 'hermes-studio'

export function getLinkOpenTarget(): LinkOpenTarget {
  if (typeof window === 'undefined') return DEFAULT_LINK_OPEN_TARGET
  try {
    return window.localStorage.getItem(LINK_OPEN_TARGET_STORAGE_KEY) === 'default-browser'
      ? 'default-browser'
      : DEFAULT_LINK_OPEN_TARGET
  } catch {
    return DEFAULT_LINK_OPEN_TARGET
  }
}

export function setLinkOpenTarget(target: LinkOpenTarget): LinkOpenTarget {
  const normalized = target === 'default-browser' ? 'default-browser' : DEFAULT_LINK_OPEN_TARGET
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(LINK_OPEN_TARGET_STORAGE_KEY, normalized)
  }
  return normalized
}

export const OPEN_DESKTOP_BROWSER_PANEL_EVENT = 'hermes:open-desktop-browser-panel'

function revealDesktopBrowserPanel(): void {
  window.dispatchEvent(new CustomEvent(OPEN_DESKTOP_BROWSER_PANEL_EVENT))
}

export async function openUrlInDesktopBrowser(url: string): Promise<boolean> {
  const bridge = desktopBridge()
  if (getLinkOpenTarget() === 'default-browser') {
    if (typeof bridge?.openExternalUrl !== 'function') return false
    const opened = await bridge.openExternalUrl(url)
    if (!opened) throw new Error('Failed to open URL in the default browser')
    return true
  }
  if (!hasDesktopBrowserBridge()) return false
  const browser = bridge?.browser
  if (!browser) return false
  const tabCreation = browser.createTab(url, true)
  revealDesktopBrowserPanel()
  await tabCreation
  return true
}

export async function openHtmlInDesktopBrowser(html: string, title: string): Promise<boolean> {
  if (!hasDesktopBrowserBridge()) return false
  const browser = desktopBridge()?.browser
  if (!browser?.createHtmlPreviewTab) return false
  await browser.createHtmlPreviewTab(html, title, true)
  revealDesktopBrowserPanel()
  return true
}
