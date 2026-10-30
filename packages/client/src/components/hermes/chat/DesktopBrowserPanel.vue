<script setup lang="ts">
import BrowserDownloadRow from '@/components/hermes/BrowserDownloadRow.vue'
import BrowserDownloadIcon from '@/components/hermes/BrowserDownloadIcon.vue'
import BrowserDownloadHistory from '@/components/hermes/BrowserDownloadHistory.vue'
import { useTheme } from '@/composables/useTheme'
import { NSpin, NButton, NInput, NPopover, NSelect, useDialog, useMessage } from 'naive-ui'
import { remoteBrowserOwnerState, remoteBrowserEnabled } from '@/composables/useRemoteBrowserRelay'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import { useI18n } from 'vue-i18n'
import { desktopBridge, type DesktopBrowserSelection, type DesktopBrowserState } from '@/utils/desktop-bridge'
import type { BrowserAnnotationSubmission } from '@/utils/browser-annotation-submit'

const props = withDefaults(defineProps<{
  visible?: boolean
  submit: (submission: BrowserAnnotationSubmission) => boolean | void | Promise<boolean | void>
}>(), {
  visible: true,
})

const { t } = useI18n()
const historyOpen = ref(false)
const downloadsOpen = ref(false)
async function downloadsVisibility(value: boolean) {
  downloadsOpen.value = value
  if (value && bridge?.refreshDownloads) { try { applyState(await bridge.refreshDownloads()) } catch { /* Preserve last known state. */ } }
}
function fullDownloadHistory() {
  downloadsOpen.value = false
  historyOpen.value = true
}
const message = useMessage()
const dialog = useDialog()
const bridge = desktopBridge()?.browser
const { isDark } = useTheme()
let themeSyncQueue: Promise<void> = Promise.resolve()
watch(isDark, dark => {
  if (!bridge?.setColorScheme) return
  themeSyncQueue = themeSyncQueue.catch(() => undefined).then(() => bridge.setColorScheme!(dark ? 'dark' : 'light'))
  void themeSyncQueue.catch(error => { console.warn('[desktop-browser] theme sync failed', error) })
}, { immediate: true })
const EXTERNAL_OVERLAY_SELECTOR = [
  '[data-desktop-browser-overlay]',
  '.n-modal-mask',
  '.n-modal-body-wrapper',
  '.n-drawer-mask',
  '.n-drawer[aria-modal="true"]',
  '.n-popover',
  '.n-dropdown-menu',
  '.n-base-select-menu',
  '.n-select-menu',
  '.n-date-panel',
  '.n-time-picker-panel',
  '.n-color-picker-panel',
  '.n-cascader-menu',
  '.n-message',
  '.n-notification',
  '.drawer-overlay',
  '.drawer-panel',
  '.workspace-dropdown-menu',
  '.image-preview-overlay',
  '.voice-stage',
  '.modal-backdrop',
  '[role="dialog"]',
  '[role="menu"]',
].join(',')
const OVERLAY_RECHECK_DELAYS = [60, 180, 360]
const state = ref<DesktopBrowserState | null>(null)
const address = ref('')
const viewport = ref<HTMLElement>()
const busy = ref(false)
const loadError = ref('')
const externalOverlayOpen = ref(false)
const annotationNote = ref('')
const annotations = ref<Array<{
  marker: number
  mode: 'element' | 'region'
  region: DesktopBrowserSelection['region']
  element?: DesktopBrowserSelection['element']
  note: string
}>>([])
const annotationCapture = ref<{
  file: File
  previewUrl: string
  tabId: string
  url: string
  title: string
  viewport: DesktopBrowserSelection['viewport']
} | null>(null)
const annotationTabId = ref<string | null>(null)
const annotationSubmitting = ref(false)
const annotationRemoving = ref(false)
const pendingAnnotation = ref<{
  marker: number
  mode: 'element' | 'region'
  viewport: DesktopBrowserSelection['viewport']
  region: DesktopBrowserSelection['region']
  element?: DesktopBrowserSelection['element']
} | null>(null)
let resizeObserver: ResizeObserver | null = null
let modalObserver: MutationObserver | null = null
let stopStateListener: (() => void) | undefined
let stopAnnotationRequestListener: (() => void) | undefined
let annotatingTabId: string | null = null
let unmounting = false
let annotationNoteUpdate: Promise<unknown> = Promise.resolve()
let overlayCheckFrame = 0
const overlayCheckTimers = new Map<number, number>()

