<script setup lang="ts">
import { ref } from 'vue'
import { NModal, NUpload, NButton, useMessage } from 'naive-ui'
import type { UploadFileInfo } from 'naive-ui'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useI18n } from 'vue-i18n'

const emit = defineEmits<{
  close: []
  saved: []
}>()

const { t } = useI18n()
const profilesStore = useProfilesStore()
const message = useMessage()

const showModal = ref(true)
const loading = ref(false)
const fileList = ref<UploadFileInfo[]>([])

const ACCEPT_TYPES = [
  '.tar.gz',
  '.tgz',
  '.gz',
  '.zip',
]

function beforeUpload({ file }: { file: UploadFileInfo }) {
  const name = file.name?.toLowerCase() || ''
  const valid = ACCEPT_TYPES.some(ext => name.endsWith(ext))
  if (!valid) {
    message.warning(t('profiles.importInvalidFile'))
    return false
  }
  return true
}

async function handleSave() {
  if (!fileList.value.length) {
    message.warning(t('profiles.importSelectFile'))
    return
  }

  loading.value = true
  try {
    const file = fileList.value[0].file
    if (!file) {
      message.error(t('profiles.importFailed'))
      return
    }
    const res = await profilesStore.importProfile(file)
    if (res.success) {
      message.success(t('profiles.importSuccess'))
      emit('saved')
    } else if (res.code === 'archive_timeout') {
      message.error(t('profiles.importTimeout'), { duration: 8000 })
    } else {
      message.error(res.error || t('profiles.importFailed'))
    }
  } finally {
    loading.value = false
  }
}

function handleClose() {
  showModal.value = false
  setTimeout(() => emit('close'), 200)
}
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="t('profiles.import')"
    :style="{ width: 'min(420px, calc(100vw - 32px))' }"
    :mask-closable="!loading"
    @after-leave="emit('close')"
  >
    <NUpload
      v-model:file-list="fileList"
      :max="1"
      :accept="ACCEPT_TYPES.join(',')"
      :disabled="loading"
      @before-upload="beforeUpload"
    >
      <NButton>{{ t('profiles.importSelectFile') }}</NButton>
    </NUpload>

    <template #footer>
      <div class="modal-footer">
        <NButton @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="loading" :disabled="!fileList.length" @click="handleSave">
          {{ t('common.confirm') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: calc(8px * var(--spacing-scale, 1));
}
</style>
