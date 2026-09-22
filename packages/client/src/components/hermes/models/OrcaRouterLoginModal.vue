<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { NModal, NButton, NInput, NSpin, NAlert, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  cancelOrcaRouterLogin,
  pollOrcaRouterLogin,
  startOrcaRouterLogin,
  submitOrcaRouterCode,
  type OrcaRouterCallbackMode,
  type OrcaRouterLoginStatus,
} from '@/api/hermes/orcarouter-auth'
import { copyToClipboard } from '@/utils/clipboard'
import { ORCA_ROUTER_LOGO_URL } from '@/utils/orcaRouterBrand'

const { t } = useI18n()
const emit = defineEmits<{ close: []; success: [] }>()
const message = useMessage()

const showModal = ref(true)
const status = ref<'idle' | 'loading' | OrcaRouterLoginStatus>('idle')
const callbackMode = ref<OrcaRouterCallbackMode>('loopback')
const authorizationUrl = ref('')
const sessionId = ref('')
const pastedCode = ref('')
const submitting = ref(false)
const errorMessage = ref('')
const busy = ref(false)

let pollTimer: ReturnType<typeof setTimeout> | null = null
/**
 * Monotonic attempt counter. Every async response and poll iteration must
 * confirm it still belongs to the current generation before it is allowed to
 * touch credentials or UI state, so a late reply from an abandoned login can
 * never appear under a newer one.
 */
let generation = 0

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

function releaseLock(keepalive = false) {
  const id = sessionId.value
  sessionId.value = ''
  if (id) void cancelOrcaRouterLogin(id, { keepalive })
}

function clearBusyState() {
  busy.value = false
  stopPolling()
}

async function startLogin(mode: OrcaRouterCallbackMode = callbackMode.value) {
  const attempt = ++generation
  callbackMode.value = mode
  clearBusyState()
  releaseLock()
  status.value = 'loading'
  errorMessage.value = ''
  pastedCode.value = ''
  authorizationUrl.value = ''
  busy.value = true
  try {
    const data = await startOrcaRouterLogin(mode)
    if (attempt !== generation) {
      // A newer attempt started while this one was in flight; drop the lock
      // this response created rather than leaving it orphaned.
      void cancelOrcaRouterLogin(data.session_id, { keepalive: true })
      return
    }
    authorizationUrl.value = data.authorization_url
    sessionId.value = data.session_id
    status.value = 'pending'
    window.open(authorizationUrl.value, '_blank')
    if (mode === 'loopback') startPolling(attempt)
  } catch (err: any) {
    if (attempt !== generation) return
    status.value = 'error'
    errorMessage.value = err?.message || String(err)
    clearBusyState()
  }
}

function startPolling(attempt: number) {
  stopPolling()
  pollTimer = setTimeout(async () => {
    if (attempt !== generation) return
    try {
      const result = await pollOrcaRouterLogin(sessionId.value)
      if (attempt !== generation) return
      if (result.status === 'pending') {
        startPolling(attempt)
        return
      }
      status.value = result.status
      clearBusyState()
      if (result.status === 'approved') {
        message.success(t('models.orcaRouterApproved'))
        setTimeout(() => {
          showModal.value = false
          setTimeout(() => emit('success'), 200)
        }, 800)
      } else if (result.status === 'denied') {
        errorMessage.value = result.error || t('models.orcaRouterDenied')
      } else if (result.status === 'expired') {
        errorMessage.value = t('models.orcaRouterExpired')
      } else if (result.status === 'error') {
        errorMessage.value = result.error || t('models.orcaRouterFailed')
      }
    } catch {
      if (attempt !== generation) return
      startPolling(attempt)
    }
  }, 2000)
}

async function submitCode() {
  const attempt = generation
  const code = pastedCode.value.trim()
  if (!code || !sessionId.value) return
  submitting.value = true
  errorMessage.value = ''
  try {
    const result = await submitOrcaRouterCode(sessionId.value, code)
    if (attempt !== generation) return
    status.value = result.status
    if (result.status === 'approved') {
      sessionId.value = ''
      clearBusyState()
      message.success(t('models.orcaRouterApproved'))
      setTimeout(() => {
        showModal.value = false
        setTimeout(() => emit('success'), 200)
      }, 800)
      return
    }
    errorMessage.value = result.error || t('models.orcaRouterFailed')
  } catch (err: any) {
    if (attempt !== generation) return
    status.value = 'error'
    errorMessage.value = err?.message || String(err)
  } finally {
    if (attempt === generation) submitting.value = false
  }
}

async function switchMode(mode: OrcaRouterCallbackMode) {
  if (mode === callbackMode.value) return
  await startLogin(mode)
}

function handleClose() {
  // Invalidate the generation first so an in-flight exchange cannot settle this
  // attempt, then release the server lock.
  generation += 1
  clearBusyState()
  releaseLock()
  showModal.value = false
  setTimeout(() => emit('close'), 200)
}