const activeTab = computed(() => state.value?.tabs.find(tab => tab.id === state.value?.activeTabId))
const profileOptions = computed(() => state.value?.profiles.map(profile => ({ label: profile.name, value: profile.id })) || [])
const historyDownloads = computed(() => state.value?.downloads.filter(item => item.profileId === state.value?.activeProfileId) || [])
const activeProfileDownloads = computed(() => state.value?.downloads
  .filter(item => item.profileId === state.value?.activeProfileId)
  .slice(0, 5) || [])
const activeDownloadCount = computed(() => state.value?.downloads.filter(item => item.profileId === state.value?.activeProfileId && item.state === 'progressing').length || 0)
const annotationCount = computed(() => annotations.value.length + (pendingAnnotation.value ? 1 : 0))
const hasAnnotationSession = computed(() => annotationCount.value > 0)
const annotationItems = computed(() => [
  ...annotations.value,
  ...(pendingAnnotation.value ? [{ ...pendingAnnotation.value, note: annotationNote.value }] : []),
])
const annotationLocked = computed(() => busy.value || annotationSubmitting.value || annotationRemoving.value)
const annotationAbove = computed(() => {
  const pending = pendingAnnotation.value
  if (!pending) return false
  const spaceBelow = pending.viewport.height - pending.region.y - pending.region.height
  return spaceBelow < 180 && pending.region.y >= 180
})
const annotationAnchorStyle = computed(() => {
  const pending = pendingAnnotation.value
  if (!pending) return undefined
  const viewportWidth = Math.max(1, pending.viewport.width)
  const viewportHeight = Math.max(1, pending.viewport.height)
  const left = Math.min(100, Math.max(0, pending.region.x / viewportWidth * 100))
  const top = Math.min(100, Math.max(0, pending.region.y / viewportHeight * 100))
  const bottom = Math.min(100, Math.max(0, (pending.region.y + pending.region.height) / viewportHeight * 100))
  return {
    '--annotation-left': `${left}%`,
    '--annotation-top': `${top}%`,
    '--annotation-bottom': `${bottom}%`,
  }
})

watch(() => activeTab.value?.url, value => { address.value = value || '' }, { immediate: true })
watch(historyOpen, () => { void nextTick(syncViewport) })
watch(externalOverlayOpen, () => { void nextTick(syncViewport) })
watch(() => props.visible, () => { void nextTick(syncViewport) })

function applyState(next: DesktopBrowserState): void {
  state.value = next
}

