<script setup lang="ts">
import { ref, computed } from 'vue'
import { NModal, NUpload, NButton, NInput, NRadioGroup, NRadio, useMessage } from 'naive-ui'
import type { UploadFileInfo } from 'naive-ui'
import { importSkill } from '@/api/hermes/skills'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  allowCategory?: boolean
  importHandler?: (files: File[], category?: string) => Promise<{ name?: string }>
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const { t } = useI18n()
const message = useMessage()

const showModal = ref(true)
const loading = ref(false)
const mode = ref<'zip' | 'folder'>('folder')
const zipFiles = ref<UploadFileInfo[]>([])
const folderFiles = ref<File[]>([])
const folderName = ref('')
const category = ref('')
const folderInputRef = ref<HTMLInputElement | null>(null)

const hasSelection = computed(() =>
  mode.value === 'zip' ? zipFiles.value.length > 0 : folderFiles.value.length > 0
)

function onModeChange() {
  zipFiles.value = []
  folderFiles.value = []
  folderName.value = ''
}

function beforeUpload({ file }: { file: UploadFileInfo }) {
  const name = file.name?.toLowerCase() || ''
  if (!name.endsWith('.zip')) {
    message.warning(t('skills.importInvalidFile'))
    return false
  }
  return true
}

function pickFolder() {
  folderInputRef.value?.click()
}

function onFolderSelected(e: Event) {
  const input = e.target as HTMLInputElement
  const fileList = input.files
  if (!fileList || fileList.length === 0) return
  const arr: File[] = []
  for (let i = 0; i < fileList.length; i++) arr.push(fileList[i])
  folderFiles.value = arr
  // Top-level dir name comes from webkitRelativePath of the first file
  const firstRel = (arr[0] as any).webkitRelativePath as string | undefined
  folderName.value = firstRel ? firstRel.split('/')[0] : ''
}

async function handleSave() {
  if (!hasSelection.value) {
    message.warning(t('skills.importNoSelection'))
    return
  }

  let files: File[] = []
  if (mode.value === 'zip') {
    for (const item of zipFiles.value) {
      if (item.file) files.push(item.file)
    }
  } else {
    files = folderFiles.value
  }
  if (files.length === 0) {
    message.error(t('skills.importFailed'))
    return
  }

  loading.value = true
  try {
    const res = await (props.importHandler || importSkill)(files, category.value.trim() || undefined)
    message.success(t('skills.importSuccess') + (res?.name ? `: ${res.name}` : ''))
    message.info(t('skills.reloadHint'), { duration: 6000 })
    emit('saved')
  } catch (err: any) {
    message.error(t('skills.importFailed') + `: ${err.message}`)
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
    :title="t('skills.importTitle')"
    :style="{ width: 'min(480px, calc(100vw - 32px))' }"
    :mask-closable="!loading"
    @after-leave="emit('close')"
  >
    <div class="form-row">
      <NRadioGroup v-model:value="mode" size="small" :disabled="loading" @update:value="onModeChange">
        <NRadio value="folder">{{ t('skills.importModeFolder') }}</NRadio>
        <NRadio value="zip">{{ t('skills.importModeZip') }}</NRadio>
      </NRadioGroup>
      <p class="hint">{{ mode === 'zip' ? t('skills.importHintZip') : t('skills.importHintFolder') }}</p>
    </div>

    <div v-if="allowCategory !== false" class="form-row">
      <label class="field-label">{{ t('skills.importTargetCategory') }}</label>
      <NInput
        v-model:value="category"
        size="small"
        :placeholder="t('skills.importTargetCategoryPlaceholder')"
        :disabled="loading"
      />
    </div>

    <div class="form-row">
      <NUpload
        v-if="mode === 'zip'"
        v-model:file-list="zipFiles"
        :max="1"
        accept=".zip"
        :default-upload="false"
        :disabled="loading"
        @before-upload="beforeUpload"
      >
        <NButton :disabled="loading">{{ t('skills.importSelectFile') }}</NButton>
      </NUpload>

      <div v-else class="folder-picker">
        <input
          ref="folderInputRef"
          type="file"
          webkitdirectory
          multiple
          style="display: none"
          @change="onFolderSelected"
        />
        <NButton :disabled="loading" @click="pickFolder">
          {{ t('skills.importSelectFolder') }}
        </NButton>
        <span v-if="folderName" class="folder-info">
          {{ folderName }} ({{ folderFiles.length }} {{ t('skills.importFileCount') }})
        </span>
      </div>
    </div>

    <template #footer>
      <div class="modal-footer">
        <NButton :disabled="loading" @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="loading" :disabled="!hasSelection" @click="handleSave">
          {{ t('common.confirm') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.form-row {
  margin-bottom: 14px;

  &:last-of-type {
    margin-bottom: 0;
  }
}

.field-label {
  display: block;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-secondary;
  margin-bottom: 4px;
}

.hint {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-muted;
  margin: 6px 0 0;
}

.folder-picker {
  display: flex;
  align-items: center;
  gap: calc(12px * var(--spacing-scale, 1));
  flex-wrap: wrap;
}

.folder-info {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-secondary;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: calc(8px * var(--spacing-scale, 1));
}
</style>
