<script setup lang="ts">
import { ref } from 'vue'
import { NModal, NButton, NInput, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { startAnthropicLogin, submitAnthropicLogin } from '@/api/hermes/anthropic-auth'
import { copyToClipboard } from '@/utils/clipboard'

const { t } = useI18n()
const emit = defineEmits<{ close: []; success: [] }>()
const message = useMessage()

const showModal = ref(true)
const status = ref<'idle' | 'loading' | 'waiting' | 'submitting' | 'approved' | 'expired' | 'error'>('idle')
const authorizationUrl = ref('')
const sessionId = ref('')
const code = ref('')
const errorMessage = ref('')

async function startLogin() {
  status.value = 'loading'
  errorMessage.value = ''
  try {
    const data = await startAnthropicLogin()
    authorizationUrl.value = data.authorization_url
    sessionId.value = data.session_id
    status.value = 'waiting'
    window.open(authorizationUrl.value, '_blank')
  } catch (err: any) {
    status.value = 'error'
    errorMessage.value = err?.message || String(err)
    message.error(errorMessage.value)
  }
}

async function submitCode() {
  if (!code.value.trim() || !sessionId.value) return
  status.value = 'submitting'
  errorMessage.value = ''
  try {
    const result = await submitAnthropicLogin(sessionId.value, code.value.trim())
    if (result.status === 'approved') {
      status.value = 'approved'
      message.success(t('models.anthropicApproved'))
      setTimeout(() => {
        showModal.value = false
        setTimeout(() => emit('success'), 200)
      }, 1000)
    } else if (result.status === 'expired') {
      status.value = 'expired'
    } else {
      status.value = 'error'
      errorMessage.value = result.error || 'Unknown error'
    }
  } catch (err: any) {
    status.value = 'error'
    errorMessage.value = err?.message || String(err)
    message.error(errorMessage.value)
  }
}

function handleClose() {
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
  authorizationUrl.value = ''
  sessionId.value = ''
  code.value = ''
  errorMessage.value = ''
  startLogin()
}

startLogin()
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="t('models.anthropicLoginTitle')"
    :style="{ width: 'min(460px, calc(100vw - 32px))' }"
    :mask-closable="status !== 'submitting'"
    @after-leave="emit('close')"
  >
    <div class="oauth-login">
      <div v-if="status === 'idle' || status === 'loading'" class="oauth-login__state">
        <NSpin size="small" />
      </div>

      <div v-else-if="status === 'waiting' || status === 'submitting'" class="oauth-login__state">
        <p class="oauth-login__hint">{{ t('models.anthropicWaiting') }}</p>
        <NButton type="primary" block @click="openLink">
          {{ t('models.anthropicOpenLink') }}
        </NButton>
        <NButton block @click="copyLink">
          {{ t('models.anthropicCopyLink') }}
        </NButton>
        <NInput
          v-model:value="code"
          type="textarea"
          :placeholder="t('models.anthropicCodePlaceholder')"
          :autosize="{ minRows: 2, maxRows: 4 }"
        />
        <NButton type="primary" block :loading="status === 'submitting'" :disabled="!code.trim()" @click="submitCode">
          {{ t('models.anthropicSubmitCode') }}
        </NButton>
      </div>

      <div v-else-if="status === 'approved'" class="oauth-login__state oauth-login__state--success">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <p>{{ t('models.anthropicApproved') }}</p>
      </div>

      <div v-else-if="status === 'expired'" class="oauth-login__state">
        <p class="oauth-login__error">{{ t('models.anthropicExpired') }}</p>
        <NButton size="small" @click="retry">{{ t('common.retry') }}</NButton>
      </div>

      <div v-else-if="status === 'error'" class="oauth-login__state">
        <p class="oauth-login__error">{{ errorMessage }}</p>
        <NButton size="small" @click="retry">{{ t('common.retry') }}</NButton>
      </div>
    </div>

    <template #footer>
      <div class="modal-footer">
        <NButton :disabled="status === 'submitting'" @click="handleClose">{{ t('common.cancel') }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.oauth-login {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
}

.oauth-login__state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  min-height: 140px;
  justify-content: center;
  width: 100%;
}

.oauth-login__hint {
  font-size: 14px;
  color: var(--n-text-color, inherit);
  text-align: center;
  line-height: 1.6;
}

.oauth-login__state--success {
  color: #18a058;

  svg {
    stroke: #18a058;
  }
}

.oauth-login__error {
  color: #d03050;
  text-align: center;
  word-break: break-word;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
}
</style>
