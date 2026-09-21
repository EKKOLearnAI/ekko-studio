<script setup lang="ts">
import { ref, onUnmounted } from 'vue'
import { NModal, NButton, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { startXaiLogin, pollXaiLogin } from '@/api/hermes/xai-auth'
import { copyToClipboard } from '@/utils/clipboard'

const { t } = useI18n()
const emit = defineEmits<{ close: []; success: [] }>()
const message = useMessage()

const showModal = ref(true)
const status = ref<'idle' | 'loading' | 'waiting' | 'approved' | 'expired' | 'error'>('idle')
const authorizationUrl = ref('')
const sessionId = ref('')
const errorMessage = ref('')
let pollTimer: ReturnType<typeof setTimeout> | null = null

async function startLogin() {
  status.value = 'loading'
  errorMessage.value = ''
  try {
    const data = await startXaiLogin()
    authorizationUrl.value = data.authorization_url
    sessionId.value = data.session_id
    status.value = 'waiting'
    window.open(authorizationUrl.value, '_blank')
    startPolling()
  } catch (err: any) {
    status.value = 'error'
    errorMessage.value = err?.message || String(err)
    message.error(errorMessage.value)
  }
}

function startPolling() {
  stopPolling()
  pollTimer = setTimeout(async () => {
    try {
      const result = await pollXaiLogin(sessionId.value)
      if (result.status === 'pending') {
        startPolling()
      } else if (result.status === 'approved') {
        status.value = 'approved'
        message.success(t('models.xaiApproved'))
        setTimeout(() => {
          showModal.value = false
          setTimeout(() => emit('success'), 200)
        }, 1000)
      } else if (result.status === 'expired') {
        status.value = 'expired'
      } else if (result.status === 'error') {
        status.value = 'error'
        errorMessage.value = result.error || 'Unknown error'
      }
    } catch {
      startPolling()
    }
  }, 2000)
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

function handleClose() {
  stopPolling()
  showModal.value = false
  setTimeout(() => emit('close'), 200)
}

function openLink() {
  window.open(authorizationUrl.value, '_blank')
}

async function copyLink() {
  const ok = await copyToClipboard(authorizationUrl.value)
  if (ok) message.success(t('common.copied'))
  else message.error(t('chat.copyFailed'))
}

function retry() {
  status.value = 'idle'
  authorizationUrl.value = ''
  sessionId.value = ''
  errorMessage.value = ''
  startLogin()
}

onUnmounted(stopPolling)
startLogin()
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="t('models.xaiLoginTitle')"
    :style="{ width: 'min(440px, calc(100vw - 32px))' }"
    :mask-closable="status !== 'waiting'"
    @after-leave="emit('close')"
  >
    <div class="xai-login">
      <div v-if="status === 'idle' || status === 'loading'" class="xai-login__state">
        <NSpin size="small" />
      </div>

      <div v-else-if="status === 'waiting'" class="xai-login__state">
        <p class="xai-login__hint">{{ t('models.xaiWaiting') }}</p>
        <NButton type="primary" block @click="openLink">
          {{ t('models.xaiOpenLink') }}
        </NButton>
        <NButton block @click="copyLink">
          {{ t('models.xaiCopyLink') }}
        </NButton>
      </div>

      <div v-else-if="status === 'approved'" class="xai-login__state xai-login__state--success">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <p>{{ t('models.xaiApproved') }}</p>
      </div>

      <div v-else-if="status === 'expired'" class="xai-login__state">
        <p class="xai-login__error">{{ t('models.xaiExpired') }}</p>
        <NButton size="small" @click="retry">{{ t('common.retry') }}</NButton>
      </div>

      <div v-else-if="status === 'error'" class="xai-login__state">
        <p class="xai-login__error">{{ errorMessage }}</p>
        <NButton size="small" @click="retry">{{ t('common.retry') }}</NButton>
      </div>
    </div>

    <template #footer>
      <div class="modal-footer">
        <NButton :disabled="status === 'waiting'" @click="handleClose">{{ t('common.cancel') }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.xai-login {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
}

.xai-login__state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  min-height: 120px;
  justify-content: center;
  width: 100%;
}

.xai-login__hint {
  font-size: 14px;
  color: var(--n-text-color, inherit);
  text-align: center;
  line-height: 1.6;
}

.xai-login__state--success {
  color: #18a058;

  svg {
    stroke: #18a058;
  }
}

.xai-login__error {
  color: #d03050;
  text-align: center;
  word-break: break-word;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
}
</style>
