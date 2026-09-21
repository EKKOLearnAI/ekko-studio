<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NInput, NSelect, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSpeech, type MimoTtsOptions, type OpenaiTtsOptions } from '@/composables/useSpeech'
import { usePcmStreamRecorder } from '@/composables/usePcmStreamRecorder'
import { transcribeSpeech } from '@/api/studio/stt'
import { isServerTtsProvider } from '@/api/studio/tts'
import { useVoiceApiConnections } from '@/composables/useVoiceApiConnections'
import { useVoiceSettings } from '@/composables/useVoiceSettings'
import { speedToEdgeRate, hzToEdgePitch } from '@/utils/ttsHelpers'
import VoiceApiCard, { type VoiceApiCardTestState } from './voice/VoiceApiCard.vue'
import VoiceApiFormModal from './voice/VoiceApiFormModal.vue'
import VoiceApiConfigurator from './voice/VoiceApiConfigurator.vue'
import HermesVoiceConfigSummary from './voice/HermesVoiceConfigSummary.vue'
import LocalSttModelCard from './voice/LocalSttModelCard.vue'
import type { VoiceApiConnection, VoiceApiKind, VoiceApiProvider, VoiceApiSavePayload } from '@/types/voice-api'
import type { StoredSttProvider } from '@/api/studio/stt-settings'

interface VoiceApiFormSavedPayload extends VoiceApiSavePayload {
  preset: {
    provider: VoiceApiProvider
  }
}

const props = withDefaults(defineProps<{
  kind?: VoiceApiKind | 'all'
}>(), {
  kind: 'all',
})

const { t } = useI18n()
const message = useMessage()
const speech = useSpeech()
const voiceApi = useVoiceApiConnections()
const voiceSettings = useVoiceSettings()

const testText = ref(t('settings.voice.testTextDefault'))
const showAddModal = ref(false)
const addModalKind = ref<VoiceApiKind>('tts')
const showConfigurator = ref(false)
const editingConnection = ref<VoiceApiConnection | null>(null)
const sttRecorder = usePcmStreamRecorder({ voiceActivityThreshold: 0.02 })
const cardTestStates = ref<Record<string, VoiceApiCardTestState>>({})
const hermesConfigRevision = ref(0)

const activeTtsDescription = computed(() => voiceApi.activeTtsConnection.value?.label || t('settings.voice.noneSelected'))
const activeSttDescription = computed(() => voiceApi.activeSttConnection.value?.label || t('settings.voice.noneSelected'))
const showTts = computed(() => props.kind !== 'stt')
const showStt = computed(() => props.kind !== 'tts')
const ttsStudioAvailable = computed(() => {
  const connection = voiceApi.activeTtsConnection.value
  return !!connection && (connection.isBuiltin || connection.hasSecret)
})
const sttStudioAvailable = computed(() => {
  const connection = voiceApi.activeSttConnection.value
  return !!connection && connection.provider !== 'browser' && (connection.provider === 'local' ? connection.available === true : connection.hasSecret)
})

onMounted(async () => {
  await voiceApi.refresh()
})

onBeforeUnmount(() => {
  sttRecorder.cancel()
})

function openAddModal(kind: VoiceApiKind) {
  addModalKind.value = kind
  showAddModal.value = true
}

function setCardTestState(id: string, status: VoiceApiCardTestState['status'], messageText?: string) {
  cardTestStates.value = {
    ...cardTestStates.value,
    [id]: { status, message: messageText },
  }
}

function clearOtherRecordingStates(id: string) {
  const next = { ...cardTestStates.value }
  for (const [key, value] of Object.entries(next)) {
    if (key !== id && value.status === 'recording') {
      next[key] = { status: 'idle' }
    }
  }
  cardTestStates.value = next
}

