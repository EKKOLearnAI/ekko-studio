<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  decideCronConsent,
  listCronConsents,
  prepareCronConsentContext,
  type CronConsentContext,
  type CronConsentRequest,
} from '@/api/hermes/cron-consent'
import { onCronConsentUpdated } from '@/api/studio/chat'
import { copyToClipboard } from '@/utils/clipboard'

const props = defineProps<{ sessionId: string; profile: string }>()
const { t } = useI18n()

const requests = ref<CronConsentRequest[]>([])
const setup = ref<CronConsentContext | null>(null)
const busy = ref<Record<string, 'approve' | 'deny'>>({})
const outcome = ref<Record<string, { ok: boolean; text: string }>>({})
const setupError = ref('')
const copied = ref(false)
const now = ref(Date.now())
let sequence = 0
let setupSequence = 0
let ticker: ReturnType<typeof setInterval> | undefined
let unsubscribe: (() => void) | undefined

const visible = computed(() => requests.value.filter(item => item.expires_at > now.value))
const setupLive = computed(() => setup.value && setup.value.session_id === props.sessionId && setup.value.profile === props.profile
  && setup.value.expires_at > now.value ? setup.value : null)
const shown = computed(() => visible.value.length > 0 || !!setupLive.value || Object.keys(outcome.value).length > 0)

function errorCode(error: unknown): string {
  return String((error as { code?: string })?.code || (error as Error)?.message || 'error')
}

async function refresh() {
  const current = ++sequence
  const { sessionId, profile } = props
  try {
    const items = await listCronConsents(profile, sessionId)
    // A response for a session or profile the user has since left is discarded.
    if (current === sequence && sessionId === props.sessionId && profile === props.profile) requests.value = items
  } catch {
    if (current === sequence) requests.value = []
  }
}

async function decide(item: CronConsentRequest, decision: 'approve' | 'deny') {
  if (busy.value[item.id]) return
  busy.value = { ...busy.value, [item.id]: decision }
  let result: { ok: boolean; text: string }
  try {
    await decideCronConsent(item.profile, item.id, decision)
    result = { ok: true, text: decision === 'approve' ? t('chat.cronConsent.approved', { name: item.name }) : t('chat.cronConsent.denied', { name: item.name }) }
  } catch (error) {
    result = { ok: false, text: t('chat.cronConsent.failed', { name: item.name, code: errorCode(error) }) }
  }
  const { [item.id]: _done, ...rest } = busy.value
  busy.value = rest
  // The outcome belongs to the request's own session: never show it after the user switched away.
  if (item.session_id !== props.sessionId || item.profile !== props.profile) return
  outcome.value = { ...outcome.value, [item.id]: result }
  await refresh()
}

/** Opens a model-free setup context for this session; an MCP client proposes with its context_id. */
async function prepare() {
  setupError.value = ''
  copied.value = false
  // The server replaces the earlier setup context; never keep showing a superseded id.
  setup.value = null
  const current = ++setupSequence
  const { sessionId, profile } = props
  // Only the latest preparation for the selection it was made in may set the context or an error.
  const latest = () => current === setupSequence && sessionId === props.sessionId && profile === props.profile
  try {
    const context = await prepareCronConsentContext(profile, sessionId)
    if (latest()) setup.value = context
  } catch (error) {
    if (latest()) setupError.value = t('chat.cronConsent.setupFailed', { code: errorCode(error) })
  }
}

async function copyContext() {
  if (setupLive.value) copied.value = await copyToClipboard(setupLive.value.context_id)
}

function dismissOutcome(id: string) {
  const { [id]: _done, ...rest } = outcome.value
  outcome.value = rest
}

const actionLabel = (item: CronConsentRequest) => t(`chat.cronConsent.action.${item.action}`)
const formatTime = (value: number) => new Date(value).toLocaleTimeString()

watch(() => [props.sessionId, props.profile], () => {
  requests.value = []
  outcome.value = {}
  setupError.value = ''
  // A setup context belongs to the selection it was prepared for.
  setupSequence++
  setup.value = null
  copied.value = false
  void refresh()
})

onMounted(() => {
  void refresh()
  unsubscribe = onCronConsentUpdated(sessionId => { if (sessionId === props.sessionId) void refresh() })
  ticker = setInterval(() => { now.value = Date.now() }, 15_000)
})

onBeforeUnmount(() => {
  unsubscribe?.()
  if (ticker) clearInterval(ticker)
})

defineExpose({ prepare, refresh })
</script>

