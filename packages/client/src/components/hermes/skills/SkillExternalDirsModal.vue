<script setup lang="ts">
import { NSpin, NModal, NButton, NInput, useMessage } from 'naive-ui'
import { ref, onMounted } from 'vue'

import { useI18n } from 'vue-i18n'
import { fetchExternalDirs, saveExternalDirs, type ExternalDirEntry } from '@/api/hermes/skills'

const props = defineProps<{
  fetchHandler?: () => Promise<ExternalDirEntry[]>
  saveHandler?: (directories: string[]) => Promise<void>
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const { t } = useI18n()
const message = useMessage()

interface Row {
  raw: string
  /** Hint flag from the initial fetch — cleared once the user edits the row. */
  hint: 'missing' | 'notdir' | null
}

const showModal = ref(true)
const loading = ref(false)
const initializing = ref(true)
const rows = ref<Row[]>([])

function entryToRow(entry: ExternalDirEntry): Row {
  if (!entry.exists) return { raw: entry.raw, hint: 'missing' }
  if (!entry.isDir) return { raw: entry.raw, hint: 'notdir' }
  return { raw: entry.raw, hint: null }
}

onMounted(async () => {
  try {
    const entries = await (props.fetchHandler || fetchExternalDirs)()
    rows.value = entries.map(entryToRow)
  } catch (err: any) {
    message.error(t('skills.externalDirs.loadFailed') + `: ${err.message}`)
  } finally {
    initializing.value = false
  }
})

function addRow() {
  rows.value.push({ raw: '', hint: null })
}

function removeRow(idx: number) {
  rows.value.splice(idx, 1)
}

function onRowEdit(idx: number) {
  // The pre-existing existence hint no longer applies once the path is edited.
  // We don't re-validate live — server is the source of truth on next Save.
  if (rows.value[idx]) rows.value[idx].hint = null
}

async function handleSave() {
  // Trim, drop empties, dedupe — same shape the server enforces.
  const cleaned: string[] = []
  const seen = new Set<string>()
  for (const row of rows.value) {
    const v = row.raw.trim()
    if (!v) continue
    if (seen.has(v)) continue
    seen.add(v)
    cleaned.push(v)
  }

  loading.value = true
  try {
    await (props.saveHandler || saveExternalDirs)(cleaned)
    message.success(t('skills.externalDirs.saveSuccess'))
    emit('saved')
  } catch (err: any) {
    message.error(t('skills.externalDirs.saveFailed') + `: ${err.message}`)
  } finally {
    loading.value = false
  }
}

function handleClose() {
  if (loading.value) return
  showModal.value = false
  setTimeout(() => emit('close'), 200)
}
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="t('skills.externalDirs.title')"
    :style="{ width: 'min(560px, calc(100vw - 32px))' }"
    :mask-closable="!loading"
    @after-leave="emit('close')"
  >
    <p class="hint">{{ t('skills.externalDirs.hint') }}</p>

    <div v-if="initializing" class="state-row"><NSpin :description="t('common.loading')" /></div>
    <div v-else-if="rows.length === 0" class="state-row empty">{{ t('skills.externalDirs.empty') }}</div>

    <ul v-else class="dir-list">
      <li v-for="(row, idx) in rows" :key="idx" class="dir-row">
        <div class="dir-input-wrap">
          <NInput
            v-model:value="row.raw"
            size="small"
            :placeholder="t('skills.externalDirs.placeholder')"
            :disabled="loading"
            @update:value="onRowEdit(idx)"
          />
          <span v-if="row.hint === 'missing'" class="hint-tag broken">
            {{ t('skills.externalDirs.missing') }}
          </span>
          <span v-else-if="row.hint === 'notdir'" class="hint-tag broken">
            {{ t('skills.externalDirs.notDir') }}
          </span>
        </div>
        <button class="row-remove" :title="t('skills.externalDirs.removeRow')" :disabled="loading"
          @click="removeRow(idx)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </li>
    </ul>

    <NButton size="small" :disabled="loading" @click="addRow">
      <template #icon>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </template>
      {{ t('skills.externalDirs.add') }}
    </NButton>

    <template #footer>
      <div class="modal-footer">
        <NButton :disabled="loading" @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="loading" :disabled="initializing" @click="handleSave">
          {{ t('common.save') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.hint {
  font-size: 12px;
  color: $text-muted;
  margin: 0 0 12px;
  line-height: 1.5;
}

.state-row {
  font-size: 13px;
  color: $text-muted;
  padding: 12px 4px;

  &.empty {
    text-align: center;
    border: 1px dashed $border-color;
    border-radius: $radius-sm;
  }
}

.dir-list {
  list-style: none;
  padding: 0;
  margin: 0 0 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dir-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dir-input-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.hint-tag {
  flex-shrink: 0;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 8px;

  &.broken {
    color: #b45309;
    background: rgba(245, 158, 11, 0.12);
  }
}

.row-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: $text-muted;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: background $transition-fast, color $transition-fast;

  &:hover:not(:disabled) {
    background: rgba(220, 38, 38, 0.12);
    color: #dc2626;
  }

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
