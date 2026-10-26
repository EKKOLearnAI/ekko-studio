import { deploymentUrl } from './deployment-url'
interface CompletionNotificationPayload {
  title: string
  body?: string
  icon?: string
  tag?: string
}

export interface SystemNotificationPayload extends CompletionNotificationPayload {
  clickUrl?: string
  onClick?: () => void
}

interface HermesDesktopBridge {
  isDesktop?: boolean
  notifyCompletion?: (payload: CompletionNotificationPayload & { clickUrl?: string }) => Promise<boolean>
}

export interface CompletionNotificationPermissionResult {
  granted: boolean
  reason?: 'unsupported' | 'insecure' | 'denied'
}

type WindowWithHermesDesktop = Window & typeof globalThis & {
  hermesDesktop?: HermesDesktopBridge
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), timeoutMs)
    promise.then(
      value => {
        window.clearTimeout(timer)
        resolve(value)
      },
      () => {
        window.clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

function desktopBridge(): HermesDesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as WindowWithHermesDesktop).hermesDesktop
}

function supportsBrowserNotification(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

function isBrowserNotificationSecureContext(): boolean {
  if (typeof window === 'undefined') return false
  return window.isSecureContext
}

function safeHermesClickUrl(value?: string): string | undefined {
  if (!value || !value.startsWith('/hermes/') || value.includes('..') || value.includes('\\')) return undefined
  return value
}

function browserNotificationOptions(payload: SystemNotificationPayload): NotificationOptions {
  const clickUrl = safeHermesClickUrl(payload.clickUrl)
  return {
    body: payload.body,
    icon: payload.icon ? new URL(deploymentUrl(payload.icon), window.location.origin).href : undefined,
    tag: payload.tag,
    data: clickUrl ? { clickUrl } : undefined,
  }
}

async function showServiceWorkerNotification(payload: SystemNotificationPayload): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker || typeof navigator.serviceWorker.register !== 'function') return false

  try {
    const registration = await withTimeout(
      navigator.serviceWorker.register('/notification-sw.js'),
      3000,
      null,
    )
    if (!registration) return false
    await withTimeout(navigator.serviceWorker.ready, 3000, registration)
    await registration.showNotification(payload.title, browserNotificationOptions(payload))
    return true
  } catch (err) {
    console.warn('Failed to show service worker notification:', err)
    return false
  }
}

export function isDesktopNotificationRuntime(): boolean {
  return desktopBridge()?.isDesktop === true
}

export async function requestCompletionNotificationPermission(): Promise<CompletionNotificationPermissionResult> {
  if (isDesktopNotificationRuntime()) return { granted: true }
  if (!supportsBrowserNotification()) return { granted: false, reason: 'unsupported' }
  if (!isBrowserNotificationSecureContext()) return { granted: false, reason: 'insecure' }
  if (Notification.permission === 'granted') return { granted: true }
  if (Notification.permission === 'denied') return { granted: false, reason: 'denied' }

  try {
    const permission = await withTimeout(
      Notification.requestPermission(),
      5000,
      'default' as NotificationPermission,
    )
    return permission === 'granted'
      ? { granted: true }
      : { granted: false, reason: permission === 'denied' ? 'denied' : 'unsupported' }
  } catch {
    return { granted: false, reason: 'unsupported' }
  }
}

export async function showCompletionNotification(payload: CompletionNotificationPayload): Promise<boolean> {
  return showSystemNotification(payload, { requireBackground: false, deduplicate: false })
}

