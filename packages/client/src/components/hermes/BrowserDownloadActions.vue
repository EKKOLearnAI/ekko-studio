<script setup lang="ts">
import { ref } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import BrowserDownloadIcon from './BrowserDownloadIcon.vue'
import { desktopBridge, type DesktopBrowserDownload, type DesktopBrowserState } from '@/utils/desktop-bridge'

const props = defineProps<{ item: DesktopBrowserDownload; removable?: boolean }>()
const emit = defineEmits<{ state: [value: DesktopBrowserState] }>()
const { t } = useI18n()
const message = useMessage()
const busy = ref(false)
const bridge = desktopBridge()?.browser
const errorKeys: Record<string, string> = {
  BROWSER_DOWNLOAD_ACTIVE: 'downloadActive',
  BROWSER_DOWNLOAD_NOT_FOUND: 'downloadNotFound',
  BROWSER_DOWNLOAD_FILE_UNAVAILABLE: 'downloadFileUnavailable',
  BROWSER_DOWNLOAD_OPEN_FAILED: 'downloadOpenFailed',
}
async function act(action: 'open' | 'reveal' | 'remove') {
  if (busy.value || !bridge?.downloadAction) return
  busy.value = true
  try { emit('state', await bridge.downloadAction(props.item.id, action)) }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const key = Object.keys(errorKeys).find(key => detail.includes(key))
    message.error(t(`browser.${key ? errorKeys[key] : 'downloadActionFailed'}`))
    if (bridge.refreshDownloads) {
      try { emit('state', await bridge.refreshDownloads()) } catch { /* Retain the actionable error. */ }
    }
  } finally { busy.value = false }
}
</script>

<template>
  <div v-if="bridge?.downloadAction" class="download-actions" data-desktop-browser-overlay>
    <template v-if="item.state === 'completed' && item.savePath && item.fileAvailable !== false">
      <NButton quaternary circle size="small" :title="t('browser.revealDownload')" :aria-label="t('browser.revealDownload')" :disabled="busy" @click="act('reveal')"><template #icon><BrowserDownloadIcon kind="folder" /></template></NButton>
      <NButton quaternary circle size="small" :title="t('browser.openDownload')" :aria-label="t('browser.openDownload')" :disabled="busy" @click="act('open')"><template #icon><BrowserDownloadIcon kind="open" /></template></NButton>
    </template>
    <NButton v-if="removable && item.state !== 'progressing'" quaternary circle size="small" :title="t('browser.removeDownload')" :aria-label="t('browser.removeDownload')" :disabled="busy" @click="act('remove')"><template #icon><BrowserDownloadIcon kind="close" /></template></NButton>
  </div>
</template>

<style scoped lang="scss">
.download-actions { display: flex; align-items: center; flex-shrink: 0; gap: 2px; }
</style>
