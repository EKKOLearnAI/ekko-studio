<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { NModal, NInput, NButton, NSpace, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import type { FileEntry } from '@/api/studio/files'

const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()

const props = defineProps<{
  show: boolean
  mode: 'newFile' | 'newFolder' | 'rename'
  entry?: FileEntry | null
  targetPath?: string | null
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
}>()

const inputValue = ref('')
const submitting = ref(false)

watch(() => props.show, (val) => {
  if (val) {
    if (props.mode === 'rename' && props.entry) {
      inputValue.value = props.entry.name
    } else {
      inputValue.value = ''
    }
  }
})

const title = computed(() => {
  switch (props.mode) {
    case 'newFile': return t('files.newFile')
    case 'newFolder': return t('files.newFolder')
    case 'rename': return t('files.rename')
  }
})

const placeholder = computed(() => {
  switch (props.mode) {
    case 'newFile': return t('files.newFileName')
    case 'newFolder': return t('files.newFolderName')
    case 'rename': return t('files.renameTo')
  }
})

async function handleSubmit() {
  if (!inputValue.value.trim()) return
  submitting.value = true
  try {
    switch (props.mode) {
      case 'newFile':
        await filesStore.createFile(inputValue.value.trim())
        message.success(t('files.created'))
        break
      case 'newFolder':
        await filesStore.createDir(inputValue.value.trim(), props.targetPath || undefined)
        message.success(t('files.created'))
        break
      case 'rename':
        if (props.entry) {
          await filesStore.renameEntry(props.entry, inputValue.value.trim())
          message.success(t('files.renamed'))
        }
        break
    }
    emit('update:show', false)
  } catch (err: any) {
    const msg = props.mode === 'rename' ? t('files.renameFailed') : t('files.createFailed')
    message.error(err.message || msg)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <NModal :show="props.show" preset="dialog" :title="title" @update:show="emit('update:show', false)" style="width: 400px;">
    <NInput
      v-model:value="inputValue"
      :placeholder="placeholder"
      @keydown.enter="handleSubmit"
      autofocus
    />
    <template #action>
      <NSpace>
        <NButton @click="emit('update:show', false)">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="submitting" :disabled="!inputValue.trim()" @click="handleSubmit">
          {{ t('common.ok') }}
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>