async function syncViewport(): Promise<void> {
  if (!bridge || !viewport.value) return
  const rect = viewport.value.getBoundingClientRect()
  const visible = props.visible && !externalOverlayOpen.value && !historyOpen.value && !pendingAnnotation.value
    && rect.width > 0 && rect.height > 0 && document.visibilityState === 'visible'
  await bridge.setViewport({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, visible).catch(() => undefined)
}

async function run(action: () => Promise<unknown>): Promise<void> {
  busy.value = true
  try {
    await action()
  } catch (error) {
    if (!unmounting) message.error(error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
}

function navigate(): void {
  const tab = activeTab.value
  if (!tab || !address.value.trim()) return
  void run(() => bridge!.navigate(tab.id, address.value.trim()))
}

function navigationAction(action: 'back' | 'forward' | 'reload' | 'stop'): void {
  if (activeTab.value) void run(() => bridge!.navigationAction(activeTab.value!.id, action))
}

function resetAnnotationSession(): void {
  pendingAnnotation.value = null
  annotations.value = []
  annotationCapture.value = null
  annotationTabId.value = null
  annotationNote.value = ''
}

function switchProfile(profileId: string): void {
  if (!bridge || profileId === state.value?.activeProfileId) return
  const applyProfile = (force = false) => run(async () => {
    const next = await bridge.switchProfile(profileId, force)
    resetAnnotationSession()
    applyState(next)
    await nextTick(syncViewport)
  })
  void bridge.profileSwitchImpact().then(impact => {
    if (!impact.requiresConfirmation) return applyProfile()
    dialog.warning({
      title: t('browser.profileSwitchTitle'),
      content: t('browser.profileSwitchWarning', {
        agents: impact.activeAgentRuns,
        downloads: impact.activeDownloads,
        annotations: impact.pendingAnnotations,
      }),
      positiveText: t('common.confirm'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => applyProfile(true),
    })
  }).catch(error => message.error(error instanceof Error ? error.message : String(error)))
}

function createTab(): void {
  if (hasAnnotationSession.value) return
  void run(() => bridge!.createTab('about:blank', true))
}

function closeTab(tabId: string, event: MouseEvent): void {
  event.stopPropagation()
  if (hasAnnotationSession.value) return
  void run(() => bridge!.closeTab(tabId))
}

function activateTab(tabId: string): void {
  if (hasAnnotationSession.value) return
  void run(() => bridge!.activateTab(tabId))
}

function takeOver(): void {
  if (activeTab.value) void run(() => bridge!.takeOver(activeTab.value!.id))
}

function annotate(mode: 'element' | 'region', tabId?: string): void {
  if (annotationLocked.value || pendingAnnotation.value) return
  const tab = tabId ? state.value?.tabs.find(item => item.id === tabId) : activeTab.value
  if (!tab) return
  if (annotationTabId.value && annotationTabId.value !== tab.id) return
  void run(async () => {
    annotatingTabId = tab.id
    try {
      const selection = await bridge!.annotate(tab.id, mode)
      const bytes = Uint8Array.from(atob(selection.screenshot.data), character => character.charCodeAt(0))
      const file = new File([bytes], `browser-${mode}-${Date.now()}.png`, { type: selection.screenshot.mediaType })
      await bridge!.setViewport({ x: 0, y: 0, width: 1, height: 1 }, false)
      const viewport = selection.viewport || {
        width: selection.screenshot.width,
        height: selection.screenshot.height,
        scaleFactor: 1,
      }
      annotationTabId.value = tab.id
      annotationCapture.value = {
        file,
        previewUrl: `data:${selection.screenshot.mediaType};base64,${selection.screenshot.data}`,
        tabId: selection.tabId,
        url: selection.url,
        title: selection.title,
        viewport,
      }
      pendingAnnotation.value = {
        marker: selection.marker || annotationCount.value + 1,
        mode,
        viewport,
        region: selection.region,
        element: selection.element,
      }
      annotationNote.value = ''
    } finally {
      if (annotatingTabId === tab.id) annotatingTabId = null
    }
  })
}

async function commitPendingAnnotation(restoreViewport = true): Promise<void> {
  const pending = pendingAnnotation.value
  if (!pending) return
  const note = annotationNote.value.trim()
  const tabId = annotationTabId.value
  annotations.value.push({
    marker: pending.marker,
    mode: pending.mode,
    region: pending.region,
    ...(pending.element ? { element: pending.element } : {}),
    note,
  })
  pendingAnnotation.value = null
  annotationNote.value = ''
  annotationNoteUpdate = bridge && tabId
    ? bridge.updateAnnotationNote(tabId, pending.marker, note).catch(() => false)
    : Promise.resolve()
  await annotationNoteUpdate
  if (restoreViewport) await nextTick(syncViewport)
}

async function clearAnnotationSession(): Promise<void> {
  if (annotationLocked.value) return
  const tabId = annotationTabId.value
  resetAnnotationSession()
  if (bridge && tabId) await bridge.clearAnnotations(tabId).catch(() => undefined)
  await nextTick(syncViewport)
}

async function removeAnnotation(marker: number): Promise<void> {
  const tabId = annotationTabId.value
  if (!bridge?.removeAnnotation || !tabId || annotationLocked.value) return
  annotationRemoving.value = true
  try {
    // Save a different pending note before restoring the live page.
    if (pendingAnnotation.value && pendingAnnotation.value.marker !== marker) await commitPendingAnnotation(false)
    await annotationNoteUpdate
    if (!await bridge.removeAnnotation(tabId, marker)) return
    annotations.value = annotations.value.filter(item => item.marker !== marker)
    if (pendingAnnotation.value?.marker === marker) {
      pendingAnnotation.value = null
      annotationNote.value = ''
    }
    if (!annotationCount.value) resetAnnotationSession()
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    annotationRemoving.value = false
    await nextTick(syncViewport)
  }
}

function undoAnnotation(): void {
  const last = annotationItems.value.at(-1)
  if (last) void removeAnnotation(last.marker)
}

async function sendAnnotations(): Promise<void> {
  if (annotationLocked.value) return
  annotationSubmitting.value = true
  try {
    await commitPendingAnnotation(false)
    await annotationNoteUpdate
    const capture = annotationCapture.value
    const tabId = annotationTabId.value
    if (!capture || annotations.value.length === 0) return
    let file = capture.file
    if (bridge && tabId) {
      const screenshot = await bridge.captureAnnotations(tabId)
      const bytes = Uint8Array.from(atob(screenshot.data), character => character.charCodeAt(0))
      file = new File([bytes], `browser-annotations-${Date.now()}.png`, { type: screenshot.mediaType })
    }
    const submission: BrowserAnnotationSubmission = {
      file,
      context: JSON.stringify({
        browser_selection: {
          tab_id: capture.tabId,
          url: capture.url,
          title: capture.title,
          viewport: capture.viewport,
          annotations: annotations.value,
        },
      }, null, 2),
    }
    const submitted = await props.submit(submission)
    if (submitted === false) return
    resetAnnotationSession()
    if (bridge && tabId) await bridge.clearAnnotations(tabId).catch(() => undefined)
    await nextTick(syncViewport)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    annotationSubmitting.value = false
    await nextTick(syncViewport)
  }
}

function handleAnnotationFocusout(event: FocusEvent): void {
  if (annotationLocked.value) return
  const container = event.currentTarget
  const next = event.relatedTarget
  if (container instanceof HTMLElement && next instanceof Node && container.contains(next)) return
  void commitPendingAnnotation()
}

function handleAnnotationKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return
  event.preventDefault()
  void sendAnnotations()
}

function handleVisibility(): void {
  scheduleExternalOverlayCheck()
  void syncViewport()
}

function detectExternalOverlay(): void {
  overlayCheckFrame = 0
  const browserRect = viewport.value?.getBoundingClientRect()
  if (!browserRect || browserRect.width <= 0 || browserRect.height <= 0) {
    externalOverlayOpen.value = false
    return
  }
  const hostDrawer = viewport.value?.closest('.n-drawer-container')
  externalOverlayOpen.value = [...document.querySelectorAll<HTMLElement>(EXTERNAL_OVERLAY_SELECTOR)].some(element => {
    if (element.closest('.browser-panel') || element.contains(viewport.value!)) return false
    const overlayDrawer = element.closest('.n-drawer-container')
    // The host drawer and its backdrop belong behind the native browser view.
    // A task conversation may also have an older drawer underneath this one.
    if (hostDrawer && overlayDrawer) {
      if (hostDrawer === overlayDrawer && element.classList.contains('n-drawer-mask')) return false
      const hostZIndex = Number(getComputedStyle(hostDrawer).zIndex)
      const overlayZIndex = Number(getComputedStyle(overlayDrawer).zIndex)
      if (Number.isFinite(hostZIndex) && Number.isFinite(overlayZIndex) && overlayZIndex < hostZIndex) return false
    }
    const style = window.getComputedStyle(element)
    // Entering overlays often start at opacity 0 or outside the viewport. They
    // still need to hide the native WebContentsView before their CSS transition
    // makes them visible, because renderer z-index cannot cover a native view.
    if (style.display === 'none' || style.visibility === 'hidden') return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
      && rect.right > browserRect.left && rect.left < browserRect.right
      && rect.bottom > browserRect.top && rect.top < browserRect.bottom
  })
}

function scheduleExternalOverlayCheck(): void {
  if (!overlayCheckFrame) overlayCheckFrame = window.requestAnimationFrame(detectExternalOverlay)
  for (const delay of OVERLAY_RECHECK_DELAYS) {
    if (overlayCheckTimers.has(delay)) continue
    const timer = window.setTimeout(() => {
      overlayCheckTimers.delete(delay)
      detectExternalOverlay()
    }, delay)
    overlayCheckTimers.set(delay, timer)
  }
}

onMounted(async () => {
  if (!bridge) return
  try {
    state.value = await bridge.getState()
    stopStateListener = bridge.onStateChange(applyState)
    stopAnnotationRequestListener = bridge.onAnnotationRequest(request => {
      if (state.value?.tabs.some(tab => tab.id === request.tabId)) annotate(request.mode, request.tabId)
    })
    resizeObserver = new ResizeObserver(() => { scheduleExternalOverlayCheck(); void syncViewport() })
    if (viewport.value) resizeObserver.observe(viewport.value)
    modalObserver = new MutationObserver(scheduleExternalOverlayCheck)
    modalObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'aria-hidden'], childList: true, subtree: true })
    detectExternalOverlay()
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('resize', handleVisibility)
    await nextTick(syncViewport)
  } catch (error) {
    loadError.value = `${t('browser.loadFailed')}: ${error instanceof Error ? error.message : String(error)}`
    message.error(loadError.value)
  }
})

