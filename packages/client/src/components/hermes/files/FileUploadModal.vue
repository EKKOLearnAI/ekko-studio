<script setup lang="ts">
import { ref } from 'vue'
import { NModal, NButton, NUpload, NSpace, useMessage } from 'naive-ui'
import type { UploadFileInfo } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'

const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const uploading = ref(false)
const fileList = ref<File[]>([])

function handleFileChange(data: { file: UploadFileInfo; fileList: UploadFileInfo[] }) {
  fileList.value = data.fileList
    .map((f: UploadFileInfo) => f.file)
    .filter((f): f is File => f != null)
}

async function handleUpload() {
  if (fileList.value.length === 0) return
  uploading.value = true
  try {
    await filesStore.uploadFiles(fileList.value)
    message.success(t('files.uploadSuccess', { count: fileList.value.length }))
    fileList.value = []
    emit('update:show', false)
  } catch (err: any) {
    message.error(err.message || t('files.uploadFailed'))
  } finally {
    uploading.value = false
  }
}

function handleClose() {
  fileList.value = []
  emit('update:show', false)
}
</script>

<template>
  <NModal :show="props.show" preset="dialog" :title="t('files.upload')" @update:show="handleClose" style="width: 500px;">
    <NUpload
      multiple
      directory-dnd
      :default-upload="false"
      @change="handleFileChange"
    >
      <div class="upload-dragger">
        <p>{{ t('files.dragDropHint') }}</p>
      </div>
    </NUpload>
    <template #action>
      <NSpace>
        <NButton @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="uploading" :disabled="fileList.length === 0" @click="handleUpload">
          {{ t('files.upload') }} ({{ fileList.length }})
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.upload-dragger {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: calc(40px * var(--spacing-scale, 1)) calc(20px * var(--spacing-scale, 1));
  text-align: center;
  cursor: pointer;
}

.upload-dragger p {
  margin-top: 12px;
  opacity: 0.6;
  font-size: calc(var(--font-size-base, 14px) * 14 / 14);
}
</style>
