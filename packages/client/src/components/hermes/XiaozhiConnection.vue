<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NTag } from 'naive-ui'
import { request } from '@/api/client'
import { copyToClipboard } from '@/utils/clipboard'
const { t } = useI18n()
const state = ref<{ configured: boolean; gatewayOnline: boolean; sessions: number; deviceId?: string; otaUrl?: string }>()
const stt = ref<{ configured: boolean; activeProvider: string | null }>()
const tts = ref(''), error = ref(false), loading = ref(false), copied = ref(false)
const capturing = ref(false), photoUrl = ref(''), photoError = ref('')
async function capturePhoto() {
  if (capturing.value) return
  capturing.value = true; photoError.value = ''
  try {
    const photo = await request<{ id: string; url: string }>('/api/studio/xiaozhi/camera/capture', { method: 'POST' })
    const image = await request<{ base64: string }>(`${photo.url}?format=json`)
    const bytes = Uint8Array.from(atob(image.base64), character => character.charCodeAt(0))
    if (photoUrl.value) URL.revokeObjectURL(photoUrl.value)
    photoUrl.value = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }))
  } catch { photoError.value = t('xiaozhiConnection.photoError') }
  finally { capturing.value = false }
}
let timer: ReturnType<typeof setInterval> | undefined
async function refresh() {
  if (loading.value) return
  loading.value = true
  try {
    const [device, speech, voice] = await Promise.all([
      request<NonNullable<typeof state.value>>('/api/studio/xiaozhi/status'),
      request<NonNullable<typeof stt.value>>('/api/studio/stt/profile-status').catch(() => undefined),
      request<{ activeProvider: string }>('/api/studio/tts/settings').catch(() => undefined),
    ])
    state.value = device; stt.value = speech; tts.value = voice?.activeProvider || ''; error.value = false
  } catch { error.value = true; state.value = undefined }
  finally { loading.value = false }
}
async function copy() { if (state.value?.otaUrl) copied.value = await copyToClipboard(state.value.otaUrl) }
onMounted(() => { void refresh(); timer = setInterval(refresh, 10000) })
onUnmounted(() => { clearInterval(timer); if (photoUrl.value) URL.revokeObjectURL(photoUrl.value) })
</script>
<template>
  <section class="connection" data-theme-surface="card">
    <header><h2>{{ t('xiaozhiConnection.title') }}</h2><NButton :loading="loading" @click="refresh">{{ t('xiaozhiConnection.refresh') }}</NButton></header>
    <p v-if="error" role="alert">{{ t('xiaozhiConnection.error') }}</p>
    <template v-else-if="state">
      <NTag :type="state.sessions > 0 ? 'success' : 'warning'">{{ t(state.sessions > 0 ? 'xiaozhiConnection.connected' : 'xiaozhiConnection.offline') }}</NTag> {{ state.deviceId }}
      <dl><div><dt>{{ t('xiaozhiConnection.gateway') }}</dt><dd>{{ t(state.gatewayOnline ? 'xiaozhiConnection.online' : 'xiaozhiConnection.offline') }}</dd></div><div><dt>STT / ASR</dt><dd>{{ stt?.configured ? stt.activeProvider : t('xiaozhiConnection.unconfigured') }}</dd></div><div><dt>TTS</dt><dd>{{ tts || t('xiaozhiConnection.unconfigured') }}</dd></div></dl>
      <template v-if="state.otaUrl"><p>{{ t('xiaozhiConnection.setup') }}</p><code>{{ state.otaUrl }}</code><NButton size="small" @click="copy">{{ t(copied ? 'xiaozhiConnection.copied' : 'xiaozhiConnection.copy') }}</NButton></template>
      <div class="camera"><NButton :loading="capturing" :disabled="!state.gatewayOnline || state.sessions < 1" @click="capturePhoto">{{ t('xiaozhiConnection.takePhoto') }}</NButton><p>{{ t('xiaozhiConnection.photoHint') }}</p><p v-if="photoError" role="alert">{{ photoError }}</p><img v-if="photoUrl" :src="photoUrl" :alt="t('xiaozhiConnection.photoAlt')" /><a v-if="photoUrl" :href="photoUrl" download="xiaozhi-photo.jpg">{{ t('xiaozhiConnection.downloadPhoto') }}</a></div>
      <RouterLink :to="{ name: 'hermes.settings' }">{{ t('xiaozhiConnection.voiceSettings') }}</RouterLink>
    </template>
  </section>
</template>
<style scoped>
.connection{padding:24px;border:1px solid var(--border-color,rgba(var(--text-primary-rgb), 0.267));border-radius:16px;margin-bottom:24px;background:var(--bg-secondary,rgba(var(--text-primary-rgb), 0.067))}header{display:flex;justify-content:space-between;gap:16px}h2{font-size:20px;margin:0}p{opacity:.75;line-height:1.6}dl{display:flex;gap:40px;flex-wrap:wrap}dt{opacity:.65;font-size:12px}dd{margin:6px 0}code{display:block;overflow-wrap:anywhere;padding:12px;margin-bottom:8px;background:rgba(var(--text-primary-rgb), 0.067);border-radius:8px}a{display:block;margin-top:16px}
.camera{margin-top:20px}.camera img{display:block;width:100%;max-width:640px;border-radius:12px}
</style>
