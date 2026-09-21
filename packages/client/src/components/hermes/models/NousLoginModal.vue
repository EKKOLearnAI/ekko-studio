<script setup lang="ts">
import { ref, onUnmounted } from 'vue'
import { NModal, NButton, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { startNousLogin, pollNousLogin } from '@/api/hermes/nous-auth'
import { copyToClipboard } from '@/utils/clipboard'

const { t } = useI18n()
const emit = defineEmits<{ close: []; success: [] }>()
const message = useMessage()

const showModal = ref(true)
const status = ref<'idle' | 'loading' | 'waiting' | 'approved' | 'expired' | 'error'>('idle')
const userCode = ref('')
const verificationUrl = ref('')
const sessionId = ref('')
const errorMessage = ref('')
let pollTimer: ReturnType<typeof setTimeout> | null = null

async function startLogin() {
  status.value = 'loading'
  errorMessage.value = ''

  try {
    const data = await startNousLogin()
    userCode.value = data.user_code
    verificationUrl.value = data.verification_url
    sessionId.value = data.session_id
    status.value = 'waiting'
    startPolling()
  } catch (err: any) {
    status.value = 'error'
    const msg = err.message || ''
    try {
      const match = msg.match(/\{[\s\S]*\}$/)
      if (match) {
        const body = JSON.parse(match[0])
        errorMessage.value = body.error || msg
      } else {
        errorMessage.value = msg
      }
    } catch {
      errorMessage.value = msg
    }
    message.error(errorMessage.value)
  }
}

function startPolling() {
  stopPolling()
  pollTimer = setTimeout(async () => {
    try {
      const result = await pollNousLogin(sessionId.value)
      if (result.status === 'pending') {
        startPolling()
      } else if (result.status === 'approved') {
        status.value = 'approved'
        message.success(t('models.nousApproved'))
        setTimeout(() => {
          showModal.value = false
          setTimeout(() => emit('success'), 200)
        }, 1000)
      } else if (result.status === 'expired') {
        status.value = 'expired'
      } else if (result.status === 'denied') {
        status.value = 'error'
        errorMessage.value = t('models.nousDenied')
      } else if (result.status === 'error') {
        status.value = 'error'
        errorMessage.value = result.error || 'Unknown error'
      }
    } catch {
      startPolling()
    }
  }, 3000)
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

function handleClose() {
  stopPolling()
  showModal.value = false
  setTimeout(() => emit('close'), 200)
}

async function copyCode() {
  const ok = await copyToClipboard(userCode.value)
  if (ok) message.success(t('models.nousCopyCode'))
  else message.error(t('models.nousCopyCode') + ' ✗')
}

function openLink() {
  window.open(verificationUrl.value, '_blank')
}

function retry() {
  status.value = 'idle'
  userCode.value = ''
  verificationUrl.value = ''
  sessionId.value = ''
  errorMessage.value = ''
  startLogin()
}

onUnmounted(() => {
  stopPolling()
})

// Auto-start when modal opens
startLogin()
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="t('models.nousLoginTitle')"
    :style="{ width: 'min(440px, calc(100vw - 32px))' }"
    :mask-closable="status !== 'waiting'"
    @after-leave="emit('close')"
  >
    <div class="nous-login">
      <!-- Idle / Loading -->
      <div v-if="status === 'idle' || status === 'loading'" class="nous-login__state">
        <NSpin size="small" />
      </div>

      <!-- Waiting for authorization -->
      <div v-else-if="status === 'waiting'" class="nous-login__state">
        <p class="nous-login__hint">{{ t('models.nousWaiting') }}</p>
        <div class="nous-login__code" @click="copyCode">
          <span class="nous-login__code-text">{{ userCode }}</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        </div>
        <NButton type="primary" block @click="openLink">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </template>
          {{ t('models.nousOpenLink') }}
        </NButton>
      </div>

      <!-- Approved -->
      <div v-else-if="status === 'approved'" class="nous-login__state nous-login__state--success">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <p>{{ t('models.nousApproved') }}</p>
      </div>

      <!-- Expired -->
      <div v-else-if="status === 'expired'" class="nous-login__state">
        <p class="nous-login__error">{{ t('models.nousExpired') }}</p>
        <NButton size="small" @click="retry">{{ t('common.retry') }}</NButton>
      </div>

      <!-- Error -->
      <div v-else-if="status === 'error'" class="nous-login__state">
        <p class="nous-login__error">{{ errorMessage }}</p>
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
.nous-login {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
}

.nous-login__state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  min-height: 120px;
  justify-content: center;
  width: 100%;
}

.nous-login__hint {
  font-size: 14px;
  color: var(--n-text-color, inherit);
  text-align: center;
  line-height: 1.6;
}

.nous-login__code {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  border: 1px solid var(--n-border-color, #e0e0e6);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.2s;
  background: var(--n-color, #fafafa);

  &:hover {
    border-color: var(--n-primary-color, #18a058);
  }
}

.nous-login__code-text {
  font-size: 28px;
  font-weight: 700;
  font-family: monospace;
  letter-spacing: 4px;
  color: var(--n-text-color, inherit);
}

.nous-login__state--success {
  color: #18a058;

  svg {
    stroke: #18a058;
  }
}

.nous-login__error {
  color: #d03050;
  text-align: center;
  font-size: 13px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