onUnmounted(() => {
  unmounting = true
  if (bridge && annotatingTabId) void bridge.cancelAnnotation(annotatingTabId)
  if (bridge && annotationTabId.value) void bridge.clearAnnotations(annotationTabId.value)
  stopStateListener?.()
  stopAnnotationRequestListener?.()
  resizeObserver?.disconnect()
  modalObserver?.disconnect()
  if (overlayCheckFrame) window.cancelAnimationFrame(overlayCheckFrame)
  for (const timer of overlayCheckTimers.values()) window.clearTimeout(timer)
  overlayCheckTimers.clear()
  document.removeEventListener('visibilitychange', handleVisibility)
  window.removeEventListener('resize', handleVisibility)
  if (bridge) void bridge.setViewport({ x: 0, y: 0, width: 1, height: 1 }, false)
})
</script>

<template>
  <section class="browser-panel">
    <div v-if="!bridge" class="unavailable">{{ t('browser.desktopOnly') }}</div>
    <template v-else>
      <div class="tab-strip">
        <button v-for="tab in state?.tabs" :key="tab.id" class="tab" :class="{ active: tab.id === state?.activeTabId }" :disabled="hasAnnotationSession" @click="activateTab(tab.id)">
          <img v-if="tab.faviconUrl" :src="tab.faviconUrl" alt="" />
          <span>{{ tab.title || t('browser.newTab') }}</span>
          <i v-if="tab.agentControl !== 'idle'" :title="tab.agentAction">●</i>
          <b @click="closeTab(tab.id, $event)">×</b>
        </button>
        <button class="new-tab" :disabled="hasAnnotationSession" @click="createTab">+</button>
      </div>

      <div class="toolbar">
        <button
          type="button"
          :disabled="hasAnnotationSession || !activeTab?.canGoBack"
          :title="t('browser.back')"
          :aria-label="t('browser.back')"
          @click="navigationAction('back')"
        >
          <svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <button
          type="button"
          :disabled="hasAnnotationSession || !activeTab?.canGoForward"
          :title="t('browser.forward')"
          :aria-label="t('browser.forward')"
          @click="navigationAction('forward')"
        >
          <svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
        <button
          type="button"
          :disabled="hasAnnotationSession"
          :title="activeTab?.loading ? t('browser.stop') : t('browser.reload')"
          :aria-label="activeTab?.loading ? t('browser.stop') : t('browser.reload')"
          @click="navigationAction(activeTab?.loading ? 'stop' : 'reload')"
        >
          <svg v-if="activeTab?.loading" class="toolbar-icon toolbar-stop-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <rect x="7" y="7" width="10" height="10" rx="1" />
          </svg>
          <svg v-else class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M20 12a8 8 0 1 1-2.34-5.66L20 8" />
            <path d="M20 4v4h-4" />
          </svg>
        </button>
        <span v-if="remoteBrowserEnabled && remoteBrowserOwnerState !== 'active'" class="remote-control-action" role="status" data-testid="browser-relay-owner">{{ t(`browser.remoteOwner${remoteBrowserOwnerState[0].toUpperCase()}${remoteBrowserOwnerState.slice(1)}`) }}</span>
        <NInput v-model:value="address" size="small" :placeholder="t('browser.addressPlaceholder')" :disabled="busy || hasAnnotationSession" @keydown.enter="navigate" />
        <NSelect
          class="profile-switcher"
          size="small"
          :value="state?.activeProfileId"
          :options="profileOptions"
          :disabled="busy"
          :consistent-menu-width="false"
          :title="t('browser.currentProfile')"
          data-testid="browser-profile-switcher"
          @update:value="switchProfile"
        />
        <NPopover :show="downloadsOpen" trigger="click" placement="bottom-end" :width="380" @update:show="downloadsVisibility">
          <template #trigger>
            <button class="download-trigger" :title="t('browser.downloads')" :aria-label="t('browser.downloads')">
              <span aria-hidden="true">⇩</span>
              <b v-if="activeDownloadCount">{{ activeDownloadCount }}</b>
            </button>
          </template>
          <section class="download-popover" data-desktop-browser-overlay>
            <header><strong>{{ t('browser.recentDownloads') }}</strong><NButton quaternary circle size="small" :aria-label="t('common.close')" @click="downloadsOpen = false"><template #icon><BrowserDownloadIcon kind="close" /></template></NButton></header>
            <div class="recent-download-list">
              <div v-if="!activeProfileDownloads.length" class="download-empty">{{ t('common.noData') }}</div>
              <BrowserDownloadRow v-for="item in activeProfileDownloads" :key="item.id" :item="item" compact @state="applyState" />
            </div>
            <footer><NButton text type="primary" @click="fullDownloadHistory">{{ t('browser.fullDownloadHistory') }} <span aria-hidden="true">↗</span></NButton></footer>
          </section>
        </NPopover>
      </div>

      <div v-if="activeTab?.agentControl !== 'idle'" class="agent-banner">
        <span v-if="activeTab?.agentControl === 'waiting-for-user'">{{ t('browser.agentWaiting', { agent: activeTab?.agentLabel || t('browser.agent') }) }}</span>
        <span v-else>{{ t('browser.agentControlling', { agent: activeTab?.agentLabel || t('browser.agent') }) }} · {{ activeTab?.agentAction }}</span>
        <NButton size="tiny" @click="takeOver">{{ t('browser.takeOver') }}</NButton>
      </div>

      <div v-if="activeTab?.crashed" class="crash-banner">
        <span>{{ t('browser.tabCrashed') }}</span>
        <NButton size="tiny" @click="navigationAction('reload')">{{ t('browser.recoverTab') }}</NButton>
      </div>

      <div v-if="hasAnnotationSession" class="annotation-session-bar">
        <span>{{ t('browser.annotationCount', { count: annotationCount }) }}</span>
        <div>
          <NButton v-if="bridge?.removeAnnotation" size="tiny" :disabled="annotationLocked" @mousedown.prevent @click="undoAnnotation">{{ t('browser.undoAnnotation') }}</NButton>
          <NButton size="tiny" :disabled="annotationLocked" @mousedown.prevent @click="clearAnnotationSession">{{ t('browser.clearAnnotations') }}</NButton>
          <NButton size="tiny" type="primary" :disabled="annotationLocked" :loading="annotationSubmitting" @mousedown.prevent @click="sendAnnotations">{{ t('chat.send') }}</NButton>
        </div>
      </div>

      <div v-if="hasAnnotationSession && bridge?.removeAnnotation" class="annotation-list">
        <span v-for="item in annotationItems" :key="item.marker" class="annotation-item" :title="item.note" :data-annotation-marker="item.marker">
          <span>{{ t('browser.annotationLabel', { index: item.marker }) }}<template v-if="item.note"> · {{ item.note }}</template></span>
          <button :disabled="annotationLocked" :aria-label="t('browser.deleteAnnotation', { index: item.marker })" :title="t('browser.deleteAnnotation', { index: item.marker })" @mousedown.prevent @click="removeAnnotation(item.marker)">×</button>
        </span>
      </div>

      <div v-if="pendingAnnotation" class="annotation-editor">
        <div class="annotation-preview" :style="annotationAnchorStyle">
          <img :src="annotationCapture?.previewUrl" alt="" />
          <div class="annotation-popover" :class="{ above: annotationAbove }" @focusout="handleAnnotationFocusout">
            <strong>{{ t('browser.annotationLabel', { index: pendingAnnotation.marker }) }} · {{ t(pendingAnnotation.mode === 'element' ? 'browser.selectElement' : 'browser.selectRegion') }}</strong>
            <NInput
              v-model:value="annotationNote"
              class="annotation-note-input"
              type="textarea"
              :rows="3"
              autofocus
              :placeholder="t('browser.annotationPlaceholder')"
              @keydown="handleAnnotationKeydown"
            />
            <div class="annotation-actions">
              <NButton v-if="bridge?.removeAnnotation" size="small" :disabled="annotationLocked" @mousedown.prevent @click="removeAnnotation(pendingAnnotation.marker)">{{ t('browser.deleteAnnotation', { index: pendingAnnotation.marker }) }}</NButton>
              <NButton v-else size="small" :disabled="annotationLocked" @mousedown.prevent @click="clearAnnotationSession">{{ t('browser.clearAnnotations') }}</NButton>
              <NButton size="small" type="primary" :disabled="annotationLocked" @mousedown.prevent @click="commitPendingAnnotation()">{{ t('browser.finishAnnotation') }}</NButton>
            </div>
          </div>
        </div>
      </div>

      <section v-if="historyOpen" class="panel-download-history" data-desktop-browser-overlay>
        <header><strong>{{ t('browser.downloads') }}</strong><NButton quaternary circle size="small" :aria-label="t('common.close')" @click="historyOpen = false"><template #icon><BrowserDownloadIcon kind="close" /></template></NButton></header>
        <BrowserDownloadHistory :items="historyDownloads" @state="applyState" />
      </section>
      <div v-show="!pendingAnnotation && !historyOpen" ref="viewport" class="native-viewport">
        <span v-if="loadError">{{ loadError }}</span>
        <NSpin v-else-if="!state" :description="t('common.loading')" />
      </div>
    </template>
  </section>
