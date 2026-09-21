<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NButton, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  fetchFallbackProviders,
  saveFallbackProviders,
  type FallbackProviderEntry,
} from '@/api/hermes/config'
import { useAppStore } from '@/stores/hermes/app'
import { useModelsStore } from '@/stores/hermes/models'
import { useProfilesStore } from '@/stores/hermes/profiles'
import ModelPickerModal from './ModelPickerModal.vue'

const { t } = useI18n()
const message = useMessage()
const appStore = useAppStore()
const modelsStore = useModelsStore()
const profilesStore = useProfilesStore()

const loading = ref(false)
const saving = ref(false)
const chain = ref<FallbackProviderEntry[]>([])
const savedChain = ref('')
const showPicker = ref(false)
const draggingIndex = ref<number | null>(null)
const rowRefs = ref<(HTMLElement | null)[]>([])

const dirty = computed(() => JSON.stringify(chain.value) !== savedChain.value)

function providerLabel(provider: string): string {
  return modelsStore.providers.find(group => group.provider === provider)?.label || provider
}

function isChosen(provider: string, model: string): boolean {
  return chain.value.some(entry => entry.provider === provider && entry.model === model)
}

async function load() {
  loading.value = true
  try {
    const response = await fetchFallbackProviders()
    chain.value = Array.isArray(response.fallback_providers) ? [...response.fallback_providers] : []
    savedChain.value = JSON.stringify(chain.value)
  } catch (error: any) {
    message.error(error?.message || t('models.fallbackLoadFailed'))
  } finally {
    loading.value = false
  }
}

function addEntry({ provider, model }: FallbackProviderEntry) {
  if (isChosen(provider, model)) return
  chain.value = [...chain.value, { provider, model }]
}

function removeEntry(index: number) {
  chain.value = chain.value.filter((_, i) => i !== index)
}

function moveEntry(from: number, to: number) {
  if (from === to || to < 0 || to >= chain.value.length) return
  const next = [...chain.value]
  const [entry] = next.splice(from, 1)
  next.splice(to, 0, entry)
  chain.value = next
}

function handleDragStart(index: number, event: DragEvent) {
  draggingIndex.value = index
  if (!event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'move'
  // Firefox refuses to start a drag without payload, and the index alone is
  // enough: the reorder happens against local state, not the dropped data.
  event.dataTransfer.setData('text/plain', String(index))
}

function handleDragEnter(index: number) {
  const from = draggingIndex.value
  if (from === null || from === index) return
  // Reorder as the row passes rather than on release, so the list under the
  // cursor is always what dropping would commit.
  moveEntry(from, index)
  draggingIndex.value = index
}

function handleDragEnd() {
  draggingIndex.value = null
}

/**
 * Dragging is the only pointer affordance, so the keyboard needs its own way
 * in: Alt with an arrow key moves the focused entry without adding buttons.
 */
function handleRowKeydown(index: number, event: KeyboardEvent) {
  if (!event.altKey) return
  const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
  if (!delta) return
  event.preventDefault()
  const target = index + delta
  if (target < 0 || target >= chain.value.length) return
  moveEntry(index, target)
  const rows = rowRefs.value.filter(Boolean)
  rows[target]?.focus()
}

async function save() {
  saving.value = true
  try {
    const response = await saveFallbackProviders(chain.value)
    chain.value = [...response.fallback_providers]
    savedChain.value = JSON.stringify(chain.value)
    message.success(t('models.fallbackSaved'))
  } catch (error: any) {
    message.error(error?.message || t('models.fallbackSaveFailed'))
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void load()
})

watch(() => profilesStore.activeProfileName, () => {
  void load()
})
</script>

<template>
  <section class="fallback-panel">
    <div class="fallback-header">
      <div>
        <h3>{{ t('models.fallbackTitle') }}</h3>
        <p>{{ t('models.fallbackSubtitle') }}</p>
      </div>
      <div class="fallback-header-actions">
        <NButton size="small" @click="showPicker = true">{{ t('models.fallbackAdd') }}</NButton>
        <NButton size="small" type="primary" :disabled="!dirty" :loading="saving" @click="save">
          {{ t('common.save') }}
        </NButton>
      </div>
    </div>

    <NSpin :show="loading">
      <ol v-if="chain.length > 0" class="fallback-list">
        <li
          v-for="(entry, index) in chain"
          :key="`${entry.provider}:${entry.model}`"
          :ref="el => { rowRefs[index] = el as HTMLElement | null }"
          class="fallback-row"
          :class="{ dragging: draggingIndex === index }"
          draggable="true"
          tabindex="0"
          :aria-label="t('models.fallbackRowAria', { position: index + 1, total: chain.length })"
          @dragstart="handleDragStart(index, $event)"
          @dragenter="handleDragEnter(index)"
          @dragover.prevent
          @dragend="handleDragEnd"
          @drop.prevent="handleDragEnd"
          @keydown="handleRowKeydown(index, $event)"
        >
          <span class="fallback-grip" aria-hidden="true">⠿</span>
          <span class="fallback-order">{{ index + 1 }}</span>
          <span class="fallback-model" dir="auto">
            <strong>{{ appStore.displayModelName(entry.model, entry.provider) }}</strong>
            <small>{{ providerLabel(entry.provider) }}</small>
          </span>
          <NButton size="tiny" quaternary type="error" @click="removeEntry(index)">✕</NButton>
        </li>
      </ol>
      <p v-else-if="!loading" class="fallback-empty">{{ t('models.fallbackEmpty') }}</p>
    </NSpin>

    <p v-if="chain.length > 1" class="fallback-note">{{ t('models.fallbackReorderHint') }}</p>
    <p class="fallback-note">{{ t('models.fallbackAppliesToNewSessions') }}</p>

    <ModelPickerModal
      v-model:show="showPicker"
      :title="t('models.fallbackAdd')"
      :groups="modelsStore.providers"
      :selected="chain"
      :close-on-select="false"
      disable-selected
      @select="addEntry"
    />
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.fallback-panel {
  padding: 4px 0;
}

.fallback-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;

  h3 {
    margin: 0 0 4px;
    font-size: 15px;
    color: $text-primary;
  }

  p {
    margin: 0;
    font-size: 12px;
    color: $text-secondary;
  }
}

.fallback-header-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.fallback-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.fallback-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: $bg-secondary;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  cursor: grab;

  &:focus-visible {
    outline: 2px solid $accent-muted;
    outline-offset: 1px;
  }

  &.dragging {
    opacity: 0.5;
    cursor: grabbing;
  }
}

.fallback-order {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: $bg-input;
  color: $text-secondary;
  font-size: 11px;
}

.fallback-model {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;

  strong {
    font-size: 13px;
    font-weight: 500;
    color: $text-primary;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  small {
    font-size: 11px;
    color: $text-muted;
  }
}

.fallback-grip {
  flex-shrink: 0;
  color: $text-muted;
  font-size: 14px;
  line-height: 1;
  cursor: grab;
  user-select: none;
}

.fallback-empty {
  margin: 12px 0;
  font-size: 12px;
  color: $text-muted;
}

.fallback-note {
  margin: 14px 0 0;
  font-size: 11px;
  color: $text-muted;
}

</style>
