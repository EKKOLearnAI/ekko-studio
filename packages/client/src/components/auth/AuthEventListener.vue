<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'

const message = useMessage()
const { t } = useI18n()

let lastNoticeAt = 0

function onAuthNotice(event: Event) {
  const detail = (event as CustomEvent<{ kind?: string }>).detail || {}
  const now = Date.now()
  if (now - lastNoticeAt < 1200) return
  lastNoticeAt = now

  if (detail.kind === 'forbidden') {
    message.error(t('login.accessDenied'))
    return
  }
  message.error(t('login.sessionExpired'))
}

onMounted(() => {
  window.addEventListener('hermes-auth-notice', onAuthNotice)
})

onUnmounted(() => {
  window.removeEventListener('hermes-auth-notice', onAuthNotice)
})
</script>

<template>
  <span style="display: none" aria-hidden="true" />
</template>