<template>
  <section v-if="shown" class="cron-consent" data-theme-surface="card" data-testid="cron-consent-card" :aria-label="t('chat.cronConsent.title')">
    <header class="cron-consent__header">{{ t('chat.cronConsent.title') }}</header>

    <article v-for="item in visible" :key="item.id" class="cron-consent__request" data-testid="cron-consent-request">
      <div class="cron-consent__action">{{ actionLabel(item) }}</div>
      <dl class="cron-consent__fields">
        <dt>{{ t('chat.cronConsent.target') }}</dt>
        <dd>{{ item.session_title || item.session_id }} · {{ item.profile }}</dd>
        <dt>{{ t('chat.cronConsent.job') }}</dt>
        <dd>{{ item.name }}<template v-if="item.job_id"> ({{ item.job_id }})</template></dd>
        <dt>{{ t('chat.cronConsent.schedule') }}</dt>
        <dd>{{ item.schedule }}</dd>
        <template v-if="item.script">
          <dt>{{ t('chat.cronConsent.script') }}</dt>
          <dd><code>{{ item.script }}</code> ({{ item.script_kind }})</dd>
          <dt>{{ t('chat.cronConsent.digest') }}</dt>
          <dd><code :title="item.script_sha256">{{ item.script_sha256?.slice(0, 16) }}…</code></dd>
        </template>
        <template v-if="item.workdir">
          <dt>{{ t('chat.cronConsent.workdir') }}</dt>
          <dd><code>{{ item.workdir }}</code></dd>
        </template>
        <template v-if="item.interpreter">
          <dt>{{ t('chat.cronConsent.interpreter') }}</dt>
          <dd><code>{{ item.interpreter }}</code></dd>
        </template>
        <template v-if="item.prompt !== undefined">
          <dt>{{ t('chat.cronConsent.prompt') }}</dt>
          <dd><pre class="cron-consent__prompt">{{ item.prompt }}{{ item.prompt_truncated ? '…' : '' }}</pre></dd>
        </template>
        <template v-if="item.resume !== undefined">
          <dt>{{ t('chat.cronConsent.afterApproval') }}</dt>
          <dd>{{ item.resume ? t('chat.cronConsent.resumes') : t('chat.cronConsent.staysPaused') }}</dd>
        </template>
        <template v-if="item.prior_binding">
          <dt>{{ t('chat.cronConsent.currentBinding') }}</dt>
          <dd>{{ t('chat.cronConsent.movesFrom', { session: item.prior_binding.session_title || item.prior_binding.session_id }) }}</dd>
        </template>
        <dt>{{ t('chat.cronConsent.requestedVia') }}</dt>
        <dd>{{ item.requested_via === 'login' ? t('chat.cronConsent.viaLogin') : t('chat.cronConsent.viaRuntime') }}</dd>
        <dt>{{ t('chat.cronConsent.expires') }}</dt>
        <dd>{{ formatTime(item.expires_at) }}</dd>
      </dl>
      <div class="cron-consent__buttons">
        <NButton size="small" :disabled="!!busy[item.id]" :loading="busy[item.id] === 'deny'" data-testid="cron-consent-deny" @click="decide(item, 'deny')">
          {{ t('chat.cronConsent.deny') }}
        </NButton>
        <NButton size="small" type="primary" :disabled="!!busy[item.id]" :loading="busy[item.id] === 'approve'" data-testid="cron-consent-approve" @click="decide(item, 'approve')">
          {{ t('chat.cronConsent.approve') }}
        </NButton>
      </div>
    </article>

    <div v-for="(result, id) in outcome" :key="id" class="cron-consent__outcome" :class="{ 'cron-consent__outcome--error': !result.ok }" role="status" data-testid="cron-consent-outcome">
      <span>{{ result.text }}</span>
      <NButton size="tiny" quaternary @click="dismissOutcome(String(id))">{{ t('chat.cronConsent.dismiss') }}</NButton>
    </div>

    <div v-if="setupLive" class="cron-consent__setup" data-testid="cron-consent-setup">
      <div class="cron-consent__action">{{ t('chat.cronConsent.setupTitle') }}</div>
      <p class="cron-consent__hint">{{ t('chat.cronConsent.setupHint') }}</p>
      <div class="cron-consent__context">
        <code data-testid="cron-consent-context">{{ setupLive.context_id }}</code>
        <NButton size="tiny" @click="copyContext">{{ copied ? t('chat.cronConsent.copied') : t('chat.cronConsent.copy') }}</NButton>
      </div>
      <p class="cron-consent__hint">{{ t('chat.cronConsent.expires') }}: {{ formatTime(setupLive.expires_at) }}</p>
    </div>
  </section>
  <p v-if="setupError" class="cron-consent__error" role="alert">{{ setupError }}</p>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.cron-consent {
  margin: 8px 16px;
  padding: 10px 12px;
  background: $bg-card;
  color: $text-primary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  max-height: 45vh;
  overflow-y: auto;
}

.cron-consent__header {
  font-weight: 600;
  margin-bottom: 6px;
}

.cron-consent__request + .cron-consent__request,
.cron-consent__setup {
  margin-top: 10px;
  padding-top: 10px;
  border-top: var(--border-width, 1px) solid $border-light;
}

.cron-consent__action {
  font-weight: 500;
  margin-bottom: 4px;
}

.cron-consent__fields {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 2px 10px;
  margin: 0;
  font-size: 13px;

  dt {
    color: $text-secondary;
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
}

.cron-consent__prompt {
  margin: 0;
  white-space: pre-wrap;
  font-family: inherit;
  max-height: 8em;
  overflow-y: auto;
}

.cron-consent__buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.cron-consent__outcome {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  font-size: 13px;
}

.cron-consent__outcome--error,
.cron-consent__error {
  color: $error;
}

.cron-consent__error {
  margin: 4px 16px;
  font-size: 13px;
}

.cron-consent__hint {
  margin: 4px 0;
  font-size: 12px;
  color: $text-muted;
}

.cron-consent__context {
  display: flex;
  align-items: center;
  gap: 8px;

  code {
    overflow-wrap: anywhere;
  }
}

@media (max-width: 640px) {
  .cron-consent {
    margin: 6px 8px;
  }

  .cron-consent__fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
