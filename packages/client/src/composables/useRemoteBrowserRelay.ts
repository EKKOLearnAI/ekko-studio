import { ref } from 'vue'
import { io, type Socket } from 'socket.io-client'
import { getActiveProfileName, getApiKey, getBaseUrlValue } from '@/api/client'
import { onAuthInvalidated } from '@/api/auth-invalidation'
import { socketEndpoint } from '@/utils/deployment-url'
import { desktopBridge } from '@/utils/desktop-bridge'

// One desktop capability per main renderer; survives panel collapse, not logout.
export const remoteBrowserEnabled = ref(false)
export const remoteBrowserOwnerState = ref<'active' | 'standby' | 'busy' | 'connecting'>('connecting')
let stopGrantState: (() => void) | null = null
let stopActivity: (() => void) | null = null
let generation = 0
let socket: Socket | null = null
let stopAuth: (() => void) | null = null
let cancelConnection: (() => void) | null = null
let resumeTimer: ReturnType<typeof setTimeout> | null = null

// In remote mode the Desktop browser is shared automatically whenever this
// renderer is logged in; dropped connections are retried in the background.
const RESUME_DELAY_MS = 5000

/** Connect the Desktop browser relay if possible; never throws and never prompts. */
export async function ensureRemoteBrowserRelay(): Promise<void> {
  if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null }
  const bridge = desktopBridge()
  if (remoteBrowserEnabled.value || cancelConnection || !bridge?.remoteMode || !bridge.browser?.remoteRequest || !bridge.browser.setRemoteControl || !getApiKey()) return
  try { await startRemoteBrowserRelay() } catch (error) { console.warn('[desktop-browser] remote control is not connected', error) }
}

function scheduleResume(): void {
  if (resumeTimer || !getApiKey()) return
  resumeTimer = setTimeout(() => { resumeTimer = null; void ensureRemoteBrowserRelay() }, RESUME_DELAY_MS)
}

export async function stopRemoteBrowserRelay(): Promise<void> {
  generation++
  if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null }
  remoteBrowserEnabled.value = false
  remoteBrowserOwnerState.value = 'connecting'
  stopGrantState?.(); stopGrantState = null
  stopActivity?.(); stopActivity = null
  cancelConnection?.(); cancelConnection = null
  const previous = socket
  socket = null
  previous?.removeAllListeners()
  previous?.disconnect()
  stopAuth?.(); stopAuth = null
  await desktopBridge()?.browser?.setRemoteControl?.(false)
}

export async function startRemoteBrowserRelay(): Promise<void> {
  await stopRemoteBrowserRelay()
  const startedGeneration = generation
  const bridge = desktopBridge()
  if (!bridge?.remoteMode || !bridge.browser?.remoteRequest || !getApiKey()) throw new Error('Remote Desktop browser requires a Studio login and updated Desktop client')
  try {
    if (!await bridge.browser.setRemoteControl?.(true)) return
  } catch (error) { await stopRemoteBrowserRelay(); throw error }
  stopGrantState = bridge.browser.onRemoteControlState?.(enabled => {
    if (!enabled && generation === startedGeneration) { void stopRemoteBrowserRelay(); scheduleResume() }
  }) || null
  if (generation !== startedGeneration) { await bridge.browser.setRemoteControl?.(false); return }
  const endpoint = socketEndpoint(getBaseUrlValue(), '/desktop-browser')
  const connection = io(endpoint.url, {
    path: endpoint.path, auth: { token: getApiKey(), profile: getActiveProfileName() || 'default' },
    transports: ['websocket'], reconnection: false, timeout: 300_000,
  })
  socket = connection
  let lastActivity = -Infinity
  const reportActivity = (event: Event) => {
    if (!event.isTrusted || document.visibilityState !== 'visible' || !connection.connected) return
    const now = performance.now()
    if (now - lastActivity < 1000) return
    lastActivity = now
    connection.emit('browser.user-activity')
  }
  // Capture real input, not focus/visibility, timers or synthetic Agent events.
  const activityEvents = ['pointerdown', 'keydown', 'wheel'] as const
  for (const event of activityEvents) window.addEventListener(event, reportActivity, { capture: true, passive: true })
  stopActivity = () => { for (const event of activityEvents) window.removeEventListener(event, reportActivity, true) }
  connection.on('browser.owner-state', state => {
    if (socket === connection && ['active', 'standby', 'busy'].includes(state)) remoteBrowserOwnerState.value = state
  })
  stopAuth = onAuthInvalidated(() => { void stopRemoteBrowserRelay() })
  connection.on('browser.request', async (body, acknowledge) => {
    if (typeof acknowledge !== 'function') return
    try {
      if (socket !== connection || !remoteBrowserEnabled.value) throw new Error('Desktop browser relay revoked')
      const envelope = await bridge.browser!.remoteRequest!(body)
      acknowledge({ envelope })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Desktop browser request failed'
      acknowledge({ error: message })
      // Older Desktop versions have no state event; still fail closed on the
      // canonical permission errors instead of advertising a dead capability.
      if (/remote control has not been authorized|browser permission was revoked/i.test(message) && socket === connection) void stopRemoteBrowserRelay()
    }
  })
  const stop = () => {
    if (socket !== connection) return
    void stopRemoteBrowserRelay()
    scheduleResume()
  }
  connection.on('disconnect', stop)
  connection.on('browser.revoked', stop)
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel: (() => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      cancel = () => reject(new Error('Desktop browser connection was cancelled'))
      cancelConnection = cancel
      connection.on('connect', () => resolve())
      connection.on('connect_error', error => {
        reject(error)
        stop()
      })
      timer = setTimeout(() => {
        reject(new Error('Desktop browser connection timed out'))
        stop()
      }, 300_000)
      if (connection.connected) resolve()
    })
    if (socket !== connection || generation !== startedGeneration) throw new Error('Desktop browser connection was cancelled')
    remoteBrowserEnabled.value = true
  } catch (error) {
    if (socket === connection) await stopRemoteBrowserRelay()
    throw error
  } finally {
    clearTimeout(timer)
    if (cancelConnection === cancel) cancelConnection = null
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => { void stopRemoteBrowserRelay() })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void ensureRemoteBrowserRelay() })
}