const announcedSystemNotificationTags = new Set<string>()
const SYSTEM_NOTIFICATION_LEDGER_KEY = 'hermes-system-notification-ledger-v1'
const SYSTEM_NOTIFICATION_FOREGROUND_KEY = 'hermes-system-notification-foreground-v1'
const SYSTEM_NOTIFICATION_FOREGROUND_TAB_PREFIX = 'hermes-system-notification-foreground-v2:'
const SYSTEM_NOTIFICATION_LEDGER_TTL = 7 * 24 * 60 * 60 * 1000
const SYSTEM_NOTIFICATION_FOREGROUND_TTL = 5000
const SYSTEM_NOTIFICATION_TAB_ID = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random()}`

function isCurrentDocumentForeground(): boolean {
  return typeof document !== 'undefined' && !document.hidden && document.hasFocus()
}

function currentForegroundHeartbeatKey(): string {
  return `${SYSTEM_NOTIFICATION_FOREGROUND_TAB_PREFIX}${SYSTEM_NOTIFICATION_TAB_ID}`
}

function freshHeartbeat(timestamp: number, now = Date.now()): boolean {
  return Number.isFinite(timestamp) && now - timestamp < SYSTEM_NOTIFICATION_FOREGROUND_TTL
}

function hasLegacyForegroundHeartbeat(now: number): boolean {
  try {
    const parsed = JSON.parse(localStorage.getItem(SYSTEM_NOTIFICATION_FOREGROUND_KEY) || '{}') as Record<string, number>
    return Object.values(parsed).some(timestamp => freshHeartbeat(timestamp, now))
  } catch {
    return false
  }
}

function recordForegroundHeartbeat() {
  try {
    const key = currentForegroundHeartbeatKey()
    if (isCurrentDocumentForeground()) localStorage.setItem(key, String(Date.now()))
    else localStorage.removeItem(key)
  } catch {
    // Foreground detection falls back to this document when storage is blocked.
  }
}

function releaseForegroundHeartbeat() {
  try {
    localStorage.removeItem(currentForegroundHeartbeatKey())
  } catch {
    // Foreground detection falls back to this document when storage is blocked.
  }
}

function hasFreshForegroundHeartbeat(): boolean {
  try {
    const now = Date.now()
    let hasFreshHeartbeat = hasLegacyForegroundHeartbeat(now)
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index)
      if (!key?.startsWith(SYSTEM_NOTIFICATION_FOREGROUND_TAB_PREFIX)) continue
      const timestamp = Number(localStorage.getItem(key))
      if (freshHeartbeat(timestamp, now)) hasFreshHeartbeat = true
      else localStorage.removeItem(key)
    }
    return hasFreshHeartbeat
  } catch {
    // Foreground detection falls back to this document when storage is blocked.
  }
  return false
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  recordForegroundHeartbeat()
  window.addEventListener('focus', recordForegroundHeartbeat)
  window.addEventListener('blur', releaseForegroundHeartbeat)
  window.addEventListener('pagehide', releaseForegroundHeartbeat)
  document.addEventListener('visibilitychange', recordForegroundHeartbeat)
  window.setInterval(recordForegroundHeartbeat, 2000)
}

function sharedLedgerContains(tag: string): boolean {
  try {
    const now = Date.now()
    const parsed = JSON.parse(localStorage.getItem(SYSTEM_NOTIFICATION_LEDGER_KEY) || '{}') as Record<string, number>
    const fresh = Object.fromEntries(Object.entries(parsed).filter(([, timestamp]) => now - timestamp < SYSTEM_NOTIFICATION_LEDGER_TTL))
    localStorage.setItem(SYSTEM_NOTIFICATION_LEDGER_KEY, JSON.stringify(fresh))
    return typeof fresh[tag] === 'number'
  } catch {
    return false
  }
}

function recordSharedLedger(tag: string) {
  try {
    const parsed = JSON.parse(localStorage.getItem(SYSTEM_NOTIFICATION_LEDGER_KEY) || '{}') as Record<string, number>
    parsed[tag] = Date.now()
    localStorage.setItem(SYSTEM_NOTIFICATION_LEDGER_KEY, JSON.stringify(parsed))
  } catch {
    // In-memory dedupe remains available when storage is blocked.
  }
}

async function claimSystemNotification(tag: string, deliver: () => Promise<boolean>): Promise<boolean> {
  const claim = async () => {
    if (announcedSystemNotificationTags.has(tag) || sharedLedgerContains(tag)) return false
    const shown = await deliver()
    if (shown) {
      announcedSystemNotificationTags.add(tag)
      recordSharedLedger(tag)
    }
    return shown
  }
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks?.request) return claim()
  return locks.request(`hermes-system-notification:${tag}`, { ifAvailable: true }, lock => lock ? claim() : false)
}

export async function showSystemNotification(
  payload: SystemNotificationPayload,
  options: { requireBackground?: boolean; deduplicate?: boolean } = {},
): Promise<boolean> {
  const requireBackground = options.requireBackground !== false
  const deduplicate = options.deduplicate !== false
  if (requireBackground && (isCurrentDocumentForeground() || hasFreshForegroundHeartbeat())) return false

  const deliver = async (): Promise<boolean> => {
    const bridge = desktopBridge()
    if (bridge?.isDesktop && bridge.notifyCompletion) {
      try {
        return await bridge.notifyCompletion({ ...payload, clickUrl: safeHermesClickUrl(payload.clickUrl) })
      } catch (err) {
        console.warn('Failed to show desktop system notification:', err)
        return false
      }
    }

    if (!supportsBrowserNotification() || !isBrowserNotificationSecureContext() || Notification.permission !== 'granted') {
      return false
    }

    try {
      if (!payload.onClick && await showServiceWorkerNotification(payload)) return true

      const notification = new Notification(payload.title, browserNotificationOptions(payload))
      notification.onclick = () => {
        window.focus()
        if (payload.onClick) payload.onClick()
        else {
          const clickUrl = safeHermesClickUrl(payload.clickUrl)
          if (clickUrl) window.location.hash = `#${clickUrl}`
        }
        notification.close()
      }
      return true
    } catch (err) {
      console.warn('Failed to show browser system notification:', err)
      return false
    }
  }

  return deduplicate && payload.tag ? claimSystemNotification(payload.tag, deliver) : deliver()
}