</template>

<style scoped lang="scss">
.panel-download-history { flex: 1; min-height: 0; overflow: auto; padding: 16px; }
.panel-download-history > header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.browser-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--text-primary, #1a1a1a); }
.tab-strip { height: 38px; flex: 0 0 38px; display: flex; align-items: flex-end; gap: calc(2px * var(--spacing-scale, 1)); padding: 4px 8px 0; overflow-x: auto; background: rgba(127,127,127,.06); }
.tab { width: 190px; min-width: 100px; height: 34px; border: 0; border-radius: 8px 8px 0 0; background: transparent; color: inherit; display: flex; align-items: center; gap: calc(7px * var(--spacing-scale, 1)); padding: 0 9px; cursor: pointer; }
.tab.active { color: var(--text-primary, #1a1a1a); background: var(--bg-card, #fff); box-shadow: inset 0 0 0 1px var(--border-color, #e0e0e0); }
.tab img { width: 16px; height: 16px; }.tab span { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: start; }.tab i { color: #3b82f6; font-size: calc(var(--font-size-base, 14px) * 9 / 14); }.tab b { font: 18px/1 sans-serif; font-weight: 400; }
.new-tab, .toolbar > button, .download-trigger { border: 0; background: transparent; color: inherit; cursor: pointer; border-radius: var(--radius-component, 6px); }.new-tab { width: 34px; height: 34px; font-size: calc(var(--font-size-base, 14px) * 20 / 14); }.toolbar > button, .download-trigger { width: 30px; height: 30px; font-size: calc(var(--font-size-base, 14px) * 18 / 14); }.toolbar > button { display: inline-grid; place-items: center; padding: 0; }.toolbar > button:hover, .download-trigger:hover, .new-tab:hover { background: rgba(127,127,127,.15); }.toolbar > button:disabled { opacity: .35; }
.toolbar { height: 46px; flex: 0 0 46px; padding: calc(7px * var(--spacing-scale, 1)) calc(10px * var(--spacing-scale, 1)); border-bottom: var(--border-width, 1px) solid var(--border-color); display: flex; align-items: center; gap: calc(8px * var(--spacing-scale, 1)); }
.toolbar-icon { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.remote-control-action { flex: 0 0 auto; }
.toolbar-stop-icon { fill: currentColor; stroke: none; }
.profile-switcher { width: 136px; flex: 0 0 136px; }
.download-trigger { position: relative; flex: 0 0 30px; padding: 0; }
.download-trigger > b { position: absolute; top: -3px; right: -4px; min-width: 15px; height: 15px; padding: 0 calc(3px * var(--spacing-scale, 1)); border-radius: var(--radius-component, 8px); background: #ef4444; color: #fff; font: 10px/15px sans-serif; text-align: center; }
.download-popover { width: min(350px, calc(100vw - 48px)); color: var(--text-primary); }
.download-popover > header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 8px; font-size: 14px; }
.recent-download-list { max-height: min(380px, 60vh); overflow: auto; }
.recent-download-list :deep(.download-record) { border-top: var(--border-width, 1px) solid var(--border-color); }
.download-popover > footer { padding-top: 12px; border-top: var(--border-width, 1px) solid var(--border-color); }
.download-empty { padding: 24px 8px; text-align: center; color: var(--text-secondary); }

.download-empty { padding: calc(24px * var(--spacing-scale, 1)) calc(8px * var(--spacing-scale, 1)); text-align: center; }
.agent-banner, .crash-banner { min-height: 34px; display: flex; align-items: center; justify-content: space-between; padding: calc(4px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1)); font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.agent-banner { background: rgba(59,130,246,.12); color: #3b82f6; }.crash-banner { background: rgba(239,68,68,.12); color: #dc2626; }
.annotation-session-bar { min-height: 38px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: calc(8px * var(--spacing-scale, 1)); padding: 4px 10px; color: #2563eb; background: rgba(59,130,246,.1); font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.annotation-session-bar > div { display: flex; gap: calc(6px * var(--spacing-scale, 1)); }
.annotation-list { display: flex; flex-wrap: wrap; flex-shrink: 0; gap: calc(6px * var(--spacing-scale, 1)); max-height: 90px; overflow-y: auto; padding: calc(6px * var(--spacing-scale, 1)) calc(10px * var(--spacing-scale, 1)); border-bottom: var(--border-width, 1px) solid var(--border-color); }
.annotation-item { display: inline-flex; align-items: center; gap: calc(4px * var(--spacing-scale, 1)); max-width: 100%; padding-inline-start: calc(8px * var(--spacing-scale, 1)); border-radius: var(--radius-component, 6px); background: rgba(59,130,246,.1); color: inherit; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.annotation-item > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.annotation-item > button { flex-shrink: 0; width: 28px; height: 28px; border: 0; border-radius: var(--radius-component, 6px); color: inherit; background: transparent; cursor: pointer; font-size: calc(var(--font-size-base, 14px) * 18 / 14); }
.annotation-item > button:hover { background: rgba(59,130,246,.15); }
.annotation-item > button:disabled { cursor: default; opacity: .5; }
.native-viewport { flex: 1; min-height: 100px; position: relative; display: grid; place-items: center; background: var(--theme-content-bg, var(--bg-primary)); color: var(--text-muted); }
.annotation-editor { flex: 1; min-height: 0; overflow: auto; padding: calc(12px * var(--spacing-scale, 1)); background: var(--card-color, #fff); }
.annotation-preview { position: relative; width: 100%; margin-bottom: 168px; line-height: 0; }
.annotation-preview > img { display: block; width: 100%; height: auto; border: var(--border-width, 1px) solid var(--border-color); border-radius: var(--radius-component, 8px); background: #fff; box-sizing: border-box; }
.annotation-popover { position: absolute; z-index: 2; left: clamp(8px, var(--annotation-left), calc(100% - 328px)); top: calc(var(--annotation-bottom) + 32px); width: min(320px, calc(100% - 16px)); padding: calc(10px * var(--spacing-scale, 1)); display: flex; flex-direction: column; gap: calc(8px * var(--spacing-scale, 1)); line-height: normal; color: var(--text-primary); color-scheme: inherit; border: var(--border-width, 1px) solid rgba(var(--accent-primary-rgb), .45); border-radius: var(--radius-component, 10px); background: var(--theme-overlay-bg, var(--bg-card)); box-shadow: 0 8px 28px rgba(15,23,42,.22); box-sizing: border-box; }
.annotation-popover.above { top: auto; bottom: calc(100% - var(--annotation-top) + 8px); }
.annotation-popover > strong { color: var(--accent-primary); font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.annotation-popover :deep(.annotation-note-input.n-input) { --n-color: var(--theme-overlay-bg, var(--bg-card)) !important; --n-color-focus: var(--theme-overlay-bg, var(--bg-card)) !important; --n-text-color: var(--text-primary) !important; --n-placeholder-color: var(--text-muted) !important; --n-border: var(--border-width, 1px) solid var(--border-color) !important; --n-border-hover: 1px solid var(--accent-hover) !important; --n-border-focus: 1px solid var(--accent-primary) !important; --n-box-shadow-focus: 0 0 0 2px rgba(var(--accent-primary-rgb), .18) !important; }
.annotation-popover :deep(.annotation-note-input .n-input__textarea-el) { color: var(--text-primary) !important; caret-color: var(--accent-primary); }
.annotation-popover :deep(.annotation-note-input .n-input__textarea-el::placeholder) { color: var(--text-muted) !important; }
.annotation-actions { display: flex; justify-content: flex-end; gap: calc(8px * var(--spacing-scale, 1)); }
.unavailable { padding: calc(40px * var(--spacing-scale, 1)); text-align: center; color: var(--text-color-3); }
</style>
