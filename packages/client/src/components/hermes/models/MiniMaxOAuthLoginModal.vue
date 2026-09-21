<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { NButton, NModal, NRadioButton, NRadioGroup, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { pollMiniMaxLogin, startMiniMaxLogin } from '@/api/hermes/minimax-auth'
import { copyToClipboard } from '@/utils/clipboard'

const { t } = useI18n()
const emit = defineEmits<{ close: []; success: [] }>()
const message = useMessage()

const showModal = ref(true)
const status = ref<'idle' | 'loading' | 'waiting' | 'approved' | 'expired' | 'error'>('idle')
const region = ref<'global' | 'cn'>('global')
const sessionId = ref('')
const userCode = ref('')
const verificationUrl = ref('')
const errorMessage = ref('')
let pollTimer: ReturnType<typeof setTimeout> | null = null

async function startLogin() {
  status.value = 'loading'
  errorMessage.value = ''
  try {
    const result = await startMiniMaxLogin(region.value)
    sessionId.value = result.session_id
    userCode.value = result.user_code
    verificationUrl.value = result.verification_url
    status.value = 'waiting'
    window.open(verificationUrl.value, '_blank')
    schedulePoll()
  } catch (err: any) {
    status.value = 'error'
    errorMessage.value = err?.message || String(err)
    message.error(errorMessage.value)
  }
}

function schedulePoll() {
  stopPolling()
  pollTimer = setTimeout(async () => {
    try {
      const result = await pollMiniMaxLogin(sessionId.value)
      if (result.status === 'pending') {
        schedulePoll()
      } else if (result.status === 'approved') {
        status.value = 'approved'
        message.success(t('models.minimaxApproved'))
        setTimeout(() => {
          showModal.value = false
          setTimeout(() => emit('success'), 200)
        }, 1_000)
      } else if (result.status === 'expired') {
        status.value = 'expired'
      } else {
        status.value = 'error'
        errorMessage.value = result.error || 'Unknown error'
      }
    } catch {
      schedulePoll()
    }
  }, 2_000)
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

function retry() {
  stopPolling()
  status.value = 'idle'
  sessionId.value = ''
  userCode.value = ''
  verificationUrl.value = ''
  errorMessage.value = ''
}

async function copyCode() {
  const copied = await copyToClipboard(userCode.value)
  if (copied) message.success(t('common.copied'))
  else message.error(t('chat.copyFailed'))
}

function openLink() {
  window.open(verificationUrl.value, '_blank')
}

onUnmounted(stopPolling)
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="t('models.minimaxLoginTitle')"
    :style="{ width: 'min(440px, calc(100vw - 32px))' }"
    :mask-closable="status !== 'waiting' && status !== 'loading'"
    @after-leave="emit('close')"
  >
    <div class="minimax-login">
      <div v-if="status === 'idle'" class="minimax-login__state">
        <p class="minimax-login__hint">{{ t('models.minimaxRegionHint') }}</p>
        <NRadioGroup v-model:value="region">
          <NRadioButton value="global">{{ t('models.minimaxGlobal') }}</NRadioButton>
          <NRadioButton value="cn">{{ t('models.minimaxChina') }}</NRadioButton>
        </NRadioGroup>
        <NButton type="primary" block @click="startLogin">{{ t('models.minimaxStart') }}</NButton>
      </div>

      <div v-else-if="status === 'loading'" class="minimax-login__state">
        <NSpin size="small" />
      </div>

      <div v-else-if="status === 'waiting'" class="minimax-login__state">
        <p class="minimax-login__hint">{{ t('models.minimaxWaiting') }}</p>
        <button type="button" class="minimax-login__code" @click="copyCode">
          <span>{{ userCode }}</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        </button>
        <NButton type="primary" block @click="openLink">{{ t('models.minimaxOpenLink') }}</NButton>
      </div>

      <div v-else-if="status === 'approved'" class="minimax-login__state minimax-login__success">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <p>{{ t('models.minimaxApproved') }}</p>
      </div>

      <div v-else-if="status === 'expired'" class="minimax-login__state">
        <p class="minimax-login__error">{{ t('models.minimaxExpired') }}</p>
        <NButton size="small" @click="retry">{{ t('common.retry') }}</NButton>
      </div>

      <div v-else class="minimax-login__state">
        <p class="minimax-login__error">{{ errorMessage }}</p>
        <NButton size="small" @click="retry">{{ t('common.retry') }}</NButton>
      </div>
    </div>

    <template #footer>
      <div class="modal-footer">
        <NButton :disabled="status === 'waiting' || status === 'loading'" @click="handleClose">
          {{ t('common.cancel') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.minimax-login,
.minimax-login__state {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}

.minimax-login {
  padding: 8px 0;
}

.minimax-login__state {
  min-height: 140px;
  justify-content: center;
  gap: 16px;
}

.minimax-login__hint,
.minimax-login__error {
  margin: 0;
  text-align: center;
  line-height: 1.6;
}

.minimax-login__code {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  border: 1px solid var(--n-border-color, #e0e0e6);
  border-radius: 8px;
  color: inherit;
  background: transparent;
  cursor: pointer;
  font: inherit;
  letter-spacing: 0.12em;
}

.minimax-login__success {
  color: #18a058;
}

.minimax-login__error {
  color: #d03050;
  word-break: break-word;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
}
</style>