function openLink() {
  if (authorizationUrl.value) window.open(authorizationUrl.value, '_blank')
}

async function copyLink() {
  const ok = await copyToClipboard(authorizationUrl.value)
  if (ok) message.success(t('common.copied'))
  else message.error(t('chat.copyFailed'))
}

/**
 * The browser may put this page into the back-forward cache. Invalidate the
 * generation, synchronously clear the busy flag and hint, then cancel the
 * server task with `keepalive`. Relying on the guarded `finally` of the
 * invalidated request would leave a restored page permanently busy.
 */
function handlePageHide() {
  generation += 1
  clearBusyState()
  releaseLock(true)
}

onMounted(() => {
  window.addEventListener('pagehide', handlePageHide)
  void startLogin('loopback')
})

onUnmounted(() => {
  window.removeEventListener('pagehide', handlePageHide)
  generation += 1
  stopPolling()
  // A real unmount must not write component state, so only the server lock is
  // released here.
  const id = sessionId.value
  sessionId.value = ''
  if (id) void cancelOrcaRouterLogin(id)
})

defineExpose({ startLogin, handlePageHide, submitCode })
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="t('models.orcaRouterLoginTitle')"
    :style="{ width: 'min(460px, calc(100vw - 32px))' }"
    :mask-closable="!busy"
    @after-leave="emit('close')"
  >
    <div class="orca-login" data-testid="orca-router-login">
      <img
        class="orca-login__logo"
        :src="ORCA_ROUTER_LOGO_URL"
        alt="OrcaRouter"
        width="40"
        height="40"
        data-testid="orca-router-logo"
      >

      <div class="orca-login__modes" data-testid="orca-router-callback-modes">
        <NButton
          size="tiny"
          :type="callbackMode === 'loopback' ? 'primary' : 'default'"
          data-testid="orca-router-mode-loopback"
          @click="switchMode('loopback')"
        >
          {{ t('models.orcaRouterModeLoopback') }}
        </NButton>
        <NButton
          size="tiny"
          :type="callbackMode === 'oob' ? 'primary' : 'default'"
          data-testid="orca-router-mode-oob"
          @click="switchMode('oob')"
        >
          {{ t('models.orcaRouterModeOob') }}
        </NButton>
      </div>

      <div v-if="status === 'idle' || status === 'loading'" class="orca-login__state">
        <NSpin size="small" />
        <p class="orca-login__hint">{{ t('models.orcaRouterPreparing') }}</p>
      </div>

      <div v-else-if="status === 'pending'" class="orca-login__state">
        <p class="orca-login__hint">
          {{ callbackMode === 'oob' ? t('models.orcaRouterOobHint') : t('models.orcaRouterWaiting') }}
        </p>
        <NButton type="primary" block data-testid="orca-router-open-link" @click="openLink">
          {{ t('models.orcaRouterOpenLink') }}
        </NButton>
        <NButton block data-testid="orca-router-copy-link" @click="copyLink">
          {{ t('models.orcaRouterCopyLink') }}
        </NButton>
        <div v-if="callbackMode === 'oob'" class="orca-login__code">
          <NInput
            v-model:value="pastedCode"
            :placeholder="t('models.orcaRouterCodePlaceholder')"
            data-testid="orca-router-code-input"
            @keydown.enter="submitCode"
          />
          <NButton
            type="primary"
            :loading="submitting"
            :disabled="!pastedCode.trim()"
            data-testid="orca-router-submit-code"
            @click="submitCode"
          >
            {{ t('models.orcaRouterSubmitCode') }}
          </NButton>
        </div>
      </div>

      <div v-else-if="status === 'approved'" class="orca-login__state orca-login__state--success">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <p>{{ t('models.orcaRouterApproved') }}</p>
      </div>

      <div v-else class="orca-login__state">
        <NAlert type="error" :show-icon="false" data-testid="orca-router-error">
          {{ errorMessage || (status === 'denied' ? t('models.orcaRouterDenied') : status === 'expired' ? t('models.orcaRouterExpired') : t('models.orcaRouterFailed')) }}
        </NAlert>
        <NButton size="small" data-testid="orca-router-retry" @click="startLogin()">
          {{ t('common.retry') }}
        </NButton>
      </div>
    </div>

    <template #footer>
      <div class="modal-footer">
        <NButton data-testid="orca-router-cancel" @click="handleClose">{{ t('common.cancel') }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.orca-login {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
}

.orca-login__logo {
  width: 40px;
  height: 40px;
  object-fit: contain;
}

.orca-login__modes {
  display: flex;
  gap: 8px;
}

.orca-login__state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  min-height: 120px;
  justify-content: center;
  width: 100%;
}

.orca-login__hint {
  font-size: 14px;
  text-align: center;
  line-height: 1.6;
}

.orca-login__code {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.orca-login__state--success {
  color: #18a058;

  svg {
    stroke: #18a058;
  }
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
}
</style>
