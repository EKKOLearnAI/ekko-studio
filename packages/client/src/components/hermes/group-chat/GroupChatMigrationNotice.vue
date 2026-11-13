<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NAlert, NButton, NModal } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { usePageLoadingState } from '@/composables/usePageLoading'

// Separate from the retired upgrade notice: its acknowledgement does not cover this message.
const STORAGE_KEY = 'hermes.groupChat.botMigrationNotice.v1.acknowledged'
const { t } = useI18n()
const pageLoading = usePageLoadingState()
const restored = ref(false)
const acknowledged = ref(false)
const saveFailed = ref(false)
const show = computed(() => restored.value && !pageLoading.value && !acknowledged.value)

function restoreAcknowledgement() {
  try {
    acknowledged.value = window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    // A transient read failure must not undo an acknowledgement made in this page.
  }
  restored.value = true
}

function acknowledge() {
  try {
    window.localStorage.setItem(STORAGE_KEY, '1')
    acknowledged.value = true
    saveFailed.value = false
  } catch {
    // Keep the notice open so a failed write never looks like a durable acknowledgement.
    saveFailed.value = true
  }
}

function handleStorage(event: StorageEvent) {
  if (event.key === STORAGE_KEY || event.key === null) {
    restoreAcknowledgement()
  }
}

onMounted(() => {
  restoreAcknowledgement()
  window.addEventListener('storage', handleStorage)
  window.addEventListener('focus', restoreAcknowledgement)
})

onUnmounted(() => {
  window.removeEventListener('storage', handleStorage)
  window.removeEventListener('focus', restoreAcknowledgement)
})
</script>

<template>
  <NModal
    :show="show"
    preset="dialog"
    :title="t('groupChat.migrationNoticeTitle')"
    :aria-label="t('groupChat.migrationNoticeTitle')"
    :mask-closable="false"
    :close-on-esc="false"
    :closable="false"
    style="width: 480px; max-width: calc(100vw - 32px)"
  >
    <p class="group-chat-migration-notice">{{ t('groupChat.migrationNoticeMessage') }}</p>
    <NAlert v-if="saveFailed" type="error" class="save-error" role="alert">
      {{ t('groupChat.migrationNoticeSaveFailed') }}
    </NAlert>
    <template #action>
      <NButton type="primary" @click="acknowledge">{{ t('announcements.gotIt') }}</NButton>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.group-chat-migration-notice {
  margin: 0;
  line-height: var(--line-height, 1.7);
  overflow-wrap: anywhere;
}
.save-error {
  margin-top: calc(12px * var(--spacing-scale, 1));
}
</style>
