<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NSelect, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  fetchTtsFallback,
  saveTtsFallback,
  type TtsFallbackSettings,
} from '@/api/studio/tts-settings'
import { isServerTtsProvider } from '@/api/studio/tts'
import type { VoiceApiConnection } from '@/types/voice-api'

const props = defineProps<{
  /** 已配置的 TTS provider 连接列表（用于候选） */
  connections: VoiceApiConnection[]
  /** 当前激活 provider（作为主 provider 展示，不进入备用列表） */
  activeProvider?: string
}>()

const { t } = useI18n()
const message = useMessage()

const enabled = ref(false)
const backups = ref<string[]>([])
const adding = ref<string | null>(null)
const saving = ref(false)
const loaded = ref(false)

// 候选 = 已配置 + 服务端已实现 + 非 custom + 非当前激活
const candidates = computed(() => {
  const seen = new Set<string>()
  const list: Array<{ label: string; value: string }> = []
  for (const conn of props.connections) {
    const p = conn.provider
    if (!p || seen.has(p)) continue
    seen.add(p)
    if (!isServerTtsProvider(p) || p === 'custom' || p === props.activeProvider) continue
    if (backups.value.includes(p)) continue
    list.push({ label: p, value: p })
  }
  return list
})

function move(index: number, delta: number) {
  const target = index + delta
  if (index < 0 || target < 0 || target >= backups.value.length) return
  const arr = [...backups.value]
  const [item] = arr.splice(index, 1)
  arr.splice(target, 0, item)
  backups.value = arr
}

function removeAt(index: number) {
  backups.value = backups.value.filter((_, i) => i !== index)
}

function addBackup(value: string) {
  if (!value || backups.value.includes(value)) {
    adding.value = null
    return
  }
  backups.value = [...backups.value, value]
  adding.value = null
}

async function load() {
  try {
    const cfg = await fetchTtsFallback()
    enabled.value = cfg.enabled
    backups.value = Array.isArray(cfg.providers) ? cfg.providers : []
  } catch {
    message.error(t('settings.voice.ttsFallbackLoadFailed'))
  } finally {
    loaded.value = true
  }
}

async function save() {
  saving.value = true
  try {
    const cfg: TtsFallbackSettings = { enabled: enabled.value, providers: backups.value }
    const saved = await saveTtsFallback(cfg)
    enabled.value = saved.enabled
    backups.value = saved.providers ?? []
    message.success(t('settings.voice.speechPreprocessingSaved'))
  } catch {
    message.error(t('settings.voice.ttsFallbackSaveFailed'))
  } finally {
    saving.value = false
  }
}

function reset() {
  enabled.value = false
  backups.value = []
  void save()
}

onMounted(load)
</script>

<template>
  <section class="settings-section tts-fallback-section" aria-labelledby="tts-fallback-title">
    <header class="section-header">
      <div class="section-copy">
        <h4 id="tts-fallback-title" class="section-title">{{ t('settings.voice.ttsFallbackTitle') }}</h4>
        <p class="section-desc">{{ t('settings.voice.ttsFallbackDescription') }}</p>
      </div>
      <NSwitch
        :value="enabled"
        :disabled="!loaded"
        data-testid="tts-fallback-enabled"
        @update:value="v => (enabled = v)"
      />
    </header>

    <p v-if="props.activeProvider" class="fallback-active-row">
      {{ t('settings.voice.ttsFallbackActiveProvider') }}
      <code class="fallback-provider-tag">{{ props.activeProvider }}</code>
    </p>

    <div v-if="enabled" class="fallback-body">
      <p class="section-hint">{{ t('settings.voice.ttsFallbackOrderHint') }}</p>

      <ol v-if="backups.length" class="fallback-list">
        <li v-for="(provider, index) in backups" :key="provider" class="fallback-row">
          <span class="fallback-order">{{ index + 1 }}</span>
          <code class="fallback-provider-tag">{{ provider }}</code>
          <span class="fallback-actions">
            <NButton size="tiny" quaternary :disabled="index === 0" @click="move(index, -1)">↑</NButton>
            <NButton size="tiny" quaternary :disabled="index === backups.length - 1" @click="move(index, 1)">↓</NButton>
            <NButton size="tiny" quaternary type="error" @click="removeAt(index)">✕</NButton>
          </span>
        </li>
      </ol>
      <p v-else class="fallback-empty">{{ t('settings.voice.ttsFallbackEmpty') }}</p>

      <div v-if="candidates.length" class="fallback-add">
        <NSelect
          size="small"
          :value="adding"
          :options="candidates"
          :placeholder="t('settings.voice.ttsFallbackAddPlaceholder')"
          style="width: 240px"
          @update:value="addBackup"
        />
      </div>

      <div class="fallback-save">
        <NButton size="small" type="primary" :loading="saving" @click="save">
          {{ t('settings.voice.ttsFallbackSave') }}
        </NButton>
        <NButton size="small" quaternary @click="reset">
          {{ t('settings.voice.ttsFallbackReset') }}
        </NButton>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tts-fallback-section .section-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.fallback-active-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--text-color-2, #666);
}

.fallback-provider-tag {
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(26, 108, 181, 0.1);
  color: var(--text-color-1, #1a1a1a);
  font-size: 12px;
}

.fallback-body {
  margin-top: 12px;
}

.section-hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-color-3, #999);
}

.fallback-list {
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
}

.fallback-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px dashed rgba(128, 128, 128, 0.2);
}

.fallback-order {
  min-width: 18px;
  font-size: 12px;
  color: var(--text-color-3, #999);
}

.fallback-actions {
  margin-left: auto;
  display: inline-flex;
  gap: 2px;
}

.fallback-empty {
  font-size: 12px;
  color: var(--text-color-3, #999);
}

.fallback-add {
  margin: 6px 0 10px;
}

.fallback-save {
  display: flex;
  gap: 8px;
}
</style>
