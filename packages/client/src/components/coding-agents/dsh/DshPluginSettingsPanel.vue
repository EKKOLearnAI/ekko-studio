<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NSpin } from 'naive-ui'
import { openDshPluginUi, closeDshPluginUi } from '@/api/coding-agents/dsh'
import { useTheme } from '@/composables/useTheme'
import { getBaseUrlValue } from '@/api/client'
const { t } = useI18n()
const { isDark } = useTheme()
const src = ref('')
const frame = ref<HTMLIFrameElement>()
const loading = ref(true)
const failed = ref(false)
const failureDetail = ref('')
let id = '', sequence = 0, disposed = false
async function refresh() {
  const current = ++sequence
  loading.value = true; failed.value = false; failureDetail.value = ''
  try {
    const session = await openDshPluginUi()
    if (disposed || current !== sequence) { void closeDshPluginUi(session.id).catch(() => {}); return }
    const previous = id; id = session.id
    const url = new URL(session.path, getBaseUrlValue() || window.location.origin)
    url.searchParams.set('studioTheme', isDark.value ? 'dark' : 'light')
    src.value = url.href
    if (previous) void closeDshPluginUi(previous).catch(() => {})
  } catch (error) { if (current === sequence) {
    failed.value = true; loading.value = false
    failureDetail.value = error instanceof Error ? [Reflect.get(error, 'code'), error.message].filter(Boolean).join(': ') : ''
  } }
}
function syncTheme() {
  if (!src.value) return
  frame.value?.contentWindow?.postMessage({ type: 'studio-dsh-theme', theme: isDark.value ? 'dark' : 'light' }, new URL(src.value).origin)
}
watch(isDark, syncTheme)
function ready(event: MessageEvent) {
  if (!src.value || event.source !== frame.value?.contentWindow || event.origin !== new URL(src.value).origin) return
  if (event.data?.type === 'studio-dsh-ui-ready') { loading.value = false; syncTheme() }
  if (event.data?.type === 'studio-dsh-ui-expired') { failed.value = true; loading.value = false }
}
onMounted(() => { window.addEventListener('message', ready); void refresh() })
onUnmounted(() => { disposed = true; window.removeEventListener('message', ready); if (id) void closeDshPluginUi(id).catch(() => {}) })
defineExpose({ refresh })
</script>
<template>
  <div class="native-settings" data-testid="dsh-plugin-settings">
    <NSpin v-if="loading" class="loading" />
    <NAlert v-if="failed" type="error">{{ t('dshPlugins.settingsUnavailable') }}<div v-if="failureDetail">{{ failureDetail }}</div></NAlert>
    <iframe v-if="src" ref="frame" :src="src" :title="t('dshPlugins.configurationTab')" referrerpolicy="no-referrer" class="native-slot" @load="syncTheme" @error="failed = true; loading = false" />
  </div>
</template>
<style scoped>
.native-settings { position: relative; min-height: 360px; height: 100%; }
.native-slot { display: block; width: 100%; height: 100%; min-height: 480px; border: 0; }
.loading { position: absolute; inset-block-start: 12px; inset-inline-end: 12px; }
</style>
