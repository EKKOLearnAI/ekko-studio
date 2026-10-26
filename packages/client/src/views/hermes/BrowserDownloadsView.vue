<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NSelect, useMessage } from 'naive-ui'
import PageHeader from '@/components/layout/PageHeader.vue'
import PageLoading from '@/components/common/PageLoading.vue'
import BrowserDownloadHistory from '@/components/hermes/BrowserDownloadHistory.vue'
import { desktopBridge, type DesktopBrowserState } from '@/utils/desktop-bridge'
const bridge = desktopBridge()?.browser
const route = useRoute()
const { t } = useI18n()
const message = useMessage()
const state = ref<DesktopBrowserState | null>(null)
const profileId = ref(typeof route.query.profile === 'string' ? route.query.profile : '')
const loading = ref(!!bridge)
let stop: (() => void) | undefined
let disposed = false
const items = computed(() => state.value?.downloads.filter(item => item.profileId === profileId.value) || [])
const profiles = computed(() => state.value?.profiles.map(item => ({ label: item.name, value: item.id })) || [])
function applyState(next: DesktopBrowserState) {
  if (disposed) return
  state.value = next
  if (!next.profiles.some(item => item.id === profileId.value)) profileId.value = next.activeProfileId
}
async function refresh() {
  if (!bridge?.refreshDownloads) return
  try { applyState(await bridge.refreshDownloads()) } catch { /* Existing records remain usable on older/disconnected Desktop. */ }
}
onMounted(async () => {
  if (!bridge) return
  try {
    stop = bridge.onStateChange(applyState)
    applyState(await bridge.getState())
    await refresh()
    window.addEventListener('focus', refresh)
  } catch { message.error(t('browser.loadFailed')) }
  finally { loading.value = false }
})
onUnmounted(() => { disposed = true; stop?.(); window.removeEventListener('focus', refresh) })
</script>
<template>
  <section class="browser-downloads-page">
    <PageHeader><header class="page-header"><h2>{{ t('browser.downloads') }}</h2></header></PageHeader>
    <p v-if="!bridge">{{ t('browser.desktopOnly') }}</p>
    <PageLoading v-else-if="loading" :show="loading" />
    <template v-else>
      <NSelect v-model:value="profileId" class="history-profile" :options="profiles" :aria-label="t('browser.profiles')" />
      <BrowserDownloadHistory :items="items" @state="applyState" />
    </template>
  </section>
</template>
<style scoped lang="scss">
.browser-downloads-page { padding: 24px; overflow: auto; min-height: 0; height: 100%; }
.page-header { display: flex; align-items: center; }
.page-header h2 { margin: 0; font-size: 18px; }
.history-profile { width: min(220px, 100%); margin-bottom: 24px; }
@media (max-width: 600px) { .browser-downloads-page { padding: 16px; } }
</style>
