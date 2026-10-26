<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import BrowserDownloadActions from './BrowserDownloadActions.vue'
import BrowserDownloadIcon from './BrowserDownloadIcon.vue'
import { desktopBridge, type DesktopBrowserDownload, type DesktopBrowserState } from '@/utils/desktop-bridge'
const props = defineProps<{ item: DesktopBrowserDownload; compact?: boolean }>()
const emit = defineEmits<{ state: [value: DesktopBrowserState] }>()
const { t } = useI18n()
const message = useMessage()
const cancelling = ref(false)
const origin = computed(() => { try { return new URL(props.item.sourceUrl).origin } catch { return '' } })
const sourceLink = computed(() => /^https?:\/\//i.test(props.item.sourceUrl) ? props.item.sourceUrl : undefined)
const status = computed(() => props.item.fileAvailable === false && props.item.state === 'completed'
  ? t('browser.downloadUnavailable') : t(`browser.downloadState${props.item.state[0].toUpperCase()}${props.item.state.slice(1)}`))
function bytes(value: number) {
  const units = ['B', 'KB', 'MB', 'GB']; let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
  return `${Number(value.toFixed(1))} ${units[i]}`
}
async function cancel() {
  const bridge = desktopBridge()?.browser
  if (!bridge || cancelling.value) return
  cancelling.value = true
  try { emit('state', await bridge.cancelDownload(props.item.id)) }
  catch { message.error(t('browser.downloadActionFailed')) }
  finally { cancelling.value = false }
}
</script>
<template>
  <article class="download-record" :class="{ compact, unavailable: item.fileAvailable === false }">
    <BrowserDownloadIcon class="file-icon" />
    <div class="download-details">
      <strong class="download-name" :title="item.fileName">{{ item.fileName }}</strong>
      <div class="download-meta"><span>{{ status }}<template v-if="item.state === 'progressing' && item.totalBytes > 0"> · {{ Math.min(100, Math.max(0, Math.round(item.receivedBytes / item.totalBytes * 100))) }}%</template></span><span>{{ bytes(item.receivedBytes) }}<template v-if="item.state === 'progressing' && item.totalBytes > 0"> / {{ bytes(item.totalBytes) }}</template></span></div>
      <progress v-if="item.state === 'progressing' && item.totalBytes > 0" :value="item.receivedBytes" :max="item.totalBytes" :aria-label="t('browser.downloads')" />
      <progress v-else-if="item.state === 'progressing'" :aria-label="t('browser.downloads')" />
      <span v-if="!compact && origin" class="download-origin">{{ t('browser.downloadFrom', { origin }) }}</span>
    </div>
    <div class="record-actions">
      <NButton v-if="item.state === 'progressing'" size="small" quaternary :loading="cancelling" @click="cancel">{{ t('common.cancel') }}</NButton>
      <a v-if="!compact && sourceLink" :href="sourceLink" target="_blank" rel="noopener noreferrer" :title="t('browser.downloadSource')" :aria-label="t('browser.downloadSource')"><BrowserDownloadIcon kind="link" /></a>
      <BrowserDownloadActions :item="item" :removable="!compact" @state="emit('state', $event)" />
    </div>
  </article>
</template>
<style scoped lang="scss">
.download-record { display: flex; align-items: flex-start; gap: 18px; padding: 22px; min-width: 0; color: var(--text-primary); }
.file-icon { flex: 0 0 30px; width: 30px; height: 34px; color: var(--text-secondary); }
.download-details { flex: 1; min-width: 0; display: grid; gap: 7px; }
.download-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-size-base, 14px); font-weight: 500; }
.download-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--text-secondary); font-size: 12px; }
.download-origin { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); font-size: 12px; }
.record-actions { display: flex; flex-shrink: 0; align-items: center; gap: 4px; }
.record-actions a { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: var(--radius-component, 6px); color: var(--text-secondary); }
.record-actions a svg { width: 18px; height: 18px; }
.record-actions a:focus-visible { outline: 2px solid var(--primary-color); }
.unavailable .download-name { text-decoration: line-through; color: var(--text-secondary); }
progress { width: 100%; height: 4px; accent-color: var(--primary-color); }
.compact { gap: 12px; padding: 16px 0; }
.compact .file-icon { width: 24px; flex-basis: 24px; height: 28px; }
.compact .download-name { font-size: 13px; }
@media (max-width: 600px) { .download-record:not(.compact) { flex-wrap: wrap; padding: 16px; gap: 12px; } .download-record:not(.compact) .download-details { flex-basis: calc(100% - 50px); } .download-record:not(.compact) .record-actions { margin-inline-start: auto; } }
</style>
