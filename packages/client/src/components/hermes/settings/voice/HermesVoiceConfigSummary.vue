<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NSelect, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchConfig, updateConfigSection } from '@/api/hermes/config'
import type { VoiceApiKind } from '@/types/voice-api'

const props = defineProps<{
  kind: VoiceApiKind
  studioAvailable?: boolean
}>()

const { t } = useI18n()
const message = useMessage()
const emit = defineEmits<{
  activateStudio: []
  nativeSelected: []
}>()
const loading = ref(false)
const section = ref<Record<string, unknown>>({})

const KNOWN_PROVIDERS: Record<VoiceApiKind, string[]> = {
  tts: [
    'edge',
    'elevenlabs',
    'openai',
    'gemini',
    'xai',
    'mistral',
    'minimax',
    'deepinfra',
    'neutts',
    'kittentts',
    'piper',
  ],
  stt: [
    'local',
    'local_command',
    'groq',
    'openai',
    'mistral',
    'xai',
    'elevenlabs',
    'deepinfra',
  ],
}

const activeProvider = computed(() => {
  const value = section.value.provider
  return typeof value === 'string' && value.trim() ? value.trim() : '-'
})

const configuredProviders = computed(() => {
  const configured = new Set<string>()
  const known = new Set(KNOWN_PROVIDERS[props.kind])

  for (const [key, value] of Object.entries(section.value)) {
    if (known.has(key) && (value === null || typeof value === 'object')) configured.add(key)
  }

  const customProviders = section.value.providers
  if (customProviders && typeof customProviders === 'object' && !Array.isArray(customProviders)) {
    for (const key of Object.keys(customProviders)) configured.add(key)
  }

  if (activeProvider.value !== '-') configured.add(activeProvider.value)
  return [...configured]
})
const nativeProviderOptions = computed(() => configuredProviders.value
  .filter(provider => provider !== 'hermes-studio')
  .map(provider => ({ label: providerLabel(provider), value: provider })))
const activeNativeProvider = computed(() =>
  activeProvider.value !== 'hermes-studio' && activeProvider.value !== '-'
    ? activeProvider.value
    : null,
)

function providerLabel(provider: string): string {
  return provider === 'hermes-studio'
    ? t('settings.voice.hermesStudioProvider')
    : provider
}

async function refresh() {
  loading.value = true
  try {
    const config = await fetchConfig([props.kind])
    const value = config[props.kind]
    section.value = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    section.value = {}
  } finally {
    loading.value = false
  }
}

async function selectNativeProvider(provider: string) {
  try {
    await updateConfigSection(props.kind, { provider })
    await refresh()
    emit('nativeSelected')
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('settings.voice.ttsSaveFailed'))
  }
}

onMounted(refresh)

defineExpose({ refresh })
</script>

<template>
  <section class="hermes-config-summary">
    <div class="summary-copy">
      <h5>{{ t('settings.voice.hermesConfigTitle') }}</h5>
      <p>{{ t('settings.voice.hermesConfigDescription') }}</p>
    </div>

    <dl class="summary-values" :aria-busy="loading">
        <div>
          <dt>{{ t('settings.voice.hermesActiveProvider') }}</dt>
          <dd>
            <NTag size="small" type="success" :bordered="false">
              {{ providerLabel(activeProvider) }}
            </NTag>
          </dd>
        </div>
        <div>
          <dt>{{ t('settings.voice.hermesConfiguredProviders') }}</dt>
          <dd class="provider-tags">
            <NTag
              v-for="provider in configuredProviders"
              :key="provider"
              size="small"
              :type="provider === activeProvider ? 'success' : 'default'"
              :bordered="false"
            >
              {{ providerLabel(provider) }}
            </NTag>
            <span v-if="configuredProviders.length === 0">-</span>
          </dd>
        </div>
    </dl>

    <div class="summary-actions">
      <NSelect
        v-if="nativeProviderOptions.length"
        :value="activeNativeProvider"
        :options="nativeProviderOptions"
        size="small"
        :placeholder="t('settings.voice.selectNativeProvider')"
        :aria-label="t('settings.voice.nativeProvider')"
        @update:value="selectNativeProvider"
      />
      <NButton
        v-if="studioAvailable && activeProvider !== 'hermes-studio'"
        size="small"
        secondary
        @click="emit('activateStudio')"
      >
        {{ t('settings.voice.useHermesStudioProvider') }}
      </NButton>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.hermes-config-summary {
  display: grid;
  gap: 12px;
  margin-bottom: 18px;
  padding: 14px 16px;
  border: 1px solid $border-color;
  border-radius: 10px;
  background: color-mix(in srgb, $bg-secondary 72%, transparent);
}

.summary-copy h5,
.summary-copy p,
.summary-values,
.summary-values dd {
  margin: 0;
}

.summary-copy h5 {
  font-size: 14px;
}

.summary-copy p,
.summary-values dt {
  color: $text-secondary;
  font-size: 12px;
}

.summary-copy p {
  margin-top: 3px;
  line-height: 1.5;
}

.summary-values {
  display: grid;
  gap: 10px;
}

.summary-values > div {
  display: grid;
  grid-template-columns: minmax(120px, 170px) 1fr;
  align-items: start;
  gap: 10px;
}

.provider-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.summary-actions {
  display: grid;
  grid-template-columns: minmax(180px, 320px) auto;
  gap: 8px;
  align-items: center;
}

@media (max-width: 640px) {
  .summary-values > div,
  .summary-actions {
    grid-template-columns: 1fr;
  }
}
</style>