async function handleAddSaved(data: VoiceApiFormSavedPayload) {
  try {
    await voiceApi.saveConnection(addModalKind.value, data.preset.provider, {
      settings: data.settings,
      secrets: data.secrets,
    })
    hermesConfigRevision.value += 1
    showAddModal.value = false
    message.success(t('settings.voice.ttsSaved'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : t('settings.voice.ttsSaveFailed'))
  }
}

function openConfigurator(conn: VoiceApiConnection) {
  editingConnection.value = conn
  showConfigurator.value = true
}

async function handleConfigSave(conn: VoiceApiConnection, payload: VoiceApiSavePayload) {
  try {
    await voiceApi.saveConnection(conn.kind, conn.provider, payload)
    hermesConfigRevision.value += 1
    showConfigurator.value = false
    message.success(t('settings.voice.ttsSaved'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : t('settings.voice.ttsSaveFailed'))
  }
}

async function handleRemove(conn: VoiceApiConnection) {
  try {
    await voiceApi.deleteSecret(conn.kind, conn.provider)
    hermesConfigRevision.value += 1
    setCardTestState(conn.id, 'idle')
    message.success(t('settings.voice.ttsCleared'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : t('settings.voice.ttsClearFailed'))
  }
}

async function handleSetActive(conn: VoiceApiConnection) {
  await voiceApi.setActiveConnection(conn.kind, conn.id)
  hermesConfigRevision.value += 1
}

async function handleActiveTtsUpdate(id: string) {
  await voiceApi.setActiveConnection('tts', id)
  hermesConfigRevision.value += 1
}

async function handleActiveSttUpdate(id: string) {
  await voiceApi.setActiveConnection('stt', id)
  hermesConfigRevision.value += 1
}

async function handleActivateStudio(kind: VoiceApiKind) {
  const id = kind === 'tts' ? voiceApi.activeTtsId.value : voiceApi.activeSttId.value
  await voiceApi.setActiveConnection(kind, id)
  hermesConfigRevision.value += 1
}

function ttsOptionsFor(connection: VoiceApiConnection): Record<string, unknown> {
  return {
    ...connection.settings,
    baseUrl: connection.baseUrl || connection.settings.baseUrl,
    model: connection.model || connection.settings.model,
    voice: connection.voice || connection.settings.voice,
  }
}

function openaiOptionsFor(connection: VoiceApiConnection): OpenaiTtsOptions {
  const options = ttsOptionsFor(connection)
  const provider = connection.provider !== 'mimo' && isServerTtsProvider(connection.provider)
    ? connection.provider
    : undefined
  const edgeRate = Number(options.rate)
  const edgePitch = Number(options.pitch)
  return {
    baseUrl: String(options.baseUrl || ''),
    model: typeof options.model === 'string' ? options.model : undefined,
    voice: typeof options.voice === 'string' ? options.voice : undefined,
    rate: connection.provider === 'edge' && Number.isFinite(edgeRate)
      ? speedToEdgeRate(edgeRate)
      : typeof options.rate === 'string' ? options.rate : undefined,
    pitch: connection.provider === 'edge' && Number.isFinite(edgePitch)
      ? hzToEdgePitch(edgePitch)
      : typeof options.pitch === 'string' ? options.pitch : undefined,
    speed: typeof options.speed === 'string' || typeof options.speed === 'number' ? options.speed : undefined,
    stylePrompt: typeof options.stylePrompt === 'string' ? options.stylePrompt : undefined,
    provider,
  }
}

function mimoOptionsFor(connection: VoiceApiConnection): MimoTtsOptions {
  const options = ttsOptionsFor(connection)
  return {
    baseUrl: String(options.baseUrl || 'https://api.xiaomimimo.com/v1'),
    model: String(options.model || 'mimo-v2.5-tts'),
    voice: typeof options.voice === 'string' ? options.voice : undefined,
    authMode: options.authMode === 'api-key' || options.authMode === 'bearer' || options.authMode === 'both' ? options.authMode : undefined,
    voiceMode: options.voiceMode === 'preset' || options.voiceMode === 'voiceDesign' || options.voiceMode === 'voiceClone' ? options.voiceMode : undefined,
    voiceDesignDesc: typeof options.voiceDesignDesc === 'string' ? options.voiceDesignDesc : undefined,
    voiceCloneDataUri: typeof options.voiceCloneDataUri === 'string'
      ? options.voiceCloneDataUri
      : voiceSettings.mimoVoiceCloneDataUri.value || undefined,
    voiceCloneFormat: options.voiceCloneFormat === 'mp3' || options.voiceCloneFormat === 'wav'
      ? options.voiceCloneFormat
      : voiceSettings.mimoVoiceCloneFormat.value,
    stylePrompt: typeof options.stylePrompt === 'string' ? options.stylePrompt : undefined,
  }
}

async function handleTtsTest(connection: VoiceApiConnection) {
  const text = testText.value.trim()
  if (!text) {
    setCardTestState(connection.id, 'error', t('settings.voice.testTextRequired'))
    return
  }

  if (!connection.isBuiltin && !connection.hasSecret) {
    setCardTestState(connection.id, 'error', t('settings.voice.keyMissingForTest'))
    return
  }

  setCardTestState(connection.id, 'loading', t('settings.voice.testing'))
  try {
    if (connection.provider === 'mimo') {
      await speech.mimoPlay(connection.id, text, mimoOptionsFor(connection))
    } else if (isServerTtsProvider(connection.provider)) {
      await speech.openaiPlay(connection.id, text, openaiOptionsFor(connection))
    }
    setCardTestState(connection.id, 'success', t('settings.voice.testSuccess'))
  } catch (err) {
    setCardTestState(connection.id, 'error', t('settings.voice.testFailed', { error: err instanceof Error ? err.message : String(err) }))
  }
}

async function handleSttTest(connection: VoiceApiConnection) {
  if (connection.provider === 'browser') {
    setCardTestState(connection.id, 'success', t('settings.voice.browserSttTestHint'))
    return
  }

  if (connection.provider !== 'local' && !connection.hasSecret) {
    setCardTestState(connection.id, 'error', t('settings.voice.keyMissingForTest'))
    return
  }

  if (cardTestStates.value[connection.id]?.status === 'recording') {
    setCardTestState(connection.id, 'loading', t('settings.voice.transcribing'))
    try {
      const audio = await sttRecorder.stop()
      if (!audio?.size) {
        setCardTestState(connection.id, 'error', t('settings.voice.sttEmptyAudio'))
        return
      }

      const result = await transcribeSpeech({
        audio,
        provider: connection.provider as StoredSttProvider,
      })
      setCardTestState(connection.id, 'success', result.text || t('settings.voice.sttTestSuccess'))
    } catch (err) {
      setCardTestState(connection.id, 'error', t('settings.voice.sttTestFailed', { error: err instanceof Error ? err.message : String(err) }))
    }
    return
  }

  try {
    clearOtherRecordingStates(connection.id)
    await sttRecorder.start()
    setCardTestState(connection.id, 'recording', t('settings.voice.sttRecordingHint'))
  } catch (err) {
    console.error('[VoiceSettings] Failed to start STT card test recording:', err)
    setCardTestState(connection.id, 'error', t('settings.voice.sttTestFailed', { error: err instanceof Error ? err.message : String(err) }))
  }
}

async function handleCardTest(connection: VoiceApiConnection) {
  if (connection.kind === 'tts') {
    await handleTtsTest(connection)
    return
  }
  await handleSttTest(connection)
}

async function handleLocalSetActive() {
  try {
    await voiceApi.refresh()
    const connection = voiceApi.localSttConnection.value
    if (!connection?.available) {
      message.error(t('settings.voice.localSttModelUnavailable'))
      return
    }
    await handleSetActive(connection)
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('settings.voice.localSttModelUnavailable'))
  }
}

async function handleLocalTest() {
  const connection = voiceApi.localSttConnection.value
  if (connection?.available) await handleSttTest(connection)
}
</script>

<template>
  <div class="voice-settings">
    <section v-if="showTts" class="settings-section voice-provider-section" aria-labelledby="tts-providers-title">
      <HermesVoiceConfigSummary
        :key="`tts-${hermesConfigRevision}`"
        kind="tts"
        :studio-available="ttsStudioAvailable"
        @activate-studio="handleActivateStudio('tts')"
      />
      <header class="section-header">
        <div class="section-copy">
          <h4 id="tts-providers-title" class="section-title">{{ t('settings.voice.ttsProvidersTitle') }}</h4>
          <p class="section-desc">{{ t('settings.voice.ttsProvidersDescription') }}</p>
        </div>
        <div class="section-controls">
          <div class="active-select">
            <span class="active-label">{{ t('settings.voice.activeTtsApi') }}</span>
            <NSelect
              :value="voiceApi.activeTtsId.value"
              :options="voiceApi.ttsConnectionOptions.value"
              size="small"
              :aria-label="t('settings.voice.activeTtsApi')"
              @update:value="handleActiveTtsUpdate"
            />
            <span class="active-summary">{{ activeTtsDescription }}</span>
          </div>
          <NButton size="small" secondary @click="openAddModal('tts')">
            {{ t('settings.voice.addTtsApi') }}
          </NButton>
        </div>
      </header>

      <div class="test-copy-row">
        <NInput
          v-model:value="testText"
          size="small"
          :placeholder="t('settings.voice.testTextPlaceholder')"
          data-testid="tts-test-text"
        />
      </div>

      <div class="provider-list">
        <VoiceApiCard
          v-for="conn in voiceApi.ttsConnections.value"
          :key="conn.id"
          :connection="conn"
          :test-state="cardTestStates[conn.id]"
          @set-active="handleSetActive"
          @test="handleCardTest"
          @edit="openConfigurator"
          @connect="openConfigurator"
          @remove="handleRemove"
        />
      </div>
    </section>

    <section v-if="showStt" class="settings-section voice-provider-section" aria-labelledby="stt-providers-title">
      <HermesVoiceConfigSummary
        :key="`stt-${hermesConfigRevision}`"
        kind="stt"
        :studio-available="sttStudioAvailable"
        @activate-studio="handleActivateStudio('stt')"
      />
      <header class="section-header">
        <div class="section-copy">
          <h4 id="stt-providers-title" class="section-title">{{ t('settings.voice.sttProvidersTitle') }}</h4>
          <p class="section-desc">{{ t('settings.voice.sttProvidersDescription') }}</p>
        </div>
        <div class="section-controls">
          <div class="active-select">
            <span class="active-label">{{ t('settings.voice.activeSttApi') }}</span>
            <NSelect
              :value="voiceApi.activeSttId.value"
              :options="voiceApi.sttConnectionOptions.value"
              size="small"
              :aria-label="t('settings.voice.activeSttApi')"
              @update:value="handleActiveSttUpdate"
            />
            <span class="active-summary">{{ activeSttDescription }}</span>
          </div>
          <NButton size="small" secondary @click="openAddModal('stt')">
            {{ t('settings.voice.addSttApi') }}
          </NButton>
        </div>
      </header>

      <div class="provider-list">
        <LocalSttModelCard
          :active="voiceApi.activeSttId.value === 'stt-local'"
          :test-state="cardTestStates['stt-local']"
          @set-active="handleLocalSetActive"
          @test="handleLocalTest"
          @ready="voiceApi.refresh"
        />
        <VoiceApiCard
          v-for="conn in voiceApi.configurableSttConnections.value"
          :key="conn.id"
          :connection="conn"
          :test-state="cardTestStates[conn.id]"
          @set-active="handleSetActive"
          @test="handleCardTest"
          @edit="openConfigurator"
          @connect="openConfigurator"
          @remove="handleRemove"
        />
      </div>
    </section>

    <VoiceApiFormModal
      :show="showAddModal"
      :kind="addModalKind"
      @close="showAddModal = false"
      @saved="handleAddSaved"
    />

    <VoiceApiConfigurator
      :show="showConfigurator"
      :connection="editingConnection"
      @close="showConfigurator = false"
      @save="handleConfigSave"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.voice-settings {
  padding: 8px 0;
}

.settings-section {
  margin-top: 16px;
}

.voice-provider-section + .voice-provider-section {
  margin-top: 28px;
  padding-top: 20px;
  border-top: 1px solid $border-color;
}

.section-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 14px;
}

.section-copy {
  min-width: 0;
}

.section-title {
  margin: 0 0 6px;
  color: $text-primary;
  font-size: 15px;
  font-weight: 600;
}

.section-desc {
  margin: 0;
  max-width: 620px;
  color: $text-muted;
  font-size: 13px;
  line-height: 1.6;
}

.section-controls {
  display: grid;
  grid-template-columns: 220px 112px;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;

  > .n-button {
    width: 112px;
  }
}

.active-select {
  display: grid;
  gap: 5px;
  width: 220px;
  min-width: 0;
}

.active-label,
.active-summary {
  color: $text-muted;
  font-size: 11px;
  line-height: 1.3;
}

.active-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.test-copy-row {
  max-width: 460px;
  margin-bottom: 10px;
}

.provider-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

@media (max-width: 860px) {
  .section-header,
  .section-controls {
    grid-template-columns: 1fr;
    flex-direction: column;
    align-items: stretch;
  }

  .section-controls > .n-button,
  .active-select {
    width: 100%;
  }
}
</style>
